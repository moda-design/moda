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
//
// `contradiction` rides along for a different consumer: the critique found the
// film asserting something the screen denies (ENG-6375 — a 90px headline saying
// the endpoint "lets Claude Code design in Moda" over a screen reading
// "read-only filesystem over all Moda documentation"). It is carried here, and
// not gated on here, because `run.mjs` turns it into a flow finding: it steers
// the next walk and does NOT refuse a publish.
//
// That is a measurement, not a preference. Over seven runs against the film it
// was written for, the detector fired 6 times and named the actual defect only
// 3 — the rest landed on a miscounted click or a misread URL. Its false-positive
// rate against a truthful film is UNMEASURED, because no such film exists to
// test against yet. A refusal on that signal would ship the lie one run in seven
// and block good takes for trivia, so it buys a re-walk instead. Make it a gate
// when there is a negative control, not before.

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
 *
 * `contradiction` follows the SAME cut as the score, for the same reason and a
 * sharper one: it is a statement about frames. Carrying the last critique's
 * contradiction onto a reverted cut would steer the next walk with a finding
 * about a video that was thrown away.
 */
function keptReport({ kept, critique }) {
  if (kept?.reconciled === false) {
    return { usable: false, score: 0, issues: [], contradiction: null };
  }
  return {
    usable: true,
    score: kept?.score ?? critique?.score ?? 0,
    issues: kept?.issues ?? critique?.issues ?? [],
    // `?? null` rather than `||`: the two sources are "this cut said nothing was
    // wrong" and "this cut was never asked", and only the SECOND may fall
    // through to the other report.
    contradiction: kept ? (kept.contradiction ?? null) : (critique?.contradiction ?? null),
  };
}

//: The flow finding `run.mjs` synthesises from a contradiction.
//:
//: ONE definition, exported, because two modules must agree on it: `run.mjs`
//: creates it and `nextStep` reads it. Spelled as a literal in both, a rename
//: would leave the early exit silently matching nothing — and the symptom is a
//: contradicted film quietly reported "good enough", which is the exact defect
//: this whole change is about.
const CONTRADICTION_FINDING = 'contradicts_screen';

//: How much craft a truthful take may give up and still be preferred to a
//: contradicted one. See `betterTake` — this is the bound that keeps the
//: preference from shipping a materially worse film on a false positive.
const TRUTH_OVER_POLISH = 2;

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
 *
 * A CONTRADICTION DEFEATS THE EARLY EXIT, and that is not the same decision as
 * gating a publish. `reached-target` is a claim that the take is good enough to
 * stop working on; `canSelect` is a claim that it may be published. Refusing
 * the first while allowing the second is exactly the position the measurement
 * supports.
 *
 * Without this the feature is INERT in the case it was written for. The
 * dangerous film is the well-made one — ENG-6375 records "layout, camera,
 * captions and pacing were all fine; the film simply demonstrates the wrong
 * feature" — and a well-made film scores at or above the target, so the loop
 * would append the finding and then stop on the line above it, spending none of
 * the attempts that could have fixed it.
 *
 * WHEN THERE ARE ANY. `--attempts` defaults to 1, and the next line returns
 * 'out-of-attempts' on the last one, so on a default invocation this changes
 * nothing — there is no budget to spend. The contradiction is still printed
 * beside the attempt score before the publish, which is the whole of what a
 * single-attempt run can offer. `SKILL.md` says so where it suggests
 * `--attempts 2`.
 */
function nextStep({ usable, score, flowFindings, target, n, attempts }) {
  const contradicted = (flowFindings ?? []).some((f) => f?.type === CONTRADICTION_FINDING);
  if (usable && !contradicted && score >= target) return 'reached-target';
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
 *
 * A CONTRADICTION DOES NOT REFUSE SELECTION, deliberately — see the header. The
 * detector is not reliable enough to hold a publish, so it steers the next walk
 * instead. Do not add it here without a measured false-positive rate.
 */
function canSelect(attempt) {
  return Boolean(attempt?.outDir) && attempt?.usable !== false;
}

/**
 * Does `candidate` beat the incumbent for the run's best take?
 *
 * Its own predicate for the same reason `canSelect` is: an inline comparison is
 * how this drifts, and a merge has already re-introduced an unguarded copy of
 * the selection line once.
 *
 * A CONTRADICTION IS A TIE-BREAK, NOT A GATE. Both takes have already passed
 * `canSelect`, so preferring the uncontradicted one refuses nothing and holds
 * no publish — a different risk from blocking the run, which the measurement
 * does not support (6 fires in 7, 3 on target, false positives unmeasured).
 *
 * BOUNDED, because unbounded it was not the weak intervention it claimed to be.
 * Cleanliness deciding outright means a false positive on a 9/10 take hands the
 * run to whatever the retake produced — a 2/10 with blank screens — and
 * publishes the materially worse film while reporting the re-walk as done,
 * which is the same mis-reported success this change exists to remove. With the
 * false-positive rate unmeasured that is not a cost worth taking blind, so the
 * preference applies only within `TRUTH_OVER_POLISH`.
 *
 * The margin is a judgement, and it is the one number here that is: two points
 * buys the realistic case — a truthful retake a little rougher than the
 * flagged one — and refuses the pathological case that the unmeasured
 * false-positive rate makes reachable. Widen it when that rate is measured.
 *
 * Without it the re-walk is decorative. `nextStep` spends another attempt on a
 * contradiction, but ENG-6375's premise is that the contradicted film is WELL
 * MADE — "layout, camera, captions and pacing were all fine" — so it scores
 * high, and a truthful retake would have to strictly out-score it to displace
 * it. A clean 7 losing to a contradicted 8 republishes the lie and reports the
 * re-walk as done.
 *
 * `graded` IS REQUIRED ON BOTH SIDES, and inferring it from a null
 * `contradiction` is the bug this parameter exists to prevent. An attempt can
 * record and never be graded — `critiqueFrames` shells out to the `claude` CLI,
 * so a missing binary, a rate limit or a non-JSON reply leaves no critique.json
 * — and `attemptOnce` deliberately keeps that attempt selectable at `score: 0`.
 * Read as "no contradiction", it would count as truthful and displace a graded
 * 8/10, publishing an ungraded cut and reporting `done — (0/10)`: strictly
 * worse than the score-only ranking this replaced. "Asked and found nothing"
 * and "never asked" must not look alike, which is what `critique-take.mjs` says
 * where it writes the field.
 *
 * So the preference applies only between two GRADED takes. Otherwise score
 * decides, which keeps an ungraded take selectable when it is the only artifact
 * and stops it beating a graded one on a question it was never asked.
 */
function betterTake(candidate, incumbent) {
  if (!canSelect(candidate)) return false;
  if (!incumbent) return true;
  const score = (t) => t.score ?? 0;
  if (candidate.graded && incumbent.graded) {
    const clean = (t) => Number(!t.contradiction);
    if (clean(candidate) > clean(incumbent)) return score(candidate) >= score(incumbent) - TRUTH_OVER_POLISH;
    if (clean(candidate) < clean(incumbent)) return score(candidate) > score(incumbent) + TRUTH_OVER_POLISH;
  }
  return score(candidate) > score(incumbent);
}

module.exports = { keptReport, nextStep, canSelect, betterTake, CONTRADICTION_FINDING,
  TRUTH_OVER_POLISH };
