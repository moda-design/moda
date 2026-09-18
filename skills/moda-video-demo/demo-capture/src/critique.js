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
//
// `contradiction` is reported alongside the score rather than inside `issues`
// because it is a different KIND of claim — the film asserting something the
// screen denies (ENG-6375), not a craft defect — and because the issues list is
// clamped to a per-genre vocabulary it does not belong to. `run.mjs` turns it
// into a flow finding, so it steers the next walk and still blocks nothing.
// Measured before being trusted: 6 fires in 7 runs against the film it was
// written for, and only 3 of those named the actual defect.
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
  'shorten_narration',   // DROP the line holding a wait at 1x; `fit` reports overruns
  'fix_caption_overlap', // caption placement flips top/bottom per click half
  're_record',           // a step is wrong or blank — manual
  'none',
];

//: Issue types and fixes a given genre can actually own.
//:
//: The bullets were made genre-aware but the VOCABULARY was not: a marketing
//: prompt still offered `narration_mismatch`, `caption_overlap` and
//: `caption_unreadable` as types, and `shorten_narration` / `fix_caption_overlap`
//: as fixes. The "do not report the absence of captions" sentence closes the
//: main vector, but if the model reaches for one anyway the finding arrives
//: with a remedy the cut cannot apply — `fix_caption_overlap` is not in
//: run.mjs's cheap-lane exclusion list, so a medium one becomes a flow finding
//: and a re-walk, and `shorten_narration` routes to a narration stage whose
//: `planned` is empty. Take the tokens away rather than hoping they go unused.
const CAPTION_VOICE_TYPES = ['narration_mismatch', 'caption_overlap', 'caption_unreadable'];
//: ONE list per prompt, used for BOTH the enum the model is offered and the
//: filter its reply is checked against. Two copies would drift, and the drift
//: would be silent: the prompt would stop offering a token the filter still
//: accepted.
const VIDEO_TYPES = ['pacing_too_slow', 'pacing_too_fast', 'dead_air', 'narration_mismatch',
  'zoom_jarring', 'caption_overlap', 'caption_unreadable', 'visual_glitch', 'blank_screen', 'other'];
const FRAME_TYPES = ['no_visible_change', 'result_cropped', 'incoherent_content', 'caption_unreadable',
  'caption_overlap', 'visual_glitch', 'blank_screen', 'other'];
const CAPTION_VOICE_FIXES = ['shorten_narration', 'fix_caption_overlap'];

function typesFor(all, genre, hasVoiceover = true) {
  const drop = new Set();
  if (genre === 'marketing') for (const t of CAPTION_VOICE_TYPES) drop.add(t);
  // Narration vocabulary follows the VOICEOVER, not the genre: a tutorial take
  // whose lines were all dropped has no narration to mismatch either.
  if (genre === 'marketing' || !hasVoiceover) drop.add('narration_mismatch');
  return all.filter((t) => !drop.has(t));
}
function fixesFor(genre, hasVoiceover = true) {
  const drop = new Set();
  if (genre === 'marketing') for (const f of CAPTION_VOICE_FIXES) drop.add(f);
  if (genre === 'marketing' || !hasVoiceover) drop.add('shorten_narration');
  return FIXES.filter((f) => !drop.has(f));
}

//: An issue the take can actually own, or null.
//:
//: Clamping `fix` alone was half the job: the prompt stops offering
//: `caption_unreadable` / `narration_mismatch`, but nothing rejected one that
//: came back anyway. A medium finding with an excluded TYPE still reaches
//: critique.json, still clears run.mjs's cheap-lane filter, and still buys a
//: re-walk — the same harm, arriving through the other field.
//:
//: DROPPED, not remapped. Coercing the type to `other` would keep it
//: actionable and merely disguise where it came from.
function admissibleIssue(x, allowedTypes, genre, hasVoiceover) {
  const type = x.type || 'other';
  if (!allowedTypes.includes(type)) return null;
  return {
    ...x,
    type,
    severity: x.severity || 'low',
    atSeconds: typeof x.atSeconds === 'number' ? x.atSeconds : null,
    description: x.description || '',
    fix: fixesFor(genre, hasVoiceover).includes(x.fix) ? x.fix : 'none',
  };
}

