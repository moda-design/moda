// Can the captions actually be READ?
//
// The genre judge picks tutorial about half the time, and on that branch the
// video carries on-screen text — but not one of the countable checks looked at
// it. They are all camera, pacing and content. A caption could be twice too
// long for its window, or flash for a third of a second, and every signal in
// the pipeline would report a clean take.
//
// The window is not a free variable: the compiler decides it, so these are
// questions about the TEXT against the time it is up. WHEN it is up is the
// compiler's invariant and is tested there — a runtime check here would have to
// recompute the compiler's own formula, which is the same tautology as a
// completeness header derived from the array it certifies. Verified against a real tutorial take — seven captions, each
// window matching its action exactly, no overlaps — so this is a guard on a
// working path rather than a fix for a broken one.

//: Characters per second of reading time. Subtitle practice puts the ceiling
//: around 17 for people who chose to read subtitles; a demo caption competes
//: with the thing it is describing, so the bar is lower.
const MAX_CHARS_PER_SEC = 14;
//: No caption is readable in a flash, however short. Subtitle minimums sit
//: near five-sixths of a second and that is about right here too.
const MIN_ON_SCREEN_SEC = 0.9;
//: Past this a caption is a sentence, and `captions.js` writes for the eye —
//: 2-6 words. A long one means the label came from somewhere else.
const MAX_CAPTION_CHARS = 48;

/**
 * Every readability problem in a take's captions.
 *
 * Returns `{ measured, captions, offenders, bad }`. `measured: false` when the
 * cut carries no captions at all, because "no unreadable captions" on a video
 * with none is the vacuous pass this pipeline keeps re-learning to avoid.
 */
function checkCaptions(doc) {
  const labelled = (doc.actions ?? []).filter((a) => (a.label ?? '').trim().length > 0);
  if (labelled.length === 0) {
    return { measured: false, reason: 'this cut carries no captions (marketing genre clears them)' };
  }

  const offenders = [];
  for (const a of labelled) {
    const text = a.label.trim();
    const onScreen = (a.endSec ?? 0) - (a.startSec ?? 0);
    if (onScreen < MIN_ON_SCREEN_SEC) {
      offenders.push({ action: a.index, text, kind: 'unreadable', why: `on screen ${onScreen.toFixed(2)}s, under the ${MIN_ON_SCREEN_SEC}s floor` });
      continue;
    }
    const cps = text.length / onScreen;
    if (cps > MAX_CHARS_PER_SEC) {
      offenders.push({ action: a.index, text, kind: 'unreadable', why: `${text.length} chars in ${onScreen.toFixed(2)}s = ${cps.toFixed(1)}/sec, over ${MAX_CHARS_PER_SEC}` });
    } else if (text.length > MAX_CAPTION_CHARS) {
      offenders.push({ action: a.index, text, kind: 'unreadable', why: `${text.length} chars — a caption is written for the eye, not read aloud` });
    }
  }
  return { measured: true, captions: labelled.length, offenders, bad: offenders.length > 0 };
}

module.exports = { checkCaptions, MAX_CHARS_PER_SEC, MIN_ON_SCREEN_SEC, MAX_CAPTION_CHARS };
