// Steps 4-6 of the skill, for a take that already exists. Same sequence and the
// split out so a Claude-driven capture can publish without the authoring loop
// without re-running the autonomous authoring loop.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { brandCard } = require('./src/outro.js');
const { recordIsMeasured } = require('./src/measured.js');
import { homedir } from 'node:os';

const outDir = process.argv[2], id = process.argv[3], name = process.argv[4];
// `--no-zoom` publishes the same take with captions and narration but NO camera.
// Worth having as a lane rather than a one-off: every punch-in on a sidebar or
// menu demo clamps (measured at 2.2/1.8/1.6/1.4 — the targets sit at x=0.11, and
// nothing can centre those), so whether the camera earns its place on this shape
// of demo is a question to answer by looking, not by tuning.
const noZoom = process.argv.includes('--no-zoom');
// A branded closing card. Unanimous across the references — all three end on a
// logo and a CTA — and the one intro/outro question that is not a design call.
const brandId = process.env.DEMO_BRAND || null;
const sh = (c, a, o = {}) => execFileSync(c, a, { encoding: 'utf8', maxBuffer: 64 << 20, ...o });
const moda = (argv) => {
  let raw;
  try {
    raw = sh('moda', [...argv, '--json']);
  } catch (e) {
    // A NON-ZERO EXIT still carries the CLI's error JSON, and it is on STDOUT —
    // `execFileSync` puts only stderr in `e.message`, so the branch below never
    // saw it and the failure reached the user as a dumped exception object
    // (`pid`, `output`, `signal`) with the actual reason buried in it. The same
    // stdout/stderr split defeated a retry in this file once before.
    raw = `${e.stdout ?? ''}`;
    if (!raw.trim()) throw e;
  }
  const line = raw.trim().split('\n').filter((l) => l.trim().startsWith('{')).pop();
  if (!line) throw new Error(`moda ${argv.join(' ')} produced no JSON:\n${raw.slice(0, 400)}`);
  const out = JSON.parse(line);
  if (out.ok === false) {
    const err = out.error ?? {};
    const detail = err.details?.error?.details?.[0];
    throw new Error(
      `moda ${argv.slice(0, 2).join(' ')} failed: ${err.code ?? 'error'} — ${err.message ?? ''}` +
      (detail ? `\n  ${detail.path?.join('.')}: ${detail.message}` : '') +
      (err.request_id ? `\n  request_id ${err.request_id}` : '')
    );
  }
  return out;
};
const docPath = `${outDir}/${id}.moda.json`;
const doc = JSON.parse(readFileSync(docPath, 'utf8'));

console.log('[4] uploading');
// The NARRATED cut when one exists. Audio reaches the exported mp4 because the
// clip is placed as an un-muted video fill (AGENT_VIDEO_FILL_MUTED = false) and
// the server executor muxes audible video-fill audio unconditionally — so the
// voiceover rides the recording rather than needing a composition audio clip,
// which would need the main_edit export scope nothing can request yet.
// Most finished first: scored (music + any voice) > narrated > silent.
const scored = `${outDir}/${id}.scored.mp4`;
const narrated = `${outDir}/${id}.narrated.mp4`;
const source = existsSync(scored) ? scored : existsSync(narrated) ? narrated : `${outDir}/${id}.mp4`;
console.log(`    source: ${source.replace(/^.*\.(\w+)\.mp4$|^.*\.mp4$/, (m, k) => k || 'silent')}`);
// THE CLOSING CARD IS A PAGE NOW, not pixels (ENG-6306).
//
// It used to be muxed into the recording's own bytes by ffmpeg, and the compile
// doc was then stretched by exactly what the mux added so the page would not end
// mid-card. That worked, and it produced an artifact nobody could edit: the
// logo, the tagline and the url were baked into the video the moment they were
// composited, in a pipeline whose entire pitch is an editable canvas.
//
// `--scope sequence` stitches every visible page into one mp4, so the close is
// simply the last page. Same brand facts, read from the same `brandCard`; the
// recording is uploaded untouched, and the doc needs no stretching because
// nothing was appended to the clip.
const uploadSource = source;
const compileDocPath = docPath;
const card = brandId ? brandCard(brandId) : null;

