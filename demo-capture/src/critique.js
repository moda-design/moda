// Send the FINISHED video to Gemini and get director's notes back.
//
// This exists because of a hole nothing else in the pipeline covers: every other
// check reads numbers or samples frames, and neither can tell you the video is
// bad. A caption can sit at the right timestamp with the right text and still be
// unreadable; a camera can hit every mark and still drift; a voiceover can be
// perfectly aligned and still sound wrong. Frame-sampling cannot see motion at
// all. Native video understanding can.
//
// Advisory, never a gate. It informs the next run; it does not block this one.
const { existsSync } = require('node:fs');

const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

//: What the improve loop knows how to act on. Anything else is surfaced to the
//: human but not auto-applied — a vocabulary the model can only pick FROM keeps
//: its advice actionable instead of aspirational.
const FIXES = [
  'speed_up',            // raise SPEED / lower MIN_GAP_SEC in compress.js
  'slow_down',           // lower SPEED, or raise BREATHING_SEC
  'disable_zoom',        // publish with --no-zoom
  'shorten_narration',   // rewrite the line; `fit` already reports overruns
  'fix_caption_overlap', // caption placement flips top/bottom per click half
  're_record',           // a step is wrong or blank — manual
  'none',
];

function buildPrompt(goal) {
  return (
    `You are a senior product-demo video editor reviewing an automated ` +
    `screen-recording demo of: "${goal || 'a web app feature'}".\n\n` +
    // Describing what is ACTUALLY there. An earlier version of this prompt
    // mentioned an intro/outro card, which this pipeline does not produce — and
    // a model told to expect one reports its absence as a defect.
    `The video is a screen recording with on-screen step captions on a dark ` +
    `plate, a synthesized voiceover, and camera punch-ins on some clicks. There ` +
    `is no intro or outro card and no music; do not report their absence.\n\n` +
    `Watch the whole video and give concise, actionable director's notes. Focus ` +
    `on what only watching reveals:\n` +
    `- pacing: dead air, or steps that go by too fast to follow\n` +
    `- does the voiceover match what is on screen at that moment\n` +
    `- jarring, drifting or pointless camera movement\n` +
    `- captions that are unreadable, cover the thing being demonstrated, or ` +
    `overlap each other\n` +
    `- visual glitches: blank or half-rendered screens, nothing happening, the ` +
    `wrong thing on screen\n\n` +
    `Return ONLY JSON of this shape:\n` +
    `{"score": <1-10>, "summary": "<one or two sentences>", "issues": [` +
    `{"type": "<pacing_too_slow|pacing_too_fast|dead_air|narration_mismatch|` +
    `zoom_jarring|caption_overlap|caption_unreadable|visual_glitch|blank_screen|other>",` +
    `"severity": "<low|medium|high>", "atSeconds": <number>, ` +
    `"description": "<what is wrong>", "fix": "<${FIXES.join('|')}>"}]}\n` +
    `If it is clean, return a high score and an empty issues array. Be honest, ` +
    `and do not invent problems.`
  );
}

/** Director's notes for a finished cut, or null when unavailable. */
async function critiqueVideo({ videoPath, goal }) {
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!apiKey) return { skipped: 'no GEMINI_API_KEY / GOOGLE_API_KEY' };
  if (!videoPath || !existsSync(videoPath)) return { skipped: `no file at ${videoPath}` };

  let GoogleGenAI;
  try {
    ({ GoogleGenAI } = require('@google/genai'));
  } catch {
    return { skipped: 'npm install @google/genai' };
  }

  const ai = new GoogleGenAI({ apiKey });
  let file = await ai.files.upload({ file: videoPath, config: { mimeType: 'video/mp4' } });
  // The Files API transcodes before the model can watch it.
  for (let i = 0; i < 60 && file.state === 'PROCESSING'; i++) {
    await sleep(2000);
    file = await ai.files.get({ name: file.name });
  }
  if (file.state !== 'ACTIVE') return { skipped: `file state ${file.state}` };

  const resp = await ai.models.generateContent({
    model: MODEL,
    contents: [{ role: 'user', parts: [
      { fileData: { fileUri: file.uri, mimeType: 'video/mp4' } },
      { text: buildPrompt(goal) },
    ] }],
    config: { responseMimeType: 'application/json' },
  });

  const text = typeof resp.text === 'string' ? resp.text : resp.text?.() ?? '';
  ai.files.delete({ name: file.name }).catch(() => {});
  const json = JSON.parse(text);
  const issues = Array.isArray(json.issues) ? json.issues : [];
  return {
    score: typeof json.score === 'number' ? json.score : null,
    summary: json.summary || '',
    issues: issues.map((x) => ({
      type: x.type || 'other',
      severity: x.severity || 'low',
      atSeconds: typeof x.atSeconds === 'number' ? x.atSeconds : null,
      description: x.description || '',
      // Clamped to the vocabulary so a hallucinated knob cannot reach the loop.
      fix: FIXES.includes(x.fix) ? x.fix : 'none',
    })),
  };
}