/**
 * The truth question, asked identically of both graders.
 *
 * ONE string because the two prompts are a two-sided seam and this file has
 * already paid for that once: `assertGenrePassed` exists because a fact was
 * guarded on the video path and not the frame path, and the frame path is the
 * DEFAULT — no GEMINI_API_KEY means frames. A criterion on one side only is a
 * gate that is off for most runs.
 *
 * Written against the observed failure (ENG-6375), where the grader did not
 * merely miss the defect but CERTIFIED it: "The video effectively shows the
 * location of the connector URL", over a film whose 90px headline promised an
 * endpoint that "lets Claude Code design in Moda" and whose screen read
 * "read-only filesystem over all Moda documentation" — both legible in the same
 * frame. So it asks for QUOTES from both sides rather than a verdict: a grader
 * that must copy out the words it is comparing cannot wave at them.
 */
const CONTRADICTION_INSTRUCTION =
  'SEPARATELY from the issues above, and last: check the film\'s own claims against what is ' +
  'actually on screen. Its headline, captions and narration ASSERT things. Read the text ' +
  'VISIBLE in the frames — product labels, URLs, descriptions, button text — and decide ' +
  'whether it SUPPORTS those assertions or CONTRADICTS them.\n' +
  'This is not about polish. A well-paced, well-captioned film that demonstrates a DIFFERENT ' +
  'feature from the one its words name is exactly what this question exists to catch, and it ' +
  'is the failure a viewer cannot spot without knowing the product. Judge only what you can ' +
  'read on screen; do not assume the film is about what it says it is about.\n' +
  'Quote both sides verbatim. If the visible text supports every claim the film makes, ' +
  'return null — do not invent one.';

//: The `contradiction` slot, spelled the same into both prompts' JSON shape.
const CONTRADICTION_SHAPE =
  '"contradiction": {"claim": "<the film\'s own words, quoted>", ' +
  '"screen": "<the visible text that contradicts them, quoted>", ' +
  '"atSeconds": <number>} or null';

/**
 * A contradiction the report may act on, or null.
 *
 * NORMALISED, never spread. `critiqueFrames` returns `{ ...out, issues }`, so an
 * unvalidated key from the model would reach the consumers verbatim: a flow
 * finding that steers the next walk, the guidance text handed to discovery, and
 * two `.slice()` calls printing it to the operator — where a bare string or a
 * `{}` is a crash or a line of noise that costs a whole re-record.
 *
 * Both quotes are required and must be non-empty: the design is that the grader
 * shows its evidence, and a finding with no evidence is the waving this exists
 * to replace. (It does NOT refuse a publish — see `canSelect`.)
 */
function admissibleContradiction(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const claim = typeof raw.claim === 'string' ? raw.claim.trim() : '';
  const screen = typeof raw.screen === 'string' ? raw.screen.trim() : '';
  if (!claim || !screen) return null;
  return {
    claim,
    screen,
    // `Number.isFinite`, not `typeof`: NaN and Infinity are both numbers, and
    // either one reaches a `@${atSeconds}s` in the operator's console. (Gemini.)
    atSeconds: Number.isFinite(raw.atSeconds) ? raw.atSeconds : null,
  };
}

function buildPrompt(goal, genre, hasMusic, hasVoiceover, composited) {
  return (
    `You are a senior product-demo video editor reviewing an automated ` +
    `screen-recording demo of: "${goal || 'a web app feature'}".\n\n` +
    // Describing what is ACTUALLY there. An earlier version of this prompt
    // mentioned an intro/outro card, which this pipeline does not produce — and
    // a model told to expect one reports its absence as a defect.
    `${whatIsInTheTake(genre, hasMusic, hasVoiceover, composited)}\n\n` +
    `Watch the whole video and give concise, actionable director's notes. Focus ` +
    `on what only watching reveals:\n` +
    `- pacing: dead air, or steps that go by too fast to follow\n` +
    (genre !== 'marketing' && hasVoiceover
      ? `- does the voiceover match what is on screen at that moment\n` : '') +
    `- jarring, drifting or pointless camera movement\n` +
    (genre === 'marketing' ? '' :
      `- captions that are unreadable, cover the thing being demonstrated, or ` +
      `overlap each other\n`) +
    `- visual glitches: blank or half-rendered screens, nothing happening, the ` +
    `wrong thing on screen\n\n` +
    `${CONTRADICTION_INSTRUCTION}\n\n` +
    `Return ONLY JSON of this shape:\n` +
    `{"score": <1-10>, "summary": "<one or two sentences>", ` +
    `${CONTRADICTION_SHAPE}, "issues": [` +
    `{"type": "<${typesFor(VIDEO_TYPES, genre, hasVoiceover).join('|')}>",` +
    `"severity": "<low|medium|high>", "atSeconds": <number>, ` +
    `"description": "<what is wrong>", "fix": "<${fixesFor(genre, hasVoiceover).join('|')}>"}]}\n` +
    `If it is clean, return a high score and an empty issues array. Be honest, ` +
    `and do not invent problems.`
  );
}

