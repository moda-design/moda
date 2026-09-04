// Run the critique, fix what it found, run it again — until the demo is good or
// the loop runs out of things it can do on its own.
//
// The loop already existed on paper: `critique-take.mjs` wrote `guidance.txt`
// and printed a discovery command. Nobody ran it, and running it would not have
// helped, because guidance goes to the FLOW-discovery stage and most findings
// are not about the flow. A zoom that peaks 300ms early, four seconds of an
// empty canvas, a cursor sitting on the text — re-discovering the steps changes
// none of them. Every finding was being routed to one stage regardless of which
// stage owned it.
//
// So findings are routed by OWNER, and the owners have wildly different costs:
//
//   pacing  — re-run finish.mjs.            No re-record, no upload. Seconds.
//   camera  — re-emit the motion program.   No re-record, no upload. Seconds.
//   capture — re-record the take.           Minutes, and drives the real app.
//   flow    — re-discover, then re-record.  Minutes, and burns model calls.
//
// The two cheap stages are also where most of the mechanical defects live, which
// is why iterating is worth automating at all. The expensive two are NOT run
// unless asked for with --allow-recapture, because a loop that silently
// re-drives someone's product every round is not a loop anyone should leave on.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// The SAME interpreter publish-take.mjs uses. `python3` on PATH has no pydantic,
// so compile.py died on import and the camera checks reported "not measured" —
// a silent skip dressed as a completed round.
const { studioPython } = require('./src/studio-path.js');
// OPTIONAL, and the only thing here that still wants a studio checkout.
//
// `publish-take.mjs` goes through `moda demo publish` now, so publishing needs
// nothing local. This lane is different: it re-emits the camera program WITHOUT
// publishing, which is what makes a camera fix cost seconds instead of an
// upload. That still runs the compiler from source.
//
// Without a checkout the loop keeps its pacing lane and says the camera checks
// are UNMEASURED — not clean. An unavailable check that reads as a pass is the
// failure this whole pipeline keeps re-learning. (ENG-5982 tracks moving the
// compile step behind the API so this becomes unconditional.)
let PY = null;
try {
  PY = studioPython();
  if (!existsSync(PY)) PY = null;
} catch {
  PY = null;
}
if (!PY) {
  console.log('  note: no studio checkout — the camera lane is off and the zoom checks will read "not measured".');
}
//: The camera maths never touches the video, but the compiler rightly refuses a
//: ref the canvas could not place, so the placeholder has to be well-formed.
const PLACEHOLDER_REF = '/api/v2/images/ref/00000000-0000-0000-0000-000000000000';

const args = process.argv.slice(2);
const outDir = args[0];
const id = args[1];
const num = (flag, dflt) => {
  const i = args.indexOf(flag);
  return i >= 0 ? Number(args[i + 1]) : dflt;
};
const MAX_ROUNDS = num('--rounds', 4);
const TARGET = num('--target', 8);
const ALLOW_RECAPTURE = args.includes('--allow-recapture');

if (!outDir || !id) {
  console.error('usage: node iterate.mjs <outDir> <id> [--rounds N] [--target S] [--allow-recapture]');
  process.exit(2);
}

const sh = (c, a, env = {}) =>
  execFileSync(c, a, { encoding: 'utf8', maxBuffer: 64 << 20, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'inherit'] });

const docPath = `${outDir}/${id}.moda.json`;
const readDoc = () => JSON.parse(readFileSync(docPath, 'utf8'));

/**
 * Emit the camera program WITHOUT publishing.
 *
 * The page and node ids are placeholders: the camera maths reads the timeline
 * and the viewport, never the canvas it will be attached to. This is what makes
 * a camera round cost seconds instead of an upload.
 */
function emitMotion() {
  if (!PY) return false;
  try {
    sh(PY, ['compile.py', 'motion', docPath, PLACEHOLDER_REF, 'p_iter', 'n_iter', `${outDir}/${id}.motion.js`]);
    // TRUE means the compile RAN, not that it wrote a camera — which is exactly
    // what the flat-take finding needs: a compiler that looked and planned no
    // punch-ins is a finding, one that never ran is unmeasured. `wrote_camera`
    // in the JSON says which of those happened for the FILE, and the caller
    // learns the same thing from whether the file now exists, so it is not read
    // here.
    return true;
  } catch {
    return false;
  }
}