// --- The frame-sheet path, for when there is no Gemini key --------------------
//
// Gemini reads the video natively and is the better instrument; this is what runs
// without a key, which is the normal case here. It samples the finished mp4 into
// one contact sheet and asks the authenticated `claude` CLI about it.
//
// The prompt is DIFFERENT from the Gemini one on purpose. Frames cannot show
// motion, so asking about "drifting camera movement" invites invention. What a
// sheet CAN answer is whether the demo makes sense — and that is exactly what
// went wrong repeatedly: a gradient demo where the gradient never changed, and a
// markdown demo whose document was two documents merged. Both are obvious in a
// sheet and both were missed by a human checking that things were *visible*
// rather than that they *changed*.
const { execFileSync } = require('node:child_process');
const { ffmpeg: FFMPEG, ffprobe: FFPROBE } = require('./bin.js');
const path = require('node:path');

//: Frames in the sheet. Enough to see progression, few enough to stay legible.
const SHEET_TILES = 12;

function buildSheet(videoPath, outDir) {
  const dur = +execFileSync(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration',
    '-of', 'default=nw=1:nk=1', videoPath], { encoding: 'utf8' }).trim();
  const sheet = path.join(outDir, 'critique-sheet.png');
  const step = Math.max(0.2, dur / (SHEET_TILES + 1));
  // `fps` rather than hand-picked timestamps, so the sample is even and nothing
  // is cherry-picked into looking better than the video is.
  //
  // NO `drawtext` stamping the timestamp onto each tile: this ffmpeg is built
  // without libfreetype, so the filter does not exist and the whole command
  // fails. (Found once already this session, on the outro card, and forgotten.)
  // The interval goes in the prompt instead, which is enough for the model to
  // name a time.
  execFileSync(FFMPEG, ['-v', 'error', '-i', videoPath, '-vf',
    `fps=1/${step.toFixed(3)},scale=440:-1`,
    '-frames:v', String(SHEET_TILES), '-y', path.join(outDir, 'cf-%02d.png')],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  execFileSync(FFMPEG, ['-v', 'error', '-pattern_type', 'glob', '-i', path.join(outDir, 'cf-*.png'),
    '-filter_complex', 'tile=4x3:margin=4:padding=4:color=gray', '-frames:v', '1', '-update', '1',
    '-y', sheet], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return { sheet, durationSec: dur, stepSec: step };
}

function sheetPrompt(goal, durationSec, sheet, stepSec) {
  return [
    `Read the image at ${sheet}.`,
    '',
    `It is ${SHEET_TILES} frames sampled evenly from a ${durationSec.toFixed(1)}s automated screen-recording`,
    `demo of: "${goal || 'a web app feature'}". Frames run in time order, left to right then top to bottom,`,
    `about ${stepSec.toFixed(1)}s apart — so tile N is at roughly N x ${stepSec.toFixed(1)} seconds.`,
    '',
    'You are a senior product-demo editor. Judge whether this demo MAKES SENSE, which is a different',
    'question from whether things are present. Specifically:',
    '',
    '- DOES THE STATE PROGRESS? Compare the frames against each other. If the thing the demo is about',
    '  looks the same at the start and the end, the demo shows nothing happening, however busy it is.',
    '  This is the single most important check and the one most often missed.',
    '- Is the RESULT of each action visible, or cropped out of frame by a zoom?',
    '- Does the content look coherent, or half-finished, duplicated, or merged with leftover placeholder',
    '  content from before the demo started?',
    '- Are captions readable, and do they cover the thing being demonstrated?',
    '- Anything visibly broken: blank panes, error badges, broken-image icons, dev overlays.',
    '',
    'You cannot judge motion, audio or pacing from stills — do NOT comment on those, and do not report',
    'the absence of anything you cannot see.',
    '',
    'Return ONLY JSON:',
    '{"score": <1-10>, "summary": "<one or two sentences>", "issues": [{"type":',
    '"<no_visible_change|result_cropped|incoherent_content|caption_unreadable|caption_overlap|visual_glitch|blank_screen|other>",',
    `"severity": "<low|medium|high>", "atSeconds": <number>, "description": "<what is wrong>", "fix": "<${FIXES.join('|')}>"}]}`,
    'If it is genuinely clean, return a high score and an empty issues array. Do not invent problems.',
  ].join('\n');
}

/** Critique from a contact sheet using the `claude` CLI. Never throws. */
async function critiqueFrames({ videoPath, goal, outDir }) {
  if (!existsSync(videoPath)) return { ok: false, reason: `no video at ${videoPath}` };
  try {
    const { sheet, durationSec, stepSec } = buildSheet(videoPath, outDir);
    const raw = execFileSync(
      'claude',
      ['-p', sheetPrompt(goal, durationSec, sheet, stepSec), '--output-format', 'json',
       '--allowed-tools', 'Read', '--strict-mcp-config'],
      { encoding: 'utf8', maxBuffer: 16 << 20, stdio: ['ignore', 'pipe', 'ignore'] }
    );
    const text = JSON.parse(raw).result ?? '';
    const a = text.indexOf('{');
    const b = text.lastIndexOf('}');
    if (a < 0 || b <= a) return { ok: false, reason: 'reply was not JSON', sheet };
    const out = JSON.parse(text.slice(a, b + 1));
    return { ok: true, via: 'frames', sheet, ...out };
  } catch (e) {
    return { ok: false, reason: String(e.message).split('\n')[0].slice(0, 140) };
  }
}

module.exports = { critiqueVideo, critiqueFrames, FIXES };
