// Is the film's closing line SPOKEN over the recording, or WRITTEN on the close
// card? (ENG-6354.)
//
// One module because the decision is made in one process and consumed in
// another: `finish.mjs` renders the narration and must know whether to leave
// the line out of it, and `publish-take.mjs` authors the composition minutes
// later and must know whether to put it on the card. Get those two answers out
// of step and the line is either said twice or not at all — and both are silent
// in the output, because nothing downstream compares them.
//
// Two mechanisms keep them together, and they are deliberately belt and braces:
//
//   1. ONE PREDICATE. `chooseConclusion` is the only place the rule lives, so
//      the stages cannot disagree by re-deriving it differently. They did, in
//      review round 1: `Boolean(env) && Boolean(pacing?.conclusion)` in finish
//      against `brandId && typeof pacing.conclusion?.text === 'string'` in
//      publish — similar enough to read as the same rule and not the same rule.
//
//   2. A WRITTEN RECORD. The predicate reads `DEMO_BRAND`, which is ambient and
//      per-process, and `references/capture.md` documents running these stages
//      standalone. So finish RECORDS what it actually did and publish reads the
//      record rather than re-deciding. Every other cross-stage fact here is
//      passed as a file for exactly this reason — `genre.json`, the narration
//      record, the compression facts.
const { existsSync, readFileSync, writeFileSync } = require('node:fs');

//: The server's `DemoVideoCloseCard.headline` cap, mirrored. CHARACTERS —
//: this module also handles `pacing.conclusion.durationSec`, and a `_SEC`
//: suffix on a length is an invitation to compare it against one.
//:
//: NOT a second opinion about what fits — the server owns that, and its own
//: comment derives it from the slot (1808px at 52px over two lines, ~138
//: characters). This is here so an overrun can be caught BEFORE finish drops
//: the line from the audio. Sent blind it is a 422 from `moda demo publish`,
//: which aborts the whole publish after the recording has already uploaded and
//: after the conclusion has already been left out of the narration — leaving
//: no film and no spoken line. A model-authored wrap-up sentence over 140
//: characters is routine, not exotic.
const MAX_WRITTEN_CHARS = 140;

/**
 * What to do with the closing line, given the take's pacing and the brand.
 *
 * `style` is the take's genre, and it is REQUIRED reasoning rather than an
 * optional refinement: it decides whether anything is spoken at all.
 *
 * Returns `{ written, reason }`. `written` is the text to put on the card, or
 * null when the line stays spoken. `reason` says which rule decided, so both
 * stages can print the same explanation.
 *
 * FALLS BACK TO SPOKEN on every doubt, because spoken is the status quo: the
 * line lands on a frozen frame, which is the defect this exists to fix, but it
 * is a defect and not a loss. Refusing the publish or dropping the sentence
 * would both be worse than the thing being improved.
 */
function chooseConclusion({ pacing, brandId, style }) {
  const text = typeof pacing?.conclusion?.text === 'string' ? pacing.conclusion.text.trim() : '';
  if (!text) return { written: null, reason: 'no conclusion in the script' };
  // A MARKETING CUT HAS NO VOICEOVER AT ALL, so there is nothing to move. The
  // remedy here is "written INSTEAD OF spoken", and on this genre the status
  // quo is silence, not a frozen frame: `finish.mjs` sets `planned = []`, so
  // `planNarration` never runs, nothing overruns and no tail is held. Writing
  // it anyway applies the fix where the defect cannot occur — and costs the
  // brand its tagline on the one genre defined as having no narration.
  //
  // Reachable and supported: `DEMO_STYLE=marketing` over a take pacing.js
  // recorded as a tutorial leaves `pacing.conclusion.text` populated while
  // finish builds a marketing cut.
  if (style === 'marketing') {
    return { written: null, reason: 'a marketing cut has no voiceover, so there is no spoken line to move' };
  }
  if (!brandId) return { written: null, reason: 'no brand, so there is no close card to write it on' };
  if (text.length > MAX_WRITTEN_CHARS) {
    return {
      written: null,
      reason:
        `the closing line is ${text.length} characters and the card holds ${MAX_WRITTEN_CHARS} — ` +
        'spoken instead, so the publish is not refused over it',
    };
  }
  return { written: text, reason: 'written on the close card' };
}

/** Where finish records the decision for publish to read. */
function conclusionRecordPath(outDir, id) {
  return `${outDir}/${id}.conclusion.json`;
}

/**
 * Record what finish ACTUALLY did, for publish to act on.
 *
 * Always written, including the spoken case: absent and "spoken" must not look
 * alike, or a publish that runs against a half-finished take cannot tell a
 * decision from a missing file.
 */
function recordConclusion(outDir, id, choice, brandId = null) {
  writeFileSync(
    conclusionRecordPath(outDir, id),
    // The BRAND goes in too. The decision was made against a particular kit,
    // and a publish run standalone against a different one is placing this
    // line on a card it was never chosen for. Recording it is what lets the
    // consumer notice; nothing else in the take carries it.
    JSON.stringify({ written: choice.written, reason: choice.reason, brandId: brandId || null }, null, 2)
  );
}

/**
 * What finish decided, or null when it never said.
 *
 * Returns `{ written, brandId }` rather than a bare string, so the caller can
 * see WHICH kit the line was chosen against.
 *
 * A MISSING RECORD MEANS SPOKEN, and the caller must treat it that way. Finish
 * is the only writer; if it did not record, it did not suppress the line, so
 * the audio already carries it and putting it on the card too would say it
 * twice. Re-deriving the decision here instead is what round 1 rejected.
 */
function readConclusion(outDir, id) {
  const p = conclusionRecordPath(outDir, id);
  if (!existsSync(p)) return { written: null, brandId: null };
  try {
    const raw = JSON.parse(readFileSync(p, 'utf8'));
    const written = typeof raw?.written === 'string' && raw.written.trim() ? raw.written.trim() : null;
    return { written, brandId: typeof raw?.brandId === 'string' ? raw.brandId : null };
  } catch {
    // An unreadable record is not a licence to guess. Spoken is the safe read.
    return { written: null, brandId: null };
  }
}

module.exports = { chooseConclusion, recordConclusion, readConclusion, conclusionRecordPath, MAX_WRITTEN_CHARS };
