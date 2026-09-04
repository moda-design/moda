// Can you READ the thing the demo just produced?
//
// `ink-check.js` asks whether content survived — whether pixels still differ
// from the background. That is presence, not legibility, and it passed a demo
// whose payoff was a dark page with grey-on-navy body text: "content: intact —
// 0 of 26 inked regions emptied". The text was there. You could not read it.
//
// Legibility is LOCAL contrast, and it has to be measured inside the region the
// action changed. Measured across the whole frame it does not discriminate at
// all — the untouched editor pane, full of crisp text, swamps it: 29.2% before
// and 29.3% after, on a frame where the payoff had visibly washed out. Measured
// inside the payoff alone, the same pair reads 25.5% and 12.1%.
//
// The comparison is against what the payoff REPLACED, not against an absolute.
// A demo of a deliberately dim interface should not be flagged for being dim;
// what is worth flagging is a result you can read less well than the thing it
// came from.
const { spawnSync } = require('node:child_process');
const { ffmpeg: FFMPEG, ffprobe: FFPROBE } = require('./bin.js');

const W = 240;
const H = 180;
const TILE = 8;
//: A tile spanning less than this is flat — background, or text too faint to
//: separate from it.
const LEGIBLE_SPREAD = 60;
//: Below this share of the legible tiles it replaced, the payoff got harder to
//: read. Generous, because a restyle legitimately changes contrast.
const RETAINED = 0.6;
//: Under this many legible tiles to begin with there is no text to lose.
const MIN_BEFORE = 0.05;

/** Share of tiles inside `box` with enough internal contrast to read. */
function legibleTiles(videoPath, atSec, box) {
  const crop = `crop=in_w*${box.width}:in_h*${box.height}:in_w*${box.x}:in_h*${box.y}`;
  const r = spawnSync(FFMPEG, ['-v', 'error', '-ss', String(Math.max(0, atSec)), '-i', videoPath,
    '-vf', `${crop},scale=${W}:${H}`, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'gray', '-'],
    { maxBuffer: 8 << 20 });
  const b = r.stdout;
  if (!b || b.length < W * H) return null;
  let legible = 0;
  let seen = 0;
  for (let ty = 0; ty + TILE <= H; ty += TILE) {
    for (let tx = 0; tx + TILE <= W; tx += TILE) {
      let lo = 255;
      let hi = 0;
      for (let dy = 0; dy < TILE; dy++) {
        for (let dx = 0; dx < TILE; dx++) {
          const v = b[(ty + dy) * W + (tx + dx)];
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
      }
      seen++;
      if (hi - lo > LEGIBLE_SPREAD) legible++;
    }
  }
  return seen ? legible / seen : null;
}

/**
 * Payoffs that came out harder to read than what they replaced.
 *
 * Measured on the RAW take, whose coordinates match `resultBox` — the finished
 * cut has the camera baked in, so a normalized box no longer names the same
 * pixels.
 */
function checkLegibility({ rawVideo, doc }) {
  const acts = (doc.actions ?? []).filter((a) => a.resultBox && a.startSec != null && a.endSec != null);
  if (!acts.length) return { measured: false, reason: 'no action carries a measured result region' };

  const offenders = [];
  let compared = 0;
  for (const a of acts) {
    const before = legibleTiles(rawVideo, Math.max(0, a.startSec - 0.2), a.resultBox);
    const after = legibleTiles(rawVideo, Math.max(0, a.endSec - 0.3), a.resultBox);
    if (before == null || after == null) continue;
    if (before < MIN_BEFORE) continue; // nothing readable was there to lose
    compared++;
    if (after < before * RETAINED) {
      offenders.push({
        action: a.index,
        before: +(before * 100).toFixed(1),
        after: +(after * 100).toFixed(1),
      });
    }
  }
  if (!compared) return { measured: false, reason: 'no result region had readable content to compare' };
  return { measured: true, compared, offenders, bad: offenders.length > 0 };
}

module.exports = { checkLegibility, LEGIBLE_SPREAD, RETAINED };