/**
 * What the take ACTUALLY contains, as a sentence for the grader.
 *
 * The prompt already learned this lesson once — it used to promise an intro/outro
 * card this pipeline never produces, and a model told to expect one reported its
 * absence as a defect. The same sentence then went on promising step captions and
 * a voiceover, and denying music, on every take regardless of genre.
 *
 * `marketing` is defined as music only, no captions, no voiceover: `finish.mjs`
 * blanks every label on purpose (ENG-5766), because per-step captions are a
 * tutorial device. So on a marketing take all three clauses were false, and the
 * grader correctly reported the missing captions it had been told to expect —
 * a medium finding with `fix: none`, which `run.mjs` then fed into the next
 * discovery pass as something to fix by re-walking the flow (ENG-6295).
 *
 * Says what is there and what is deliberately absent, so the model neither hunts
 * for a missing feature nor flags a present one.
 */
/**
 * UNDEFINED IS A WIRING BUG, null is a real answer.
 *
 * `null` means genre.json was absent and the take grades as a tutorial, which
 * is what the prompt always said. `undefined` means a caller stopped passing
 * it — and that consequence is silent: the marketing wording disappears and
 * the grader goes back to hunting for captions that are not there. Loud beats
 * silent for a parameter whose absence looks exactly like a valid value.
 *
 * ONE definition, called by BOTH builders. The first cut guarded only the
 * video prompt, so dropping the argument from the frame-sheet call site stayed
 * silent — half a guard on a two-sided seam.
 */
function assertGenrePassed(genre, where) {
  if (genre === undefined) {
    throw new TypeError(`${where}: genre must be passed explicitly (null when unknown) — `
      + 'an omitted genre silently regrades every marketing take as a tutorial (ENG-6295)');
  }
}

/**
 * Every fact the prompt ASSERTS about the take must be passed, never defaulted.
 *
 * Four review rounds of this PR found the same bug four times: the prompt told the
 * grader something the pipeline did not guarantee, so the grader was instructed not
 * to report a defect that was really there. A default is how that happens quietly —
 * `hasMusic = false` made an unscored claim on every caller that forgot the argument.
 * So the facts are required, and a missing one is a crash, not a false sentence.
 */
function assertFactsPassed(facts, where, required) {
  assertGenrePassed(facts.genre, where);
  // Each prompt demands exactly the facts IT asserts. Demanding more would crash a
  // caller over a fact the prompt never claims; demanding fewer is the bug this guards.
  for (const k of required) {
    if (typeof facts[k] !== 'boolean') {
      throw new TypeError(`${where}: ${k} must be passed as a boolean — the prompt asserts it `
        + 'to the grader, and a defaulted fact asserts something the take may not contain (ENG-6295)');
    }
  }
}

function whatIsInTheTake(genre, hasMusic, hasVoiceover, composited) {
  assertFactsPassed({ genre, hasMusic, hasVoiceover, composited }, 'whatIsInTheTake',
    ['hasMusic', 'hasVoiceover', 'composited']);
  const marketing = genre === 'marketing';
  // THE MUSIC FACT IS PASSED, NOT ASSUMED. The first cut of this fix replaced a
  // blanket "no music" with a blanket "there is a music bed" — the same false
  // premise pointed the other way. `DEMO_NO_MUSIC=1` skips the bed, and
  // `generateBed` shells out to a metered render inside a try/catch that logs
  // "scored: skipped" on failure, so a take can legitimately have none. The old
  // wording was wrong more often but harmless: it was paired with "do not
  // report their absence". A positive claim with nothing suppressing it is
  // worse, and it bites hardest on a marketing take where the bed is the only
  // audio there is.
  const music = hasMusic
    ? 'a music bed'
    : 'no music (do not report its absence)';
  // THE VOICEOVER IS A FACT TOO, for the same reason. A tutorial cut can
  // legitimately have none: `keepLines` + DEMO_DROP_LINES can drop every
  // pre-voiced line and `planNarration` then returns [], so nothing is muxed —
  // and that path is reached by the loop's OWN `shorten_narration` remedy on a
  // short take. Asserting a voiceover that is not there hands the grader
  // `narration_mismatch` over silence, whose remedy routes to a narration
  // stage with nothing left to drop.
  const voice = !marketing && hasVoiceover
    ? 'a synthesized voiceover'
    : 'no voiceover (do not report its absence)';
  // The music bed is NOT genre-dependent: finish.mjs muxes one on every genre
  // unless DEMO_NO_MUSIC=1 (ducked under narration, not skipped for tutorial).
  // The old sentence said "no music" on every take, and the first cut of this
  // fix carried that clause into the tutorial branch unchanged — rewriting the
  // wording around a claim without checking it.
  // THE CAMERA AND THE CARD ARE THE SAME FACT. Both are composited at PUBLISH, and
  // the iterate loop grades a cut from BEFORE that (critique-take picks the first of
  // final/scored/narrated/silent that exists). So on a loop cut the old text asserted
  // punch-ins that were provably absent — `iterate.mjs` says it outright: the camera
  // "is emitted at publish and the loop runs before it". Claiming them told the grader
  // to overlook the flatness that is the take's most visible defect. Mirrored, the
  // `.final` cut DOES carry a brand outro, and "do not report its absence" invited the
  // grader to discount a card that is really on screen.
  const camera = composited
    ? 'and camera punch-ins on some clicks. '
    : 'and NO camera movement — the punch-ins are composited at publish and are not in '
      + 'this cut, so do not report flat or static framing. ';
  // Only promise the absence of a card on a cut that genuinely has none.
  const card = composited ? '' : 'There is no intro or outro card; do not report its absence.';
  return marketing
    ? `The video is a screen recording with ${music} ${camera}`
      + 'By design it has NO on-screen captions and NO voiceover — this genre lets the screen '
      + `speak for itself. Do not report the absence of captions or narration. ${card}`
    : `The video is a screen recording with on-screen step captions on a dark plate, `
      + `${voice}, ${music}, ${camera}${card}`;
}

