// Where the pipeline keeps what it must not lose: `~/.moda/demo-capture/`.
//
// Not the caller's working directory — that is usually THEIR project, whose
// `out/` is often a build output and is not ignored for our mp4s. And not beside
// the scripts: installed as a plugin, that directory is a per-version cache that
// an update replaces, taking an unpublished take (and the publish command
// run.mjs printed for it) and the saved session with it (ENG-6442).
const { mkdirSync, mkdtempSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const STATE_DIR = path.join(os.homedir(), '.moda', 'demo-capture');
const OUT_ROOT = path.join(STATE_DIR, 'out');
//: The saved session for a NON-local target. Local targets mint their own.
const PROD_STATE = path.join(STATE_DIR, 'auth.json');

/**
 * A NEW take directory, `<name>-<timestamp>-<random>`, created atomically: two
 * runs with one name in one millisecond must not share a take.
 */
function takeDir(name) {
  mkdirSync(OUT_ROOT, { recursive: true });
  return mkdtempSync(path.join(OUT_ROOT, `${name}-${new Date().toISOString().replace(/[:.]/g, '-')}-`));
}

module.exports = { OUT_ROOT, PROD_STATE, takeDir };
