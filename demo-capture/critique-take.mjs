// Watch the finished video and say whether it is any good.
//
// This is the check nothing else performs. Every other signal in this pipeline
// reads numbers — the selector resolved, the line fits its slot, the camera
// wrote keyframes — and a demo can satisfy all of them and still be nonsense.
// Three shipped this session that did:
//
//   - a gradient demo where the gradient never changed, because the colour
//     swatches were being typed into with keystrokes they ignore
//   - a markdown demo whose document was the typed text merged into leftover
//     placeholder content, with two competing headings
//   - a tool demo whose punch-in cropped the result out of frame
//
// All three were caught by a person watching, after being reported as fine. The
// pattern was always the same: I checked that something was PRESENT rather than
// that it had CHANGED, and a downsampled contact sheet hides exactly that.
//
// So the model gets asked the question I kept failing to ask, and it is given
// the objective measurements alongside, because some of this is countable and
// counting beats judging where it can.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { ffmpeg: FFMPEG, ffprobe: FFPROBE } = require('./src/bin.js');
const { critiqueVideo, critiqueFrames } = require('./src/critique.js');
const { checkMotion, JUMP_PX } = require('./src/motion-check.js');
const { checkInk } = require('./src/ink-check.js');
const { checkShots, DEAD_TIME_SHARE } = require('./src/shot-check.js');
const { checkLegibility } = require('./src/legibility-check.js');
const { checkCaptions } = require('./src/caption-check.js');

const [outDir, id] = process.argv.slice(2);
if (!outDir || !id) {
  console.error('usage: node critique-take.mjs <outDir> <id>');
  process.exit(2);
}

const doc = JSON.parse(readFileSync(`${outDir}/${id}.moda.json`, 'utf8'));
//: What SHIPS, most-finished first. `finish.mjs` writes `.scored` / `.narrated`
//: and calls that its final cut; only `publish-take.mjs` composites the outro
//: into `.final`. Checking for `.final` ALONE and falling back to the raw
//: `.mp4` meant every take that had not been published was judged as the bare
//: browser recording — no camera, no pacing, no music — and the report said
//: nothing, because a silent fallback to a file that exists looks like success.
const CUTS = ['final', 'scored', 'narrated', 'silent'];
const finalMp4 = CUTS.map((c) => `${outDir}/${id}.${c}.mp4`).find((f) => existsSync(f));
const video = finalMp4 ?? `${outDir}/${id}.mp4`;
//: The browser recording, before the camera. This is what gets MEASURED.
//:
//: The two measurements below are both about the page's own behaviour, and the
//: camera destroys the evidence for both. A punch-in is in continuous motion, so
//: no two frames of a finished video are ever identical: `stillFraction` read
//: 425 unique of 425 — "0% of the video is holding still" — on a take whose raw
//: footage was 337 of 350. The metric was reporting the camera, not the demo,
//: and it was pinned at 0 for every video ever passed to it.
const rawVideo = `${outDir}/${id}.mp4`;

/**
 * The countable half. These need no model and cannot hallucinate.
 *
 * `mpdecimate` drops frames identical to their predecessor, so the ratio of
 * unique to total frames is a direct measure of how much of the video is
 * standing still.
 */
function measure(path) {
  const total = +execFileSync(FFPROBE, ['-v', 'error', '-count_frames', '-select_streams', 'v',
    '-show_entries', 'stream=nb_read_frames', '-of', 'default=nw=1:nk=1', path], { encoding: 'utf8' }).trim();
  const unique = +execFileSync(FFPROBE, ['-v', 'error', '-f', 'lavfi', '-i',
    // ffmpeg's OWN DEFAULTS. This said `hi=1:lo=1:frac=1`, which means a single
    // differing pixel makes a frame unique — so the metric could not report a
    // hold on encoded video and read "0% holding still" on every take ever
    // measured. On a shipped demo whose back two thirds are a frozen dark page
    // it read 0%; at these thresholds the same file reads 66%.
    `movie=${path},mpdecimate=hi=768:lo=320:frac=0.33`, '-count_frames', '-select_streams', 'v',
    '-show_entries', 'stream=nb_read_frames', '-of', 'default=nw=1:nk=1'], { encoding: 'utf8' }).trim();
  return { total, unique, stillFraction: total ? 1 - unique / total : 0 };
}

// THE CUT THAT SHIPS, not the raw take. The raw one answers "was the page
// static", which is a different question from "is the video boring" — and the
// video is what a viewer sits through. The camera was the reason for measuring
// the raw take, on the theory that a punch-in keeps every frame unique; that is
// only true WHILE it is moving, and the holds that matter are the ones after it
// settles.
//: Above this share of static frames the video is a slideshow. A demo holds on
//: its result deliberately, so this is not zero — two fifths is generous.
const STILL_CEILING = 0.4;

