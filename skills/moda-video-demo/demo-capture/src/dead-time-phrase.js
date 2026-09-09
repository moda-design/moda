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
 * `seconds` is what the viewer waits through, `share` is the part a speed bump
 * would actually return, and `protectedWait` is the rest. NOT "what the
 * compressor keeps at 1x": near the cap most of it is already-sped gap with no
 * headroom left, which is a different cause and a different remedy. Narration
 * is called out separately because a reader told a voiceover hold is "the
 * reveal beat" will draw the wrong conclusion.
 */
function deadTimePhrase(deadTime, durationSec) {
  const d = deadTime ?? {};
  const total = durationSec > 0 ? (d.seconds ?? 0) / durationSec : 0;
  const held = (d.narrationHeld ?? 0) > 0.05
    ? `, ${d.protectedWait.toFixed(1)}s of it beyond any speed fix ` +
      `(${d.narrationHeld.toFixed(1)}s of that held at 1x by narration)`
    : (d.protectedWait ?? 0) > 0
      // NOT "kept at 1x". Past the cap this is mostly already-sped gap with no
      // headroom left, not a protected region — the old parenthetical asserted
      // the wrong cause and sent the reader looking for a protection that is
      // not there.
      ? `, ${d.protectedWait.toFixed(1)}s of it beyond any speed fix`
      : '';
  // "A SPEED BUMP COULD REMOVE", and now the number means it (ENG-6149). The
  // share is the difference between re-cutting the SOURCE at this round's speed
  // and at the cap — what the remedy actually returns — not the gap that
  // survived this round's compression, which the label had to hedge around
  // while it was measured on the finished cut.
  // SAY WHEN WE WERE NOT TOLD. Without the narration record the recoverable
  // share is computed as though nothing was spoken, so it reads high — and a
  // number presented without that caveat is the overclaim this ticket removes,
  // reappearing as a silent default.
  const caveat = d.narrationKnown === false
    ? ' — no narration record for this take, so the recoverable share is measured as if nothing was spoken'
    : '';
  // TWO records, TWO caveats, said separately. Missing narration inflates the
  // protection set; a missing compression record means the share is the gap
  // that survived rather than what a bump returns. They are different wrongness
  // and collapsing them would let a reader fix the wrong one.
  const basis = d.compressionKnown === false
    ? ' — no compression record for this take, so the share is the wait that survived this cut rather than what another speed would return'
    : '';
  return `${pct(total)} of the runtime is the product thinking (${pct(d.share ?? 0)} a speed bump could still remove${held})${caveat}${basis}`;
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

/**
 * The machine-readable `dead_time` detail, as the loop and the operator read it.
 *
 * A FUNCTION for the same reason `deadTimePhrase` is one: this string is what
 * lands in the critique JSON, and unlike the console sentence it carries no
 * caveat of its own — so the one place it can overclaim needs a test that runs
 * it, not a grep for the condition.
 */
function deadTimeDetail(deadTime, maxSpeed) {
  const d = deadTime ?? {};
  return d.compressionKnown
    ? `${pct(d.share ?? 0)} of the runtime is wait that a re-cut at a higher compress speed would ` +
      `remove (the whole of it, up to the ${maxSpeed}x cap; see ENG-6149)`
    : `${pct(d.share ?? 0)} of the runtime is wait that survived this cut — measured without a ` +
      'compression record, so this is not what another speed would return (see ENG-6149)';
}

/**
 * Where the compression the take actually got is recorded.
 *
 * The SPEED is the point. `finish.mjs` is handed it as `DEMO_COMPRESS_SPEED`
 * and `iterate.mjs` bumps it per round, but nothing downstream is told — the
 * critique runs in another process and `iterate.mjs` does not pass the env on.
 * Asking "how much would another bump return?" against a guessed 6x is the
 * overclaim this seam keeps producing, so the answer is written down rather
 * than assumed. Same one-definition rule as `narrationPath` above, for the
 * same reason.
 */
function compressionPath(outDir, id) {
  return `${outDir}/${id}.compression.json`;
}

module.exports = { deadTimePhrase, deadTimeDetail, pct, narrationPath, compressionPath };