/** Did a camera compile actually run this round? Drives the flat-take finding. */
let cameraAttempted = false;

/** Which stage owns a model finding, by its own suggested fix and its type. */
function ownerOf(issue) {
  if (issue.stage) return issue.stage;                       // countable ones say so
  if (issue.fix === 'speed_up' || issue.fix === 'shorten_narration') return 'pacing';
  if (issue.fix === 'disable_zoom' || issue.type === 'result_cropped') return 'camera';
  if (issue.type === 'no_visible_change' || issue.type === 'blank_screen') return 'pacing';
  return 'flow';
}

const history = [];
let compressSpeed = Number(process.env.DEMO_COMPRESS_SPEED) || 6;

// HILL-CLIMB, DO NOT JUST DESCEND. The first version applied a fix every round
// and kept whatever came out. Run on a real take it drove the score 5 -> 3 -> 3
// while the countable findings fell from six to three: cutting idle gaps harder
// and harder does retire "no_visible_change" findings, and it also makes the
// video feel rushed, which the model then marks down for different reasons.
//
// A loop that optimises its own checklist and hands back a worse artifact is
// worse than no loop, so every round is compared against the best seen and a
// regression is REVERTED rather than built on. Reverting is cheap only because
// the take itself is now immutable — `.source.mp4` — so re-cutting at the old
// speed reproduces the old output exactly.
let best = null;

// WHICH ACTIONS HAVE HAD THEIR PUNCH-IN DROPPED, kept here rather than in the
// doc, because the doc is not durable: `finish.mjs` regenerates
// `<id>.moda.json` from the timeline on every run. The camera lane edited that
// file directly and the next round's pacing fix silently reverted it, so a
// suppression only ever survived until the next re-cut — the loop was undoing
// its own work and then re-finding the same finding.
const suppressed = new Set();

/** Re-apply every suppression to the freshly regenerated doc, then re-emit. */
function applySuppressions() {
  if (suppressed.size) {
    const doc = readDoc();
    for (const a of doc.actions) if (suppressed.has(a.index)) { delete a.clickX; delete a.clickY; }
    writeFileSync(docPath, JSON.stringify(doc, null, 2));
  }
  return emitMotion();
}

/** Re-cut from the immutable source, then put the suppressions back. */
function refinish(speed) {
  sh('node', ['finish.mjs', outDir, id], { DEMO_COMPRESS_SPEED: String(speed) });
  applySuppressions();
}

const snapshot = () => ({ speed: compressSpeed, suppressed: new Set(suppressed) });
const restore = (snap) => {
  compressSpeed = snap.speed;
  suppressed.clear();
  for (const i of snap.suppressed) suppressed.add(i);
  refinish(snap.speed);
};

