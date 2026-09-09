// How the dead-time numbers are said out loud.
//
// A pure function taking the values rather than reading them, so a test can
// call THIS instead of re-typing the template. Three guards for this sentence
// were written before it moved here, and all three could pass while the report
// said something false: one grepped for a literal, one pinned a regex to syntax
// that had since been deleted, and one hand-built its own copy of the phrase
// and asserted against the copy. The sentence has been wrong twice — once
// reading a renamed-away field, once naming a closed list of causes the number
// does not match — so what it needs is a test that runs it, not another
// description of it.

const pct = (n) => `${(n * 100).toFixed(0)}%`;

/**
 * The dead-time sentence for one take.
 *
 * `deadTime` is `checkShots(...).deadTime`; `durationSec` is the cut's length.
 *
 * Three numbers, because collapsing them is what made this wrong before:
 * `seconds` is what the viewer waits through, `share` is the part a pacing fix
 * could remove, and `protectedWait` is the rest — everything the compressor
 * keeps at 1x, of which narration is called out separately because a reader
 * told a voiceover hold is "the reveal beat" will draw the wrong conclusion.
 */
function deadTimePhrase(deadTime, durationSec) {
  const d = deadTime ?? {};
  const total = durationSec > 0 ? (d.seconds ?? 0) / durationSec : 0;
  const held = (d.narrationHeld ?? 0) > 0.05
    ? `, ${d.protectedWait.toFixed(1)}s of it protected (${d.narrationHeld.toFixed(1)}s of that held by narration)`
    : (d.protectedWait ?? 0) > 0
      ? `, ${d.protectedWait.toFixed(1)}s of it protected (regions the compressor keeps at 1x)`
      : '';
  // "NOT STRUCTURALLY PROTECTED", not "recoverable by pacing". The share is
  // measured on the ALREADY-COMPRESSED cut, so it is the gap that survived this
  // round's compression — and the only lever, a speed bump capped at 14x,
  // returns a fraction of it: a 60s source gap is 10s here at 6x, and the next
  // bump gives back 3.3s. Measuring the achievable delta is ENG-6149; until
  // then the label says what the number is.
  // SAY WHEN WE WERE NOT TOLD. Without the narration record the recoverable
  // share is computed as though nothing was spoken, so it reads high — and a
  // number presented without that caveat is the overclaim this ticket removes,
  // reappearing as a silent default.
  const caveat = d.narrationKnown === false
    ? ' — no narration record for this take, so the recoverable share is measured as if nothing was spoken'
    : '';
  return `${pct(total)} of the runtime is the product thinking (${pct(d.share ?? 0)} not structurally protected${held})${caveat}`;
}

/**
 * Where the narration spans the compressor was given are recorded.
 *
 * ONE definition, for the reason `cameraPlanPath` is one: `finish.mjs` writes
 * this and `critique-take.mjs` reads it in another process, and two independent
 * literals mean a rename makes the read miss, the reader's catch swallows it,
 * and the checker silently measures as though nothing was spoken — overclaiming
 * the wait a pacing fix could remove, which is the bug this whole ticket is
 * about. ENG-6128 fixed exactly this shape for the camera plan; this file had
 * the same defect until the review caught it.
 */
function narrationPath(outDir, id) {
  return `${outDir}/${id}.narration.json`;
}

module.exports = { deadTimePhrase, pct, narrationPath };
