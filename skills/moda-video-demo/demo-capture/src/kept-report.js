// What an attempt's score and findings ARE, given what iterate.mjs reported.
//
// Its own function because three things read the same decision — the attempt's
// score, the findings that steer a re-discover, and whether the attempt may be
// selected and published — and a copy of the rule at each site is how they drift.
//
// The rule has one subtlety, and it is the reason the module exists:
// `iterate.json` can describe a cut that is NOT the one on disk. Its final
// re-cut shells out and can throw, and when it does, iterate keeps the winning
// round's score and findings while the files stay at a later round. It records
// that as `reconciled: false`. An attempt in that state must not be scored,
// must not steer a re-record, and must not be selected or published: ranking it
// would pick it on the strength of a video nobody has.

/**
 * The score and findings to use for one attempt.
 *
 * `kept` is the parsed `iterate.json` (or null when the loop never ran) and
 * `critique` the parsed `critique.json`. Returns `usable: false` for a report
 * that cannot back its own numbers — the caller must not rank or publish it.
 *
 * The kept cut's score wins over the last critique's, because after a revert the
 * last critique scored a video that was thrown away; the findings must come from
 * that SAME cut, or a re-discover chases defects that are not in the video.
 */
function keptReport({ kept, critique }) {
  if (kept?.reconciled === false) {
    return { usable: false, score: 0, issues: [] };
  }
  return {
    usable: true,
    score: kept?.score ?? critique?.score ?? 0,
    issues: kept?.issues ?? critique?.issues ?? [],
  };
}

/**
 * What the outer attempt loop should do after one attempt.
 *
 * Extracted for one reason: the ORDER of these checks is the whole decision, and
 * getting it wrong is invisible. An unusable attempt reports no findings — they
 * were dropped with it — and if the "no findings left" branch is reached first,
 * an empty list reads as "nothing a different flow would fix" and the loop
 * retires the expensive lever on the strength of a report it just refused.
 * `'re-record'` for an unusable attempt therefore has to come BEFORE the
 * findings check, not after.
 *
 * Returns one of:
 *   'reached-target'  — good enough, stop
 *   'out-of-attempts' — no budget left
 *   're-record'       — try again (with guidance only when there is any)
 *   'nothing-to-fix'  — a TRUSTED report with no flow findings; another take
 *                       would record the same problems
 */
function nextStep({ usable, score, flowFindings, target, n, attempts }) {
  if (usable && score >= target) return 'reached-target';
  if (n === attempts) return 'out-of-attempts';
  if (!usable) return 're-record';
  if (!flowFindings.length) return 'nothing-to-fix';
  return 're-record';
}

/**
 * May this attempt be selected as the run's best — and therefore published?
 *
 * Its own predicate for a reason that is not abstraction for its own sake: a
 * MERGE re-introduced the older, unguarded `best = r` line beside the guarded
 * one, and because the unguarded one ran first the refusal silently stopped
 * working. Two look-alike predicates for one decision is the shape that failure
 * needs; one named function is not.
 *
 * `usable === false` only ever comes from a report that could not be reconciled
 * with the cut on disk. An attempt that simply recorded nothing (`outDir: null`)
 * is not selectable either, but it is not unusable — the caller's own branch
 * turns that into guidance.
 */
function canSelect(attempt) {
  return Boolean(attempt?.outDir) && attempt?.usable !== false;
}

module.exports = { keptReport, nextStep, canSelect };
