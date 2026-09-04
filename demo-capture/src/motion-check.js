// Did the page SCROLL, and if so did it scroll or teleport?
//
// The one class of defect the frame-based critique structurally cannot see: it
// samples ~1 still per second, so a one-frame discontinuity falls between
// samples, and it is told not to judge motion because stills cannot support it.
// Found by a person watching — "the critique didn\'t catch the choppy scroll at
// the very beginning" — then measured: the page moved 424px in a single frame.
//
// TWO EARLIER ATTEMPTS WERE WRONG, both worth recording because each looked fine.
//
//   1. Track the topmost saturated row. Worked on the gradient tool, reported
//      "nothing trackable" on the QR tool, which is a white page. Honest, but it
//      covered almost nothing.
//   2. Flag frames whose YDIF spikes above the median. Caught the real teleport
//      and also flagged ELEVEN "jumps" on the QR demo — every keystroke, because
//      a QR code regenerates completely per character. A big single-frame change
//      is not the same thing as a scroll, and treating them alike makes the
//      check useless on exactly the pages a demo is made of.
//
// What actually separates them is DISPLACEMENT. `scale=1:H` collapses each row
// to its mean, giving a per-frame row signature; a scroll shifts that signature
// bodily, while typing perturbs it in place. So the signatures are
// cross-correlated and the best shift is the scroll distance. Typing scores a
// best shift of 0 however much it changes.
const { spawnSync } = require('node:child_process');
const { ffmpeg: FFMPEG, ffprobe: FFPROBE } = require('./bin.js');

const H = 800;
//: A single frame displacing more than this reads as a cut, not a move.
const JUMP_PX = 100;
//: The shift must explain the change: the residual at the best offset has to
//: beat the residual at zero by this much, or it is content changing in place.
const EXPLAINS = 0.6;
//: How far to search. A scroll larger than this is a jump by any measure.
const MAX_SHIFT = 320;

/** Per-frame row signature: the mean luma of every row. */
function rowSignatures(videoPath, { from = 0, seconds = 6, fps = 30 } = {}) {
  const r = spawnSync(
    FFMPEG,
    ['-v', 'error', '-ss', String(from), '-t', String(seconds), '-i', videoPath,
     '-vf', `fps=${fps},scale=1:${H}`, '-f', 'rawvideo', '-pix_fmt', 'gray', '-'],
    { maxBuffer: 256 << 20 }
  );
  const buf = r.stdout;
  if (!buf || buf.length < H) return [];
  const frames = [];
  for (let o = 0; o + H <= buf.length; o += H) frames.push(buf.subarray(o, o + H));
  return frames;
}

/** Mean absolute difference between two signatures at a vertical offset. */
function residual(a, b, shift) {
  const lo = Math.max(0, -shift);
  const hi = Math.min(H, H - shift);
  if (hi - lo < H * 0.4) return Infinity; // too little overlap to trust
  let sum = 0;
  for (let y = lo; y < hi; y++) sum += Math.abs(a[y + shift] - b[y]);
  return sum / (hi - lo);
}

/**
 * Vertical displacement per frame, and any that are discontinuities.
 *
 * Returns `{ ok, frames, shifts, jumps }`; each jump is `{ frame, px }`.
 */
function checkMotion(videoPath, opts = {}) {
  const sigs = rowSignatures(videoPath, opts);
  if (sigs.length < 5) return { ok: false, reason: `only ${sigs.length} frames decoded` };

  const shifts = [];
  for (let i = 1; i < sigs.length; i++) {
    const zero = residual(sigs[i - 1], sigs[i], 0);
    let best = 0;
    let bestRes = zero;
    for (let s = -MAX_SHIFT; s <= MAX_SHIFT; s += 2) {
      if (s === 0) continue;
      const res = residual(sigs[i - 1], sigs[i], s);
      if (res < bestRes) { bestRes = res; best = s; }
    }
    // Only call it a displacement if the shift EXPLAINS the change. Content
    // changing in place has a best shift that barely beats zero.
    shifts.push(best !== 0 && bestRes < zero * EXPLAINS ? best : 0);
  }
  const jumps = shifts
    .map((px, frame) => ({ frame, px }))
    .filter((j) => Math.abs(j.px) > JUMP_PX);
  //: `moving` is what the all-clear line reports. It was being read off an
  //: object that never had the key, so a clean run printed "undefined/179
  //: frames moving" — the REASSURING branch announcing success with a
  //: nonsense number, which is the worst place for a typo to hide.
  const moving = shifts.filter((px) => px !== 0).length;
  return { ok: true, frames: shifts.length, shifts, moving, jumps };
}

module.exports = { checkMotion, JUMP_PX };
