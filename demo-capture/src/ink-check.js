// Did the page's CONTENT survive to the end of the take?
//
// The defect this exists for: on the markdown publisher, the last third of a
// recording showed an entirely blank preview pane. The document was fine — DOM
// text present, and the same click reproduced perfectly in a plain browser, in a
// plain Playwright video, and with the capture's cursor overlay injected. It
// blanks only under the full capture, and I could not find the cause.
//
// So this does not try to. It asks the one question that makes the cause
// irrelevant: is there LESS on screen at the end than there was at the start?
// A demo may legitimately restyle, recolour, scroll or navigate, but a demo
// whose final frame carries substantially less ink than its first has lost
// something, whatever the reason — a crashed subtree, a failed render, a
// navigation to an error page, content scrolled out of frame.
//
// Every other signal was happy about that take: the selectors resolved, both
// clicks changed large regions, the net first-to-last change was large (blank IS
// a big change), no step was a no-op. "Changed a lot" is not "changed to
// something good", and this is the cheap half of that distinction.
const { spawnSync } = require('node:child_process');
const { ffmpeg: FFMPEG, ffprobe: FFPROBE } = require('./bin.js');

const W = 160;
const H = 100;
//: How far a pixel must sit from the frame's own background level to count as
//: ink. Low enough to count body text, high enough to ignore compression noise.
const INK_DELTA = 14;
//: The frame is scored as a grid, not as one number. A whole-frame ink ratio
//: was tried first and could not discriminate: on the take whose entire preview
//: pane was blank for the last third, total ink fell only to 0.69 of the
//: opening frame, because the pane is a minority of the screen and the editor
//: beside it was untouched. Any floor that caught it would have been fitted to
//: that one video. A REGION going blank is the actual defect, so regions are
//: what get measured.
const COLS = 8;
const ROWS = 5;
//: A cell needs this much ink to start with, or it is background and its going
//: blank means nothing.
const CELL_MIN_INK = 0.04;
//: A cell that keeps less than this share of its ink has emptied out.
const CELL_KEPT = 0.2;
//: Flag when this share of the frame's inked cells have emptied out.
const BLANK_SHARE = 0.25;

/** One frame, decoded to a small grayscale buffer. */
function frameAt(videoPath, seconds) {
  const r = spawnSync(
    FFMPEG,
    ['-v', 'error', '-ss', String(Math.max(0, seconds)), '-i', videoPath,
     '-vf', `scale=${W}:${H}`, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'gray', '-'],
    { maxBuffer: 8 << 20 }
  );
  return r.stdout && r.stdout.length >= W * H ? r.stdout.subarray(0, W * H) : null;
}

/**
 * Ink = pixels that differ from the frame's own background level.
 *
 * The background is the MODE, not the mean: a dark theme and a light theme have
 * opposite means but the same amount of ink, and the whole point of a restyle
 * demo is that the background changes. Taking the most common value makes the
 * measure theme-independent.
 */
function backgroundOf(buf) {
  const hist = new Uint32Array(256);
  for (const v of buf) hist[v]++;
  let mode = 0;
  for (let v = 1; v < 256; v++) if (hist[v] > hist[mode]) mode = v;
  return mode;
}

function inkOf(buf) {
  const mode = backgroundOf(buf);
  let ink = 0;
  for (const v of buf) if (Math.abs(v - mode) > INK_DELTA) ink++;
  return ink / buf.length;
}

/** Ink per grid cell, using the WHOLE frame's background level. */
function cellInk(buf) {
  const mode = backgroundOf(buf);
  const cells = [];
  const cw = Math.floor(W / COLS);
  const ch = Math.floor(H / ROWS);
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      let ink = 0;
      let n = 0;
      for (let y = r * ch; y < (r + 1) * ch; y++) {
        for (let x = c * cw; x < (c + 1) * cw; x++) {
          n++;
          if (Math.abs(buf[y * W + x] - mode) > INK_DELTA) ink++;
        }
      }
      cells.push(n ? ink / n : 0);
    }
  }
  return cells;
}

/**
 * Compare the first and last seconds of a take, region by region.
 *
 * Returns `{ ok, first, last, blankedCells, inkedCells, share, vanished }`.
 */
function checkInk(videoPath, durationSec) {
  const a = frameAt(videoPath, Math.min(1, durationSec * 0.1));
  const b = frameAt(videoPath, Math.max(0, durationSec - 0.6));
  if (!a || !b) return { ok: false, reason: 'could not decode both frames' };
  const first = inkOf(a);
  const last = inkOf(b);
  // A first frame with essentially no ink means the page had not painted yet;
  // the comparison would be meaningless, so say so rather than pass.
  if (first < 0.005) return { ok: false, reason: 'the opening frame is already blank — nothing to compare against' };

  const ca = cellInk(a);
  const cb = cellInk(b);
  let inkedCells = 0;
  let blankedCells = 0;
  for (let i = 0; i < ca.length; i++) {
    if (ca[i] < CELL_MIN_INK) continue;
    inkedCells++;
    if (cb[i] < ca[i] * CELL_KEPT) blankedCells++;
  }
  const share = inkedCells ? blankedCells / inkedCells : 0;
  return { ok: true, first, last, inkedCells, blankedCells, share, vanished: share >= BLANK_SHARE };
}

module.exports = { checkInk, BLANK_SHARE };
