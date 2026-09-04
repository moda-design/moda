// Where ffmpeg and ffprobe are.
//
// The pipeline shells out to them 22 times, and until now the answer was "on
// your PATH" — a manual system install standing between someone and their first
// demo, and the kind of prerequisite people discover as a stack trace three
// minutes into a capture.
//
// Prefer a bundled binary when the package ships one, fall back to PATH so an
// in-repo checkout keeps working with the system copy, and report which was
// used so `doctor` can say something true rather than "should be fine".
const { existsSync } = require('node:fs');
const { spawnSync } = require('node:child_process');

/** The static package's path, or null when it is not installed. */
function bundled(pkg) {
  try {
    // These export a path string (ffmpeg-static) or { path } (ffprobe-static).
    const v = require(pkg);
    const p = typeof v === 'string' ? v : v && v.path;
    return p && existsSync(p) ? p : null;
  } catch {
    return null;
  }
}

/** Is this name runnable? */
function onPath(name) {
  const r = spawnSync(name, ['-version'], { encoding: 'utf8' });
  return !r.error;
}

function resolve(name, pkg) {
  const b = bundled(pkg);
  if (b) return { path: b, from: 'bundled' };
  if (onPath(name)) return { path: name, from: 'PATH' };
  return { path: null, from: 'missing' };
}

const FFMPEG = resolve('ffmpeg', 'ffmpeg-static');
const FFPROBE = resolve('ffprobe', 'ffprobe-static');

module.exports = {
  ffmpeg: FFMPEG.path ?? 'ffmpeg',
  ffprobe: FFPROBE.path ?? 'ffprobe',
  report: { ffmpeg: FFMPEG, ffprobe: FFPROBE },
};