const issues = [];
const stats = measure(video);
const rawStats = existsSync(rawVideo) && rawVideo !== video ? measure(rawVideo) : null;
// Reported together, because separately they contradicted each other: one said
// "25% dead time" while the other said two thirds of the video was frozen. They
// are different questions — how much of the RUNTIME is the product thinking,
// and how much of the VIDEO is a still image — and only the second is what a
// viewer sits through. The first explains part of the second.
const stillPct = (stats.stillFraction * 100).toFixed(0);

// Steps that changed nothing are already known from validation; surface them
// here too, because this is the report a person reads.
const inert = doc.actions.filter((a) => a.clickX != null && !a.resultBox).map((a) => a.index);
if (inert.length) console.log(`  steps with no measured change: ${JSON.stringify(inert)}`);

// Counted, not judged — the frame critique below samples ~1 still per second and
// a one-frame teleport falls between samples every time.
// Also on the RAW take: this asks whether the PAGE scrolled smoothly, and the
// camera's own pan would be indistinguishable from the page's if it were baked in.
const motion = checkMotion(existsSync(rawVideo) ? rawVideo : video, { from: 0, seconds: Math.min(6, stats.total / 30) });
if (motion.ok) {
  if (motion.jumps.length) {
    console.log(`  ⚠ ${motion.jumps.length} single-frame JUMP(S) over ${JUMP_PX}px — the picture teleports rather than moves:`);
    for (const j of motion.jumps.slice(0, 4)) console.log(`      frame ${j.frame} moved ${j.px}px in one frame`);
  } else {
    console.log(`  motion: no single-frame jump over ${JUMP_PX}px (${motion.moving} of ${motion.frames} frames moving)`);
  }
} else {
  console.log(`  motion: not measured (${motion.reason})`);
}

// Counted, not judged: did any part of the page EMPTY OUT by the end?
const ink = checkInk(existsSync(rawVideo) ? rawVideo : video, stats.total / 30);
if (!ink.ok) {
  console.log(`  content: not measured (${ink.reason})`);
} else if (ink.vanished) {
  console.log(`  ⚠ CONTENT VANISHED — ${ink.blankedCells} of ${ink.inkedCells} inked regions are empty by the last frame (${(ink.share * 100).toFixed(0)}%)`);
  console.log('      the demo ends showing less than it started with — a blank pane, a failed render, or content it deleted.');
} else {
  console.log(`  content: intact — ${ink.blankedCells} of ${ink.inkedCells} inked regions emptied by the end`);
}

// The four a person kept catching and the model kept scoring around — all
// countable from the timeline and the emitted camera program. See src/shot-check.js.
const shots = checkShots({ doc, outDir, id });
const waiting = shots.deadTime.measured
  ? ` — ${(shots.deadTime.share * 100).toFixed(0)}% of the runtime is the product thinking`
  : ` (waits not measured: ${shots.deadTime.reason})`;
if (stats.stillFraction > STILL_CEILING) {
  console.log(`  ⚠ FROZEN — ${stillPct}% of the finished video is a still image${waiting}`);
  issues.push({ stage: 'pacing', type: 'frozen', detail: `${stillPct}% of the cut is static` });
} else if (shots.deadTime.measured && shots.deadTime.bad) {
  // Not frozen, but a lot of the runtime is a wait — the spinner is animating.
  console.log(`  ⚠ DEAD TIME — ${(shots.deadTime.share * 100).toFixed(0)}% of the runtime is the product thinking, over the ${(DEAD_TIME_SHARE * 100).toFixed(0)}% ceiling`);
  issues.push({ stage: 'pacing', type: 'dead_time', detail: `${(shots.deadTime.share * 100).toFixed(0)}% of the runtime is a wait` });
} else {
  console.log(`  stillness: ${stillPct}% of the video is a still image${waiting}`);
}

// Presence is not legibility — see src/legibility-check.js.
const leg = checkLegibility({ rawVideo: existsSync(rawVideo) ? rawVideo : video, doc });
if (!leg.measured) console.log(`  legibility: not measured (${leg.reason})`);
else if (leg.bad) {
  for (const o of leg.offenders) {
    console.log(`  ⚠ PAYOFF IS HARDER TO READ than what it replaced — action ${o.action}: ${o.before}% of the region was legible before, ${o.after}% after`);
  }
  issues.push({ stage: 'flow', type: 'payoff_illegible', detail: JSON.stringify(leg.offenders) });
} else console.log(`  legibility: ${leg.compared} payoff(s) as readable as what they replaced`);

if (!shots.cursorOcclusion.measured) console.log(`  cursor: not measured (${shots.cursorOcclusion.reason})`);
else if (shots.cursorOcclusion.bad) {
  console.log(`  ⚠ CURSOR ON THE TEXT — action(s) ${shots.cursorOcclusion.offenders.join(', ')} typed with the pointer still over the field`);
  issues.push({ stage: 'capture', type: 'cursor_occlusion', detail: `actions ${shots.cursorOcclusion.offenders.join(', ')}` });
} else console.log('  cursor: clear of the text while typing');

