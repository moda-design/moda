// Did the demo show what was ASKED, or only what came back? (ENG-6124)
//
// Every take before this check was clicks only. On the run that filed the
// ticket the flow was two actions — click Run, hold — and the critique's own
// words were that "the query being composed is never legible… the viewer sees a
// table appear but not what was asked". Two of six shot checks (cursorOcclusion,
// zoomRelease) also read "nothing was typed in this take" and measured nothing.
//
// It is a PRE-RECORD check because that is where it is cheap: `run.mjs` refuses
// a flow with this shape and re-discovers with the finding as guidance, which
// costs no recording at all. Confirming it from the footage would cost minutes
// to learn what the walk already knows.

/**
 * Whether a flow skipped the input the product offered.
 *
 * `sawTextField` comes from discovery's own snapshot of the page the flow LAST
 * ACTED ON — the page is gone by the time anything downstream could look, and
 * that page is where "compose, then run" would have composed. Say only that:
 * this does not know what the rest of the walk offered, and a reason string
 * claiming otherwise would be a wider claim than the evidence.
 *
 * Without the record the check cannot run, and it says so rather than guessing:
 * a flow with no typing is perfectly correct for a product that takes none, and
 * refusing those takes would be worse than the bug.
 */
function checkInputShown(flow) {
  const steps = flow?.steps ?? [];
  // SUBSTANTIVE fills only. `asFlowStep` builds a fill as `text: action.text ?? ''`,
  // so a `type` the model returns without any text yields an empty one — and
  // `enterText` then clears the control and types nothing. The viewer sees no
  // input being composed, which is the exact defect this check exists to catch,
  // so counting it as input would report `bad: false` on the failure itself.
  const fills = steps.filter((s) => s.action === 'fill' && String(s.text ?? '').trim().length > 0).length;
  if (flow?.sawTextField !== true) {
    return {
      measured: false,
      fills,
      reason:
        flow?.sawTextField === false
          ? 'the page this flow finished on offered no typeable field, so there was no input to show'
          : 'this flow predates the text-field record, so whether input was offered is unknown',
    };
  }
  return { measured: true, fills, bad: fills === 0 };
}

/**
 * What one snapshot says about the input on offer.
 *
 * Given the interactable list from the page the flow LAST acted on, returns
 * whether a typeable field was there and the names worth quoting back.
 *
 * Its own function because three separate bugs lived in this derivation and each
 * was invisible until a reviewer read it:
 *
 * * existence was inferred from `role`, which reports a contenteditable editor
 *   as its TAG and a range/file input as "textbox" — wrong in both directions;
 * * existence was then inferred from having a NAME, so an `<input>` labelled by
 *   a sibling `<label for>` reported no field at all — naming is presentation
 *   and must never gate detection;
 * * and the value was only overwritten on a non-empty snapshot, which made it
 *   sticky: a landing page's search box carried through into a click-only tool
 *   and refused a perfectly good flow.
 *
 * Taking the ONE list and deriving both answers from it makes the third
 * impossible by construction, and the other two testable without a browser.
 */
function inputEvidence(list) {
  const fields = (list ?? []).filter((e) => e.typeable);
  return {
    sawTextField: fields.length > 0,
    typeableFields: fields.map((e) => e.placeholder || e.name).filter(Boolean),
  };
}

/**
 * Which snapshot counts as the evidence, after one kept step.
 *
 * `list` at the top of a discovery turn is the page as it looked AFTER the
 * previous action, so a `wait` — and every flow ends in one, because a demo
 * holds on its result — would replace the composer page with whatever the click
 * produced: a spinner, a loading state, a result view that has navigated away.
 * On the ticket's own shape ("click Run, hold") that silences the gate on
 * exactly the demo it exists to refuse.
 *
 * You compose and click Run on the SAME page, so the evidence is the page of the
 * last click or fill. Waits pass the previous answer through.
 *
 * Still last-writer-wins, still one list: a later click into a click-only tool
 * overwrites with its own (possibly field-less) snapshot, so this cannot go
 * sticky. This line has been wrong twice — once sticky, once wait-clobbered — so
 * it is one shared expression with its own test rather than an inline
 * assignment.
 */
function evidenceFor(actionType, list, previous) {
  return actionType === 'wait' ? previous : list;
}

module.exports = { checkInputShown, inputEvidence, evidenceFor };
