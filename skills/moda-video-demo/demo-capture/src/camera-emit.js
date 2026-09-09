// Re-emit the camera program between takes, wherever the planner lives.
//
// The loop grades and tunes the camera: score it, suppress a punch-in, re-cut,
// re-plan. With a studio checkout that runs the compiler from source; without
// one it goes through `moda demo camera`, which is the same planner publish uses.
//
// THE FILE IS THE SIGNAL, so it has to be authoritative. Neither planner writes
// anything when it plans nothing — `compile.py motion` writes only
// `if result.zoom_ops`, and the verb only on a non-empty program — so once
// suppressions have removed every punch-in, last round's program would survive
// on disk. `checkShots` would then grade zoomSync and zoomFraming for punch-ins
// that no longer exist, never reach the flat-take finding, and the hill-climb
// would keep or revert a cut on the strength of a camera it does not have.
const { rmSync } = require('node:fs');

/**
 * Clear the output, then plan into it.
 *
 * `run` does the planning and throws on failure. It may RETURN the planner's
 * stdout, which the server lane emits as JSON; the compile.py lane returns
 * nothing and that is a legitimate "unknown", not a failure.
 *
 * Returns `{ ran, report }`. `ran` is whether the planner RAN — not whether it
 * wrote a camera, which is exactly the distinction the flat-take finding needs:
 * a planner that looked and planned nothing is a finding, one that never ran is
 * unmeasured. The caller reads which happened off the file's existence, which is
 * why the clear has to come first.
 *
 * An OBJECT, deliberately, even though every caller previously wanted the
 * boolean: an empty camera program has more than one cause and the old return
 * could not tell them apart (ENG-6128). Callers must read `.ran` — an object is
 * always truthy, so a missed call site would silently read as success, and
 * `test/checks.test.js` guards the ones in iterate.mjs for that reason.
 */
function emitCameraInto(out, run) {
  rmSync(out, { force: true });
  try {
    const stdout = run(out);
    return { ran: true, report: parseCameraReport(stdout) };
  } catch {
    return { ran: false, report: null };
  }
}

/**
 * What the planner said, from the verb's `--json` stdout.
 *
 * `planned` is what the COMPILER wanted; `camera_program` is what survived. The
 * server publishes both precisely so a caller can tell a FLAT take (planned
 * nothing) from a HELD one (planned N, emitted none) — its own comment says
 * they must not be reported alike, and until ENG-6128 this lane reported them
 * alike because it dropped the body on the floor.
 *
 * Null when there is nothing to parse: the compile.py lane writes a file and
 * returns no JSON, and "I was not told" is a third state that must stay
 * distinguishable from both of the above.
 */
function parseCameraReport(stdout) {
  if (typeof stdout !== 'string' || !stdout.trim()) return null;
  const line = stdout.trim().split('\n').filter((l) => l.trim().startsWith('{')).pop();
  if (!line) return null;
  let body;
  try {
    body = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof body.planned !== 'number') return null;
  return {
    planned: body.planned,
    // PROGRAMS, not punch-ins. `MotionCodeZoomEmitter.emit` sets `_ops = [src]`
    // — one string carrying the whole merged path — so this is 0 or 1 in
    // practice and must never be subtracted from `planned`, which counts
    // punch-ins. Named for what it holds so the next reader cannot mistake it.
    programs: Array.isArray(body.camera_program) ? body.camera_program.length : 0,
    warnings: Array.isArray(body.warnings) ? body.warnings : [],
  };
}

/** The verb's arguments, with the located actions accepted as publish accepts them. */
function cameraVerbArgs(docPath, out, doc) {
  // A punch-in planned from an INFERRED click is held unless its index is
  // accepted, and the capture's clicks are observed. Without this every plan
  // comes back held and the loop sees a camera-less take that publish would
  // happily zoom.
  const located = (doc?.actions ?? []).filter((a) => a.clickX != null).map((a) => a.index);
  const args = ['demo', 'camera', '--timeline', docPath, '-o', out, '--json'];
  if (located.length) args.push('--accept-zoom', located.join(','));
  return args;
}

/**
 * Where the planner's report lives, for the process that reads it.
 *
 * ONE definition because it is a contract between two processes: `iterate.mjs`
 * writes it and `critique-take.mjs` reads it, and if the two literals ever
 * disagree the read simply misses, the reader's catch swallows it, and the
 * checker reverts to "the planner did not report why" on every take — a silent
 * fail-open of exactly the deadness this lane keeps having to remove.
 */
function cameraPlanPath(outDir, id) {
  return `${outDir}/${id}.camera-plan.json`;
}

module.exports = { emitCameraInto, cameraVerbArgs, parseCameraReport, cameraPlanPath };