for (let round = 1; round <= MAX_ROUNDS; round++) {
  if (!existsSync(`${outDir}/${id}.motion.js`)) cameraAttempted = emitMotion();
  else cameraAttempted = true;
  console.log(`\n── round ${round} ─────────────────────────────────────────────`);
  sh('node', ['critique-take.mjs', outDir, id, ...(cameraAttempted ? ['--camera-attempted'] : [])]);

  const critique = JSON.parse(readFileSync(`${outDir}/critique.json`, 'utf8'));
  const all = [...(critique.shots ?? []), ...(critique.issues ?? []).filter((i) => i.severity !== 'low')];
  const byStage = {};
  for (const i of all) (byStage[ownerOf(i)] ??= []).push(i);
  history.push({ round, score: critique.score, stages: Object.fromEntries(Object.entries(byStage).map(([k, v]) => [k, v.length])) });

  if (best && critique.score < best.score) {
    console.log(`\n  round ${round} scored ${critique.score}/10, below the best of ${best.score}/10 — reverting and stopping.`);
    console.log('    the fixes applied since then made the video worse, not better.');
    restore(best.snap);
    break;
  }
  if (!best || critique.score > best.score) {
    best = { score: critique.score, round, snap: snapshot(), issues: critique.issues ?? [] };
  }

  console.log(`\n  round ${round}: ${critique.score}/10 — ` +
    (all.length ? Object.entries(byStage).map(([s, v]) => `${v.length} ${s}`).join(', ') : 'nothing actionable'));

  if (critique.score >= TARGET) { console.log(`  reached the target (${TARGET}). Stopping.`); break; }
  if (!all.length) { console.log('  nothing left this loop can act on. Stopping.'); break; }
  // A plateau is a stop, not a reason for another round: the same finding
  // surviving a fix means the fix was not the right one, and repeating it just
  // spends time. The user sees the plateau and picks the expensive lever.
  if (history.length >= 3 && history.at(-1).score <= history.at(-3).score) {
    console.log('  the score has not improved in two rounds. Stopping.');
    break;
  }
  if (round === MAX_ROUNDS) { console.log('  out of rounds.'); break; }

  // EVERY cheap fix this round, not the first one that matches. Pacing was
  // checked first and always had something, so three camera findings went
  // untouched for three rounds while the score sat still — and the plateau
  // detector then stopped a loop that had never tried its other lever.
  const acted = [];
  if (byStage.pacing?.length) {
    compressSpeed = Math.min(14, compressSpeed + 3);
    console.log(`  → pacing: re-cutting idle gaps at ${compressSpeed}x (no re-record)`);
    refinish(compressSpeed);
    acted.push('pacing');
  }
  if (byStage.camera?.length) {
    // Suppress the punch-in on the offending actions by removing their click
    // location: `has_location` is what gates a zoom plan in the compiler, so a
    // located action always gets one. A wide shot of a legible page beats a
    // tight shot framed off the thing that changed.
    const doc = readDoc();
    const targets = new Set();
    for (const i of byStage.camera) {
      for (const m of String(i.detail ?? '').matchAll(/"action":(\d+)/g)) targets.add(Number(m[1]));
      if (i.atSeconds != null) {
        const near = doc.actions.filter((a) => a.clickSec != null)
          .sort((a, b) => Math.abs(a.clickSec - i.atSeconds) - Math.abs(b.clickSec - i.atSeconds))[0];
        if (near) targets.add(near.index);
      }
    }
    if (!targets.size) {
      console.log('  → camera: no finding named an action specifically enough to act on');
    } else {
      for (const i of targets) suppressed.add(i);
      console.log(`  → camera: dropping the punch-in on action(s) ${[...suppressed].sort((a, b) => a - b).join(', ')} and re-emitting (no re-record)`);
      if (applySuppressions()) acted.push('camera');
      else console.log('    could not re-emit the camera program');
    }
  }
  if (!acted.length && ALLOW_RECAPTURE) {
    console.log(`  → ${Object.keys(byStage).join('/')}: needs a re-record, which this loop does not do yet. Stopping.`);
    break;
  } else if (!acted.length) {
    console.log(`  → the remaining findings belong to ${Object.keys(byStage).join(' and ')}, which needs a re-record.`);
    console.log('    re-run with --allow-recapture once that is wired, or fix the flow and re-take.');
    break;
  }
  console.log(`  applied: ${acted.join(' + ')} — re-critiquing.`);
}

if (best) {
  console.log(`\n  kept round ${best.round}'s cut (${best.score}/10)`);
  // WRITE DOWN WHICH CUT SURVIVED. `critique.json` holds the LAST critique,
  // and after a revert that describes a video which was thrown away — a run
  // that kept round 1's 3/10 reported 2/10, the score of the round it undid.
  // The number has to describe the artifact on disk.
  // The findings go with the score. They describe the SAME cut, and run.mjs
  // feeds them back into discovery as guidance for a re-record — so findings
  // from a cut that was thrown away would send the expensive lane chasing
  // defects that are not in the video anyone will watch.
  writeFileSync(`${outDir}/iterate.json`, JSON.stringify({
    keptRound: best.round, score: best.score, issues: best.issues ?? [], rounds: history,
  }, null, 2));
}
console.log('\n  history:');
for (const h of history) console.log(`    round ${h.round}: ${h.score}/10  ${JSON.stringify(h.stages)}`);
