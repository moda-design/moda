// Where is the studio checkout whose compiler this pipeline drives?
//
// ONE implementation, because there were two and only one got fixed. `compile.py`
// learned to walk up and find the repo root; `publish-take.mjs` kept reading a
// `.studio` file and died with a bare ENOENT the first time the pipeline ran
// from its new home inside studio. The capture, the validate walk and the
// critique had all already passed by then — a "moved successfully" that was
// broken at the last step.
//
// Walking UP first means there is nothing to configure when this lives inside
// studio. `.studio` remains the escape hatch for running from outside a
// checkout, which is how this was developed.
const { existsSync, readFileSync } = require('node:fs');
const path = require('node:path');

/** The studio repo root. Throws with a usable message when there is none. */
function studioRoot(from = __dirname) {
  let dir = path.resolve(from);
  for (;;) {
    if (existsSync(path.join(dir, 'backend', 'app', 'services', 'demo_video'))) return dir;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  const pointer = path.join(path.resolve(from, '..'), '.studio');
  if (existsSync(pointer)) return readFileSync(pointer, 'utf8').trim();
  throw new Error(
    'no studio checkout found. Run from inside one, or put its path in a `.studio` file ' +
      'at the root of demo-capture.'
  );
}

/** The interpreter that can import the compiler. */
function studioPython(from = __dirname) {
  return path.join(studioRoot(from), 'backend', '.venv', 'bin', 'python');
}

module.exports = { studioRoot, studioPython };