const up = moda(['file', 'upload', uploadSource]);
// The `file_` id is the only form needed: the verb takes it and mints its own
// signed URL server-side, and the readiness poll below reads the RECORD rather
// than fetching bytes. `up.uploads[0].url` (the byte proxy) is deliberately not
// bound here — reaching for it is what made the old poll watch the wrong fact.
const fileId = up.uploads[0].file_id;
// WAIT FOR THE RECORD TO BE MEASURED, NOT FOR THE BYTES TO EXIST (ENG-6103).
//
// Placement needs the File record's width/height. Those are probed from the
// container ASYNCHRONOUSLY, some seconds after the upload returns; until they
// land, `demo publish` dies with MARKUP_PARSE_ERROR ("no stored dimensions"),
// which is a browser-side parser error the caller cannot act on.
//
// This poll used to `curl -r 0-0` the byte-proxy URL and break on anything but
// a 404. That is true the INSTANT the canonical copy exists, so it cleared on
// its first iteration and published ~35s early — the 45s budget it was given
// was ample, it was just spent watching the wrong thing. Measured on the run
// that filed ENG-6103: bytes at 17:56:03.6, dimensions at 17:56:41.1.
//
// `file show` reports width/height as null until the probe writes them, so the
// signal is now the same fact placement will demand. Dimensions present also
// implies the bytes are readable — the probe had to read them — so nothing is
// lost by dropping the byte check.
const MEASURE_TIMEOUT_MS = 120_000;
const deadline = Date.now() + MEASURE_TIMEOUT_MS;
let lastErr = null;
for (let n = 1; ; n++) {
  // TOLERANT BY DESIGN. `moda()` throws on any non-zero exit or `ok: false`, and
  // this loop's whole job is waiting out an eventually-consistent backend — so a
  // 502, a token refresh or a network blip must cost one iteration, not the whole
  // take. The poll this replaced got that for free (a failed `curl` exited 0 and
  // fell through to the sleep); doing it by hand is the price of asking a real
  // question instead of an easy one. A persistent failure still surfaces: the
  // last error rides the deadline throw, so a scope or auth problem is not
  // mistaken for a slow probe.
  let rec = {};
  try {
    rec = moda(['file', 'show', fileId]).file ?? {};
    lastErr = null;
  } catch (err) {
    lastErr = err;
  }
  if (recordIsMeasured(rec)) {
    if (n > 1) console.log(`    measured: ${rec.width}x${rec.height}`);
    break;
  }
  if (Date.now() > deadline) {
    throw new Error(
      `recording never measured: ${fileId} still has no width/height after ` +
      `${Math.round(MEASURE_TIMEOUT_MS / 1000)}s. The container probe runs in the background after ` +
      'upload, and covers MP4/QuickTime only — a WebM, or a container it cannot parse, never ' +
      'gets dimensions and cannot be placed. Re-encode to H.264 in an MP4 and retry: the SAME ' +
      'bytes deduplicate onto this record, and while that does re-dispatch the enrichment, its ' +
      'gate declines a record that already has a poster, so the outcome is unchanged.' +
      (lastErr ? `\n  last error from \`file show\`: ${lastErr.message}` : '')
    );
  }
  if (n === 1) console.log('    waiting for the recording to be measured…');
  await new Promise((r) => setTimeout(r, 2000));
}
// ONE VERB. Everything between the upload and the export — compile the markup,
// create the canvas, apply it, read the clip's node id back, emit the camera
// against that id, time the captions, apply both in a single edit, export the
// mp4 — is what `moda demo publish` does, server-side, in one call.
//
// This file used to do all of it by hand. That was not a design choice: the
// endpoint behind the verb passed an invalid `layout_mode` and so had never
// once succeeded, and the hand-rolled path was the only one that worked. With
// that fixed the duplication is just duplication, and it was the whole reason
// the pipeline needed a studio checkout — `compile.py` imports the compiler
// from `backend/app/services/demo_video`, which nobody outside the monorepo
// has. (ENG-5982.)
//
// What stays here is what genuinely cannot move: the upload, because it is
// local bytes. The outro composite used to be the other one — it is gone
// (ENG-6306). The closing card is a PAGE now, so there is no ffmpeg pass and
// no stretched compile doc; `--scope sequence` stitches it into the film.
console.log('[5] publishing');
// THE WORDS, and only the words. Every position, size and type scale is the
// server's — see `backend/app/services/demo_video/layout.py`.
//
// `about` is the editorial pass's one-line answer to "what does this
// demonstrate" (ENG-5766). It is written to `pacing.json`, which says in its
// own comment that this is what reads it. No `about`, no title and no hook:
// a headline invented here would be indistinguishable in the output from one
// the editor actually chose.
const pacing = existsSync(`${outDir}/pacing.json`)
  ? JSON.parse(readFileSync(`${outDir}/pacing.json`, 'utf8'))
  : {};
