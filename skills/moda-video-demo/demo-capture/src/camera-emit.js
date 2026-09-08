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
 * `run` does the planning and throws on failure. Returns whether the planner
 * RAN — not whether it wrote a camera, which is exactly the distinction the
 * flat-take finding needs: a planner that looked and planned nothing is a
 * finding, one that never ran is unmeasured. The caller reads which happened
 * off the file's existence, which is why the clear has to come first.
 */
function emitCameraInto(out, run) {
  rmSync(out, { force: true });
  try {
    run(out);
    return true;
  } catch {
    return false;
  }
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

module.exports = { emitCameraInto, cameraVerbArgs };
