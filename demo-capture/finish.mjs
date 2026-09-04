// Between the take and the publish: script it, pace it, voice it.
//
// The order is forced and worth stating, because getting it wrong is silent.
// Compression needs to know where narration sits — a line spoken over a sped-up
// gap describes something the viewer has already flashed past — and compression
// then MOVES those positions. So: plan the narration (render and measure it),
// compress against those spans, remap the spans through the same time-map, and
// only then mux. Any other order desynchronises the audio from the picture.
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, existsSync, rmSync, copyFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const { ffmpeg: FFMPEG, ffprobe: FFPROBE } = require('./src/bin.js');
const { planNarration, narrate } = require('./src/narrate.js');
const { compressIdleGaps } = require('./src/compress.js');
const { generateBed, addMusicBed } = require('./src/music.js');
const { chooseStyle } = require('./src/style.js');

const [outDir, id, linesJson] = process.argv.slice(2);

// Two genres, measured from published work (see the skill's
// `what-good-looks-like.md`). They are not a spectrum — they disagree about what
// the video is FOR.
//
//   marketing  — what a company publishes. Music from frame one, NO voiceover,
//                and no per-step captions: across three references the totals
//                were 0, 4 and 2 captions in the WHOLE video, never one per
//                click. The product carries the story.
//   tutorial   — a screencast. Where-to-click is the content, so a caption and a
//                line per step earn their place.
//
if (!outDir || !id) {
  console.error('usage: node finish.mjs <outDir> <id> [\'["line","",...]\']  ("" skips an action)');
  process.exit(2);
}

const clipPath = `${outDir}/${id}.timeline.json`;
// The timeline AS RECORDED. This stage rebases every action time onto the
// compressed cut and writes the result back to `clipPath`, so re-running read
// its own output as input: a 46s take's timeline came back as 22s, then 17s,
// each pass rebasing times that were already rebased. The video had exactly the
// same bug and was fixed the same way — the recorded artifact is immutable and
// every stage derives from it.
const clipSourcePath = `${outDir}/${id}.timeline.source.json`;
if (!existsSync(clipSourcePath)) copyFileSync(clipPath, clipSourcePath);
let clip = JSON.parse(readFileSync(clipSourcePath, 'utf8'));
const mp4 = `${outDir}/${id}.mp4`;
// The take as recorded, kept untouched so every stage downstream can be re-run
// from it. Created once, on the first finish; after that it is the input and
// `mp4` is only ever an output.
const sourceMp4 = `${outDir}/${id}.source.mp4`;
if (!existsSync(sourceMp4)) copyFileSync(mp4, sourceMp4);

// RE-DERIVE the duration from the recording every run. This step writes its own
// result back to the timeline — a tail hold for a closing line extends
// `durationSec` — so a second run on the same take reads the PREVIOUS run's
// output duration as if it described the source footage. With a 4s hold that
// desynchronised the time-map hard enough to throw ("compressed to 9.20s but the
// time-map says 12.75s").
//
// It must come from the SOURCE recording. Reading `mp4` was right when `mp4` was
// the recording; once compression started writing to it, this re-derived the
// duration from THIS STAGE'S OWN PREVIOUS OUTPUT — the third place in the
// pipeline with that shape. A re-run then paired a 21.6s duration with action
// times from the 62.9s take, and the dead-time check reported waits longer than
// the video that contained them.
clip = {
  ...clip,
  durationSec: +execFileSync(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration',
    '-of', 'default=nw=1:nk=1', sourceMp4], { encoding: 'utf8' }).trim(),
};
const lines = linesJson ? JSON.parse(linesJson) : undefined;
const before = clip.durationSec;

// A previous run's cuts would otherwise be published in place of this one's —
// `publish-take` picks the most finished file it finds, not the newest.
// EVERY derived cut, not just the two this stage writes. `.final` and
// `.with-outro` come from publish-take, and `critique-take` prefers `.final`
// over everything else — so on a take that had been published once, a re-cut
// left the old export in place and every later critique scored THAT. The
// iterate loop then reported scores for a video it had not produced.
for (const stale of ['narrated', 'scored', 'with-outro', 'final']) {
  rmSync(`${outDir}/${id}.${stale}.mp4`, { force: true });
}

// The genre the TAKE was recorded for, when it recorded one. Re-asking here is
// a second model call on the same question, and a different answer invalidates
// the pacing the recording was built around — see take.mjs.
const recordedGenre = existsSync(`${outDir}/genre.json`)
  ? JSON.parse(readFileSync(`${outDir}/genre.json`, 'utf8'))
  : null;
const { style: STYLE, why } = recordedGenre
  ? { style: recordedGenre.style, why: `${recordedGenre.why} (decided at capture)` }
  : chooseStyle(clip);