const about = typeof pacing.about === 'string' ? pacing.about.trim() : '';
const compositionPath = `${outDir}/${id}.composition.json`;
let composition = null;
if (about || card) {
  composition = {
    frame: 'landscape',
    ...(about ? { title: about, hook: { title: about } } : {}),
    // A close page only when the kit has something to SIGN OFF WITH.
    // `brandCard` always returns a background and an ink (both defaulted), so
    // `card` alone is not evidence of content: a kit with no tagline, no
    // company url and no logo would produce a 4-second hold on a flat colour,
    // which is exactly the blank page `Storyboard` exists to avoid.
    ...(card && (card.tagline || card.url || card.logoFileId)
      ? {
          close: {
            ...(card.tagline ? { tagline: card.tagline } : {}),
            ...(card.url ? { url: card.url } : {}),
            ...(card.background ? { background: card.background } : {}),
            ...(card.ink ? { ink: card.ink } : {}),
            // The kit's own `file_` id, passed straight through. The server
            // refuses a pre-built ref because it cannot verify its capability
            // signature, and an unsigned one publishes a canvas whose export
            // 401s on the image with nothing wrong at publish time.
            ...(card.logoFileId ? { mark: card.logoFileId } : {}),
          },
        }
      : {}),
  };
  writeFileSync(compositionPath, JSON.stringify(composition, null, 2));
  const pages = 1 + (composition.hook ? 1 : 0) + (composition.close ? 1 : 0);
  console.log(
    `    composition: ${pages} page(s)` +
      (about ? ` · "${about.slice(0, 60)}${about.length > 60 ? '…' : ''}"` : ' · no headline (no `about`)') +
      (composition.close ? ` · close on ${card.background}${composition.close.mark ? ' with mark' : ''}` : '')
  );
}

const args = ['demo', 'publish', '--timeline', compileDocPath, '--video', fileId, '--name', name];
if (composition) args.push('--composition', compositionPath);
const finalMp4 = `${outDir}/${id}.final.mp4`;
args.push('-o', finalMp4);
// A punch-in planned from an INFERRED low-confidence click is not written
// unless its index is accepted. The capture's clicks are observed, so this
// passes the located set rather than leaving the camera silently dropped.
const located = (doc.actions ?? []).filter((a) => a.clickX != null).map((a) => a.index);
if (!noZoom && located.length) args.push('--accept-zoom', located.join(','));

const published = moda(args);

// KEEP THE CAMERA THE SERVER JUST EMITTED, so the shot checks can grade it.
//
// `src/shot-check.js` reads the camera out of a file. The loop writes its own
// (`<id>.motion.js`, from the local compiler or `moda demo camera`); this is the
// program the CANVAS received, which is a different thing and gets its own name.
//
// This is the program APPLIED to the canvas, returned verbatim, so the checks
// grade what the renderer will do rather than a re-derivation.
//
// The loop tunes the camera before it gets here, planning it through the same
// planner (locally with a checkout, otherwise `moda demo camera`). What this adds
// is the verdict on the program the canvas ACTUALLY received — the loop grades a
// plan, this grades the publish.
const cameraProgram = published.camera_program ?? [];
//: NOT `<id>.motion.js`. That name is `iterate`'s, and its file describes a
//: different thing: the plan for the cut the loop was last working on, which is
//: not necessarily the cut that was published. Keeping them apart is what lets
//: each be graded against its own program.
const publishedMotion = `${outDir}/${id}.published.motion.js`;
// Authoritative BOTH ways. Writing only on success leaves a file that outlives
// the camera it describes: publish once with a camera, let iterate suppress every
// punch-in, publish again — no write happens and the grading below reads the
// earlier publish's program, reporting punch-ins this canvas does not contain.
if (cameraProgram.length) writeFileSync(publishedMotion, cameraProgram.join('\n') + '\n');
else rmSync(publishedMotion, { force: true });

const desktop = `${homedir()}/Desktop/moda-demo${noZoom ? '-nozoom' : ''}.mp4`;
copyFileSync(finalMp4, desktop);