// The tutorial branch puts text on screen and nothing here read it.
const caps = checkCaptions(doc);
if (!caps.measured) {
  console.log(`  captions: not measured (${caps.reason})`);
} else if (caps.bad) {
  for (const o of caps.offenders) console.log(`  ⚠ CAPTION UNREADABLE — action ${o.action}: ${o.why}\n      ${JSON.stringify(o.text)}`);
  issues.push({ stage: 'flow', type: 'caption_unreadable', detail: JSON.stringify(caps.offenders) });
} else {
  console.log(`  captions: ${caps.captions} readable`);
}

const cs = shots.captionSubject;
if (cs) {
  if (!cs.measured) console.log(`  result in frame: not measured (${cs.reason})`);
  else if (cs.bad) for (const o of cs.offenders) {
    console.log(`  ⚠ THE CAMERA IS NOT SHOWING THE RESULT — action ${o.action} at ${o.atSec}s: only ${o.shows}% of what the step changed is in frame` +
      (o.caption ? `\n      caption says ${JSON.stringify(o.caption)}` : ''));
  } else console.log(`  caption subject: ${cs.captions} caption(s), each showing what it names`);
}

if (shots.noCamera?.bad) {
  console.log(`  ⚠ NO CAMERA AT ALL — ${shots.noCamera.reason}`);
  console.log('      the whole video is one wide shot; nothing directs the eye to what changed.');
  issues.push({ stage: 'camera', type: 'no_punch_ins', detail: shots.noCamera.reason });
}
for (const [key, label] of [['zoomSync', 'ZOOM OUT OF SYNC'], ['zoomFraming', 'ZOOM OFF THE CLICK'], ['zoomRelease', 'ZOOM LEAVES TOO EARLY']]) {
  const r = shots[key];
  if (!r.measured) { console.log(`  ${key}: not measured (${r.reason})`); continue; }
  if (!r.bad) { console.log(`  ${key}: ${r.peaks} punch-in(s), all on target`); continue; }
  for (const o of r.offenders) {
    if (key === 'zoomSync') {
      console.log(`  ⚠ ${label} — action ${o.action}: peak at ${o.peakSec}s vs click at ${o.clickSec}s (${o.offSec > 0 ? '+' : ''}${o.offSec}s)`);
    } else if (key === 'zoomRelease') {
      console.log(`  ⚠ ${label} — action ${o.action}: camera back out at ${o.releasedAtSec}s but the typing runs to ${o.actionEndsSec}s (${o.earlyBySec}s of it outside the shot)`);
    } else {
      console.log(`  ⚠ ${label} — action ${o.action}: click ${(o.slack * 100).toFixed(0)}% from the frame edge; camera looking at ${o.lookingAt} not ${o.clickAt}`);
    }
  }
  issues.push({ stage: 'camera', type: { zoomSync: 'zoom_sync', zoomFraming: 'zoom_framing', zoomRelease: 'zoom_release' }[key], detail: JSON.stringify(r.offenders) });
}
writeFileSync(`${outDir}/shot-check.json`, JSON.stringify({ ...shots, issues }, null, 2));

const useGemini = Boolean(process.env.GEMINI_API_KEY);
const verdict = useGemini
  ? await critiqueVideo({ videoPath: video, goal: doc.goal })
  : await critiqueFrames({ videoPath: video, goal: doc.goal, outDir });

if (!verdict.ok) {
  console.log(`  critique unavailable (${verdict.reason}) — the numbers above still stand`);
  process.exit(0);
}

console.log(`\n  score ${verdict.score}/10 via ${verdict.via ?? 'gemini'} — ${verdict.summary}`);
writeFileSync(`${outDir}/critique.json`, JSON.stringify({
  score: verdict.score, summary: verdict.summary, issues: verdict.issues ?? [], shots: issues,
}, null, 2));
for (const issue of verdict.issues ?? []) {
  console.log(`    [${issue.severity}] ${issue.type} @${issue.atSeconds}s — ${issue.description}  (fix: ${issue.fix})`);
}

// The findings become GUIDANCE for the next discovery run, which is what makes
// this a loop rather than a report. `discover()` already takes it and appends it
// to its system prompt, so the next attempt actively avoids these.
const actionable = (verdict.issues ?? []).filter((i) => i.severity !== 'low');
if (actionable.length) {
  const guidance = actionable.map((i) => `- ${i.type}: ${i.description}`).join('\n');
  writeFileSync(`${outDir}/guidance.txt`, guidance);
  console.log(`\n  wrote ${outDir}/guidance.txt — pass it to discovery to re-run informed:`);
  console.log(`    node discover-flow.mjs "<goal>" <url> <flow> --guidance ${outDir}/guidance.txt`);
}
