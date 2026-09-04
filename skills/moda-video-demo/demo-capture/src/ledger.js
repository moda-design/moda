// The ledger of what the recorder DID, projected into timeline actions.
//
// Extracted so the one guarantee it makes can be tested. That guarantee had
// been broken twice over and nothing noticed either time:
//
//   1. `to-moda-timeline.js` derived `actionsIssued` from the length of the
//      array it was certifying, so `actions_issued == actions_recorded` was a
//      tautology and the compiler's completeness gate could never fire.
//   2. Fixing that to read the recorder's own `_issued` counter changed
//      nothing, because a step that THREW was still pushed to the ledger. The
//      two numbers stayed equal by construction. The test written for the fix
//      passed only because its fixture — three issued, two recorded — is a
//      state the recorder could not produce.
//
// A step that threw has no authoritative record of what it did, which is
// exactly the state `LogIntegrity` exists to name: issued, not recorded.

/**
 * Timeline actions from a recorder ledger.
 *
 * `shift` moves clip-relative times when the head of the recording is trimmed.
 * FAILED entries are dropped — they were attempted, so they count as issued,
 * and they produced nothing trustworthy, so they are not recorded.
 */
function projectActions(ledger, shift = (s) => s) {
  return ledger
    .filter((a) => !a.failed)
    .map((a) => ({
      index: a.index,
      type: a.type,
      label: a.label,
      ...(a.resultBox ? { resultBox: a.resultBox } : {}),
      selectorType: a.selectorType ?? null,
      selector: a.selector ?? null,
      ...(a.cursorHiddenWhileTyping !== undefined
        ? { cursorHiddenWhileTyping: a.cursorHiddenWhileTyping }
        : {}),
      startSec: shift(a.tStart / 1000),
      endSec: shift(a.tEnd / 1000),
      ...(a.clickX != null
        ? {
            clickX: a.clickX,
            clickY: a.clickY,
            box: a.box,
            moveStartSec: shift(a.moveStartT / 1000),
            arrivalSec: shift(a.arrivalT / 1000),
            clickSec: shift(a.clickT / 1000),
            identityResolved: a.identityResolved ?? null,
          }
        : {}),
    }));
}

module.exports = { projectActions };