const url = published.editor_url ?? published.canvas?.editor_url ?? `(canvas ${published.canvas_id ?? published.canvas?.id})`;
console.log(`\ncanvas  ${url}\nvideo   ${desktop}`);
for (const w of published.warnings ?? []) console.log(`  · ${String(w).slice(0, 170)}`);

// GRADE THE CAMERA THAT WAS JUST PUBLISHED.
//
// Unconditional, and it always prints. Reporting only failures made silence mean
// three different things — the camera is fine, there is no camera at all, or
// nothing ran — and `noCamera` is one of the four checks this exists to unblind:
// a published take with no punch-ins is a FLAT one, which shot-check classifies
// as a finding, not a gap. Matches critique-take's shape: every check gets a
// line, and an unmeasured check never reads as a clean one.
try {
  const { checkShots } = require('./src/shot-check.js');
  // `publishedMotion` UNCONDITIONALLY. Falling back to checkShots' default would
  // grade `<id>.motion.js`, and that file is not stale — `src/camera-emit.js`
  // keeps it authoritative — it is a DIFFERENT program: the plan for the cut the
  // loop was last working on, which is not necessarily the cut that went out.
  // Grading it here would report framing for punch-ins the published canvas does
  // not contain. A path that does not exist makes `readCamera` return null, which
  // is the honest answer for "this publish wrote no camera".
  // WHY there is no camera decides whether this is a defect, and the server
  // already distinguishes the causes — hardcoding "attempted" turned every one of
  // them into "the compiler planned NO punch-ins".
  //
  // `--no-zoom`, and punch-ins held awaiting confirmation, both yield an empty
  // program on purpose. Reporting those as a flat-take finding tells an agent
  // that just applied `disable_zoom` the take it deliberately shipped flat is
  // unframeable, and contradicts the remedy the server prescribed in the same
  // report. An older server that says nothing at all must stay UNMEASURED rather
  // than become a confirmed defect.
  const toldUs = published.camera_program !== undefined;
  const held = (published.warnings ?? []).some((w) => String(w).startsWith('zoom_awaiting_confirmation'));
  const onPurpose = noZoom || held;
  const shots = checkShots({
    doc, outDir, id,
    motionPath: publishedMotion,
    cameraWasAttempted: toldUs && !onPurpose,
    // FROM THE SERVER, because the published camera is in PAGE space. On a
    // composed publish the clip sits inset — (380,240) 1160x725 for a 1280x800
    // capture — and inverting the transform as though the clip WERE the page
    // puts the recovered shot centre ~200px out at scale 2, against a 0.15
    // margin. That flips the framing verdict both ways: a correctly framed
    // punch-in reads "THE CLICK IS OUTSIDE THE SHOT", and a mis-framed one can
    // read ok. Absent (the full-bleed lane) checkShots defaults to the page.
    clipBox: published.clip_box ?? null,
  });
  const say = (label, r, describe) => {
    if (!r) return console.log(`    ${label}: not measured (the check did not run)`);
    if (!r.measured) return console.log(`    ${label}: not measured (${r.reason})`);
    if (!r.bad) return console.log(`    ${label}: ok`);
    for (const line of describe(r)) console.log(`    ⚠ ${label}: ${line}`);
  };
  console.log('\n  camera:');
  if (!cameraProgram.length && onPurpose) {
    console.log(`    no camera: none written on purpose — ${noZoom ? '--no-zoom' : 'punch-ins are awaiting confirmation (see the warning above)'}`);
  } else {
    say('no camera', shots.noCamera, (r) => [r.reason]);
  }
  say('zoom sync', shots.zoomSync, (r) => r.offenders.map((o) => `action ${o.action} peaks ${o.offSec}s off the click`));
  say('framing', shots.zoomFraming, (r) => r.offenders.map((o) => o.outOfFrame
    ? `action ${o.action}: THE CLICK IS OUTSIDE THE SHOT (looking at ${o.lookingAt.join(',')}, clicked ${o.clickAt.join(',')})`
    : `action ${o.action}: the click sits ${(o.slack * 100).toFixed(1)}% from the frame edge — barely in shot`));
  say('release', shots.zoomRelease, (r) => r.offenders.map((o) => `action ${o.action}: the camera left ${o.earlyBySec}s before the typing finished`));
} catch (err) {
  // Never fail a publish that already succeeded over grading it — but say so,
  // because a silent catch here is exactly how a check stops running.
  console.log(`  · could not grade the published camera: ${err.message}`);
}

