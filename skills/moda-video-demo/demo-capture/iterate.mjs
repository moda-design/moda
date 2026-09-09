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
// ONE definition of the ceiling, shared with the checker that measures what a
// bump toward it would return (ENG-6149).
const { MAX_SPEED } = require('./src/compress.js');
const { emitCameraInto, cameraVerbArgs, cameraPlanPath } = require('./src/camera-emit.js');
// OPTIONAL — it decides WHERE the camera is planned, not whether it is.
//
// Re-emitting the camera without publishing is what makes a camera fix cost
// seconds instead of an upload. With a checkout that runs the compiler from
// source; without one it goes through the server, which runs the same planner
// publish does. The loop grades and tunes the camera either way.
let PY = null;
try {
  PY = studioPython();
  if (!existsSync(PY)) PY = null;
} catch {
  PY = null;
}
if (!PY) {
  console.log('  note: no studio checkout — planning the camera on the server instead (same planner as publish).');
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
//: What the camera planner reported, for the checker in the next process.
//: One definition, shared with the reader — see `cameraPlanPath`.
const planPath = cameraPlanPath(outDir, id);
const readDoc = () => JSON.parse(readFileSync(docPath, 'utf8'));

/**
 * Emit the camera program WITHOUT publishing.
 *
 * The page and node ids are placeholders: the camera maths reads the timeline
 * and the viewport, never the canvas it will be attached to. This is what makes
 * a camera round cost seconds instead of an upload.
 */
function emitMotion() {
  const out = `${outDir}/${id}.motion.js`;
  const { ran, report } = emitCameraInto(out, () => {
    if (PY) {
      sh(PY, ['compile.py', 'motion', docPath, PLACEHOLDER_REF, 'p_iter', 'n_iter', out]);
      // No JSON on this lane — the report stays null and the checker says it was
      // not told, rather than inventing a reason (ENG-6128).
      return;
    }
    // NO STUDIO CHECKOUT — plan it on the server, through the same planner
    // publish uses. Without this the loop could not see the camera at all: it is
    // emitted at publish and the loop runs before it, so four of six shot checks
    // read "not measured" and framing could be reported afterwards but never
    // tuned.
    return sh('moda', cameraVerbArgs(docPath, out, readDoc()));
  });
  // WRITE DOWN WHAT THE PLANNER SAID. `critique-take.mjs` is a separate process,
  // so a boolean flag is all that used to cross the boundary — and an empty
  // camera program has more than one cause. Persisted beside the take so the
  // checker can report the reason it was GIVEN.
  writeFileSync(planPath, JSON.stringify(report ?? null, null, 2));
  // `.ran`, never the object: it is always truthy, and both call sites below
  // branch on this.
  return ran;
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

// THE DOC AS `finish.mjs` LAST GENERATED IT, before any suppression.
//
// Suppressing is DESTRUCTIVE — it deletes `clickX`/`clickY` — so a function that
// edits the file in place can only ever remove punch-ins, never bring one back.
// Rebuilding from a pristine base instead makes the suppression set fully
// re-derivable, which is what lets a restore go in both directions without
// paying for a re-cut. `run.mjs` runs `finish.mjs` immediately before this
// script, so the doc on disk is un-suppressed when the base is first read.
let baseDoc = null;
const pristineDoc = () => (baseDoc ??= readDoc());

/** Write the doc with exactly the CURRENT suppression set applied, then re-emit. */
function applySuppressions() {
  // Unconditional, including when the set is empty: restoring TO zero
  // suppressions has to rewrite the doc, and skipping that was how an
  // un-suppression silently did nothing.
  const doc = structuredClone(pristineDoc());
  for (const a of doc.actions) if (suppressed.has(a.index)) { delete a.clickX; delete a.clickY; }
  writeFileSync(docPath, JSON.stringify(doc, null, 2));
  return emitMotion();
}

/** Re-cut from the immutable source, then put the suppressions back. */
function refinish(speed) {
  sh('node', ['finish.mjs', outDir, id], { DEMO_COMPRESS_SPEED: String(speed) });
  // `finish.mjs` regenerates the doc from the timeline, so what it just wrote is
  // the new pristine base — re-cache it BEFORE re-applying, or the next rebuild
  // would restore a doc cut at the old speed.
  baseDoc = readDoc();
  applySuppressions();
}

const snapshot = () => ({ speed: compressSpeed, suppressed: new Set(suppressed) });
const restore = (snap) => {
  // A SPEED change is the only thing that needs the picture re-cut. Suppressions
  // live in the doc and the motion program, so putting them back is a doc
  // rewrite plus a re-emit — and going through `finish.mjs` for them would
  // re-run narration TTS and regenerate the music bed (a metered render),
  // replacing audio the critique already scored for no reason at all.
  const recut = compressSpeed !== snap.speed;
  compressSpeed = snap.speed;
  suppressed.clear();
  for (const i of snap.suppressed) suppressed.add(i);
  if (recut) refinish(snap.speed);
  else applySuppressions();
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
    // The revert itself happens on the way OUT, with every other exit — see the
    // restore below. Doing it here too was the shape that hid ENG-6103's sibling
    // bug: it made the regression path look like the only one that could leave
    // the wrong cut on disk, when in fact it was the only one that could not.
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
    compressSpeed = Math.min(MAX_SPEED, compressSpeed + 3);
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
  // THE ARTIFACT MUST BE THE CUT WE SAY WE KEPT — on every exit, not just the
  // one that remembered to ask (ENG-6104).
  //
  // Reverting used to live in the regression branch alone, which left a tie
  // shipping the wrong video: the revert is `score < best.score` and the re-best
  // is `score > best.score`, so a round that scores EXACTLY the best does
  // neither — `best` still points at the earlier round while disk holds the
  // later one, including punch-in suppressions the winning round never had.
  // `iterate.json` then described a cut nobody would watch, and `run.mjs` fed
  // its findings back into discovery as guidance for a re-record.
  //
  // GUARDED, NOT UNCONDITIONAL, and the guard is exact rather than a heuristic:
  // `refinish` is the only thing that rewrites the artifact and it is driven
  // entirely by these two values, so equal state means the files on disk already
  // ARE best's. Re-running would be strictly worse than skipping, because
  // `restore` does NOT reproduce the same bytes — `finish.mjs` re-runs narration
  // TTS and calls `generateBed` → `moda media generate-audio`, a metered
  // generative render, so a needless restore both costs money on every demo run
  // and ships a cut whose audio no critique ever scored. That is the same class
  // of mismatch this block exists to remove.
  const dirty =
    compressSpeed !== best.snap.speed ||
    suppressed.size !== best.snap.suppressed.size ||
    [...suppressed].some((i) => !best.snap.suppressed.has(i));

  // Whether the artifact on disk is provably the cut named below. Recorded
  // rather than assumed: `restore` shells out to `finish.mjs` through
  // `execFileSync`, which THROWS, and this now runs on a path that previously
  // could not fail. Letting it escape would lose the report entirely and take
  // down a run that had already spent minutes recording — but silently claiming
  // the cut anyway would be a lie about what is on disk. So: say which happened.
  let reconciled = true;
  if (dirty) {
    try {
      restore(best.snap);
    } catch (e) {
      reconciled = false;
      console.log(`\n  WARNING: could not re-cut round ${best.round}'s version — ${String(e.message).split('\n')[0].slice(0, 120)}`);
      console.log('    the report below describes that round; the video on disk is a LATER cut.');
    }
  }
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
    // Always present, never inferred from its absence: a consumer has to be able
    // to tell "the artifact is this cut" from "we could not make it so".
    keptRound: best.round, score: best.score, reconciled, issues: best.issues ?? [], rounds: history,
  }, null, 2));
}
console.log('\n  history:');
for (const h of history) console.log(`    round ${h.round}: ${h.score}/10  ${JSON.stringify(h.stages)}`);