// The script and its audio were made BEFORE the recording, and the recording
// was paced to them (`src/pacing.js`). So finish reuses them: re-scripting here
// would produce different sentences from the ones the take was timed against,
// and re-voicing would pay for the same audio twice.
//
// Captions are NOT touched here and must not be. `captions.js` writes them from
// the RESOLVED ELEMENT for the eye (2-6 words), which ENG-5766 separated from
// the voiceover on purpose — the action label carries the discovery agent's
// reasoning, and a real run once burned "let me scroll up to find the Go to App
// link" into a video.
const pacingPath = `${outDir}/pacing.json`;
const pacing = existsSync(pacingPath) ? JSON.parse(readFileSync(pacingPath, 'utf8')) : null;
if (pacing) {
  console.log(
    `  script: ${pacing.spoken.length} pre-voiced line(s) (${pacing.transport})` +
      `${pacing.conclusion ? ` + a ${pacing.conclusion.durationSec.toFixed(1)}s conclusion` : ''}`
  );
} else if (STYLE !== 'marketing') {
  console.log('  script: NO pacing.json — this take was recorded without a script, so lines may overrun');
}
const planned = STYLE === 'marketing'
  ? []
  : planNarration({
      clip,
      outDir,
      lines,
      preVoiced: lines ? null : pacing?.spoken,
      preVoicedConclusion: lines ? null : pacing?.conclusion,
    });
// Name the reason, not just the choice. A genre picked wrongly is the single
// biggest difference between the cuts and it is invisible in the output — the
// marketing cut of a navigation demo looks like a demo that needed no captions.
console.log(
  STYLE === 'marketing'
    ? `  style:  marketing — music only, no captions, no voiceover (${why})`
    : `  style:  tutorial — ${planned.length} caption(s) and line(s) (${why})`
);

const compressed = compressIdleGaps({ mp4Path: mp4, sourcePath: sourceMp4, clip, narrationSpans: planned });
if (compressed) {
  clip = compressed.clip;
  // The SAME map, or the voiceover talks over the wrong moment.
  for (const line of planned) line.startSec = compressed.remap(line.startSec);
  console.log(
    `  paced:  ${before}s -> ${compressed.newDuration}s ` +
      `(${compressed.spedSegments} idle gap(s) sped up, saved ${(before - compressed.newDuration).toFixed(1)}s)`
  );
} else {
  console.log('  paced:  nothing idle enough to compress');
}

if (planned.length) {
  const r = narrate({ clip, mp4, outDir, id, planned });
  for (const f of r.report) {
    console.log(`    line ${f.index}  ${f.spokenSec}s / ${f.budgetSec}s  ${f.fits ? 'fits' : `OVERRUNS by ${f.overrunSec}s`}`);
  }
  if (r.tailSec > 0) {
    // Remember where the real FOOTAGE ends, before the freeze that lets the
    // closing line finish. The outro card wants to come up here rather than
    // after: otherwise the conclusion plays over a frozen screenshot of the app,
    // which is a worse place to land the last thing the video says than the card
    // is. Measured on a real cut — 7s of static app, then the card.
    clip = { ...clip, footageEndSec: clip.durationSec, durationSec: r.durationSec };
  }
}

// Music LAST, over whatever the picture and voice ended up being. Generated to
// the final duration, so it cannot be left short by a trim or a tail hold that
// happened after it was made.
if (process.env.DEMO_NO_MUSIC !== '1') {
  try {
    const narrated = `${outDir}/${id}.narrated.mp4`;
    const target = existsSync(narrated) ? narrated : mp4;
    const bed = generateBed({ outDir, seconds: clip.durationSec, mood: process.env.DEMO_MUSIC_MOOD });
    const scored = addMusicBed({ mp4: target, outDir, id, bed, narrationSpans: planned });
    console.log(`  scored: ${scored.split('/').pop()}`);
  } catch (e) {
    // Advisory, like the critique: a demo without a bed is worse, not broken.
    console.log(`  scored: skipped (${String(e.message).split('\n')[0].slice(0, 80)})`);
  }
}

writeFileSync(clipPath, JSON.stringify(clip, null, 2));
// The normalized document the compiler reads, rebuilt from the rebased clip.
// No `--raw-labels`: the bridge runs `scriptCaptions`, which writes the ON-SCREEN
// text from the resolved element. That is a different job from the voiceover
// above and deliberately so (ENG-5766).
const doc = JSON.parse(execFileSync('node', ['to-moda-timeline.js', clipPath], { encoding: 'utf8' }));
if (STYLE === 'marketing') {
  // Per-step captions are a tutorial device. Declined by blanking the label in
  // the DOCUMENT — `compile_demo` skips any action with no label — which needs no
  // compiler change and leaves timing, camera and ledger untouched.
  //
  // It has to happen here, after the bridge: the caption writer DERIVES its text
  // from the resolved element rather than reading `label`, so clearing labels on
  // the clip upstream changes nothing. Measured the hard way — the bridge went on
  // reporting "3 captioned".
  for (const a of doc.actions) a.label = '';
}
writeFileSync(`${outDir}/${id}.moda.json`, JSON.stringify(doc, null, 2));
const finalCut = existsSync(`${outDir}/${id}.scored.mp4`)
  ? 'scored'
  : existsSync(`${outDir}/${id}.narrated.mp4`)
    ? 'narrated'
    : 'silent';
console.log(`  ready:  ${clip.durationSec}s (${finalCut})`);