/** Director's notes for a finished cut, or null when unavailable. */
async function critiqueVideo({ videoPath, goal, genre, hasMusic, hasVoiceover, composited }) {
  // AT THE DOOR. The builder-level assert is a backstop, not the guard: on this
  // path buildPrompt is only reached after the upload and up to 120s of
  // PROCESSING polling, so a throw there crashes late and leaks the uploaded
  // Files API object (the files.delete below never runs).
  assertFactsPassed({ genre, hasMusic, hasVoiceover, composited }, 'critiqueVideo',
    ['hasMusic', 'hasVoiceover', 'composited']);
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!apiKey) return { ok: false, reason: 'no GEMINI_API_KEY / GOOGLE_API_KEY' };
  if (!videoPath || !existsSync(videoPath)) return { ok: false, reason: `no file at ${videoPath}` };

  let GoogleGenAI;
  try {
    ({ GoogleGenAI } = require('@google/genai'));
  } catch {
    return { ok: false, reason: 'npm install @google/genai' };
  }

  const ai = new GoogleGenAI({ apiKey });
  let file = await ai.files.upload({ file: videoPath, config: { mimeType: 'video/mp4' } });
  // The Files API transcodes before the model can watch it.
  for (let i = 0; i < 60 && file.state === 'PROCESSING'; i++) {
    await sleep(2000);
    file = await ai.files.get({ name: file.name });
  }
  if (file.state !== 'ACTIVE') return { ok: false, reason: `file state ${file.state}` };

  const resp = await ai.models.generateContent({
    model: MODEL,
    contents: [{ role: 'user', parts: [
      { fileData: { fileUri: file.uri, mimeType: 'video/mp4' } },
      { text: buildPrompt(goal, genre, hasMusic, hasVoiceover, composited) },
    ] }],
    config: { responseMimeType: 'application/json' },
  });

  const text = typeof resp.text === 'string' ? resp.text : resp.text?.() ?? '';
  ai.files.delete({ name: file.name }).catch(() => {});
  const json = JSON.parse(text);
  const issues = Array.isArray(json.issues) ? json.issues : [];
    // `ok` AND `via`, because critique-take gates on `verdict.ok` and
    // critiqueFrames has always returned it. Without them a SUCCESSFUL Gemini
    // critique printed "critique unavailable (undefined)", exited 0, and never
    // wrote critique.json — so everything threaded into this path could never
    // reach a recorded verdict. Invisible in practice because the default path
    // has no GEMINI_API_KEY and takes critiqueFrames.
    return {
      ok: true,
      via: 'gemini',
    score: typeof json.score === 'number' ? json.score : null,
    summary: json.summary || '',
    contradiction: admissibleContradiction(json.contradiction),
    issues: issues.map((x) => ({
      type: x.type || 'other',
      severity: x.severity || 'low',
      atSeconds: typeof x.atSeconds === 'number' ? x.atSeconds : null,
      description: x.description || '',
      // Clamped to the vocabulary so a hallucinated knob cannot reach the loop.
      fix: fixesFor(genre, hasVoiceover).includes(x.fix) ? x.fix : 'none',
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

function sheetPrompt(goal, durationSec, sheet, stepSec, genre, hasVoiceover) {
  assertFactsPassed({ genre, hasVoiceover }, 'sheetPrompt', ['hasVoiceover']);
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
    ...(genre === 'marketing' ? [] : ['- Are captions readable, and do they cover the thing being demonstrated?']),
    '- Anything visibly broken: blank panes, error badges, broken-image icons, dev overlays.',
    '',
    'You cannot judge motion, audio or pacing from stills — do NOT comment on those, and do not report',
    'the absence of anything you cannot see.',
    '',
    // The stills carry the headline and the captions as TEXT, so this question is
    // answerable here — and it has to be, because this is the default path.
    CONTRADICTION_INSTRUCTION,
    '',
    'Return ONLY JSON:',
    `{"score": <1-10>, "summary": "<one or two sentences>", ${CONTRADICTION_SHAPE}, "issues": [{"type":`,
    `"<${typesFor(FRAME_TYPES, genre, hasVoiceover).join('|')}>",`,
    `"severity": "<low|medium|high>", "atSeconds": <number>, "description": "<what is wrong>", "fix": "<${fixesFor(genre, hasVoiceover).join('|')}>"}]}`,
    'If it is genuinely clean, return a high score and an empty issues array. Do not invent problems.',
  ].join('\n');
}

/** Critique from a contact sheet using the `claude` CLI. Never throws except on a caller wiring error (a missing genre). */
async function critiqueFrames({ videoPath, goal, outDir, genre, hasVoiceover }) {
  // AT THE DOOR, and this is the path that matters: sheetPrompt is called
  // inside the try, so a dropped argument became `{ok:false, reason:...}` and
  // critique-take printed "critique unavailable" and carried on — a silently
  // degraded critique, which is the failure this guard exists to prevent.
  assertFactsPassed({ genre, hasVoiceover }, 'critiqueFrames', ['hasVoiceover']);
  if (!existsSync(videoPath)) return { ok: false, reason: `no video at ${videoPath}` };
  try {
    const { sheet, durationSec, stepSec } = buildSheet(videoPath, outDir);
    const raw = execFileSync(
      'claude',
      ['-p', sheetPrompt(goal, durationSec, sheet, stepSec, genre, hasVoiceover), '--output-format', 'json',
       '--allowed-tools', 'Read', '--strict-mcp-config'],
      { encoding: 'utf8', maxBuffer: 16 << 20, stdio: ['ignore', 'pipe', 'ignore'] }
    );
    const text = JSON.parse(raw).result ?? '';
    const a = text.indexOf('{');
    const b = text.lastIndexOf('}');
    if (a < 0 || b <= a) return { ok: false, reason: 'reply was not JSON', sheet };
    const out = JSON.parse(text.slice(a, b + 1));
    // CLAMP, do not spread. Narrowing the vocabulary in the prompt is advice;
    // this is the enforcement. A `fix_caption_overlap` on a marketing take that
    // slips through anyway is not in run.mjs's cheap-lane exclusion list, so a
    // medium one becomes a flow finding and a full re-walk — the exact harm the
    // token removal exists to prevent. And THIS is the default path: no
    // GEMINI_API_KEY means frames, and frames was the unclamped one.
    const issues = (Array.isArray(out.issues) ? out.issues : [])
      .map((x) => admissibleIssue(x, typesFor(FRAME_TYPES, genre, hasVoiceover), genre, hasVoiceover))
      .filter(Boolean);
    // AFTER the spread, deliberately: `...out` would otherwise carry the model's
    // raw `contradiction` straight through to its consumers — a flow finding,
    // the guidance text handed to the next discovery pass, and two `.slice()`
    // calls printing it. (It does not gate a publish; see `canSelect`.)
    return { ok: true, via: 'frames', sheet, ...out, issues,
      contradiction: admissibleContradiction(out.contradiction) };
  } catch (e) {
    return { ok: false, reason: String(e.message).split('\n')[0].slice(0, 140) };
  }
}

//: The prompt builders are exported for the tests. This bug WAS the prompt
//: text — a sentence promising captions a marketing take does not have — so a
//: guard that cannot read the prompt cannot see it (ENG-6295).
module.exports = { critiqueVideo, critiqueFrames, buildPrompt, sheetPrompt,
  admissibleIssue, admissibleContradiction, typesFor, VIDEO_TYPES, FRAME_TYPES, FIXES };
