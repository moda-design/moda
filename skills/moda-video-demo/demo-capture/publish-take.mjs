// Steps 4-6 of the skill, for a take that already exists. Same sequence and the
// split out so a Claude-driven capture can publish without the authoring loop
// without re-running the autonomous authoring loop.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { brandCard, compositeOutro } = require('./src/outro.js');
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
// Extend the tail BEFORE upload so the card has ground to sit on; the nodes
// themselves go on the canvas afterwards, so the outro stays editable.
let uploadSource = source;
let card = null;
let compileDocPath = docPath;
if (brandId) {
  card = brandCard(brandId);
  // The hold is chosen from the CLIP's length, so read it back rather than
  // assuming a constant — the doc has to be extended by exactly what the mux
  // added or the page ends mid-card.
  const outro = await compositeOutro({
    mp4: source, outDir, id, card,
    // Set only when a closing line extended the clip past its footage.
    startAtSec: doc.footageEndSec,
  });
  uploadSource = outro.path;
  // The page is exactly `durationSec` long, so an mp4 that is now longer than
  // the doc exports with the card cut off the end — the whole card, since it is
  // the last thing in the file. Extend the doc the compiler sees. The actions
  // keep their original timestamps, so the camera and captions are untouched;
  // the page simply holds the clip's own tail for the card's duration.
  compileDocPath = `${outDir}/${id}.moda.outro.json`;
  writeFileSync(compileDocPath, JSON.stringify({ ...doc, durationSec: doc.durationSec + outro.seconds }, null, 2));
  console.log(`    outro: ${outro.seconds}s card on ${card.background}${card.logoUrl ? ' with mark' : ''}` +
    ` · page ${doc.durationSec.toFixed(2)}s -> ${(doc.durationSec + outro.seconds).toFixed(2)}s`);
}

const up = moda(['file', 'upload', uploadSource]);
// BOTH forms. The readiness poll below needs the proxy URL to fetch; the verb
// takes the `file_` id, and mints its own signed URL server-side.
const videoUrl = up.uploads[0].url;
const fileId = up.uploads[0].file_id;
// upload returns BEFORE the ref resolves; markup then drops <video> silently
const deadline = Date.now() + 45_000;
for (let n = 1; ; n++) {
  const code = Number(sh('curl', ['-s','-o','/dev/null','-w','%{http_code}','-r','0-0','--max-time','15', videoUrl]).trim());
  if (code && code !== 404) break;
  if (Date.now() > deadline) throw new Error(`recording never resolvable (HTTP ${code})`);
  if (n === 1) console.log('    waiting for the upload to resolve…');
  await new Promise((r) => setTimeout(r, 1500));
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
// What stays here is what genuinely cannot move: the outro composite and the
// upload, because both are ffmpeg on local bytes.
console.log('[5] publishing');
const args = ['demo', 'publish', '--timeline', compileDocPath, '--video', fileId, '--name', name];
const finalMp4 = `${outDir}/${id}.final.mp4`;
args.push('-o', finalMp4);
// A punch-in planned from an INFERRED low-confidence click is not written
// unless its index is accepted. The capture's clicks are observed, so this
// passes the located set rather than leaving the camera silently dropped.
const located = (doc.actions ?? []).filter((a) => a.clickX != null).map((a) => a.index);
if (!noZoom && located.length) args.push('--accept-zoom', located.join(','));

const published = moda(args);

const desktop = `${homedir()}/Desktop/moda-demo${noZoom ? '-nozoom' : ''}.mp4`;
copyFileSync(finalMp4, desktop);

const url = published.editor_url ?? published.canvas?.editor_url ?? `(canvas ${published.canvas_id ?? published.canvas?.id})`;
console.log(`\ncanvas  ${url}\nvideo   ${desktop}`);
for (const w of published.warnings ?? []) console.log(`  · ${String(w).slice(0, 170)}`);
