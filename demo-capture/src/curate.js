// What a demo must never show, removed before it is recorded.
//
// Discovery drives the product to reach a goal, and that is a different job from
// showing the product off. When the app throws a dialog it dismisses it; when a
// render fails it clicks Try again. Those are correct moves for an agent and
// they are the last thing a demo should contain — a viewer sees the product
// erroring and being nursed through it.
//
// Measured on Moda's own flow: discovery emitted eight steps, two of which were
// "Maybe later" (dismissing a troubleshooting dialog) and "Try again" (retrying
// a canvas render error). Both had to be deleted by hand before the take was
// usable, and nothing in the pipeline would have caught them — every gate
// downstream was happy, because the steps resolved and did change the page.
//
// REMOVAL IS NOT SAFE ON ITS OWN. A dialog dismissal is junk when the dialog did
// not appear and load-bearing when it did — drop it then and every later step is
// blocked by a modal. So this proposes drops; the caller re-walks the flow and
// puts back anything whose removal broke it. See `run.mjs`.

//: Clicks whose whole purpose is to get the product back to working order.
//: Matched on the accessible name, which is what the selector carries.
const RECOVERY = [
  /\btry again\b/i,
  /\bretry\b/i,
  /\breload\b/i,
  /\bmaybe later\b/i,
  /\bdismiss\b/i,
  /\bnot now\b/i,
  /\bgot it\b/i,
  /\bskip for now\b/i,
  /\btroubleshoot/i,
  /\breport (a )?(problem|issue)\b/i,
  /\bcontact support\b/i,
];

//: Consent and interruption furniture. Real, but not what anyone came to see.
const INTERSTITIAL = [
  /\baccept( all)? cookies\b/i,
  /\bcookie/i,
  /\bclose ad\b/i,
  /\bno thanks\b/i,
  /\bstart (free )?trial\b/i,
  /\bupgrade\b/i,
];

/** The accessible name a role= selector carries, if it has one. */
function nameOf(step) {
  const m = /name="([^"]*)"/i.exec(step.locator ?? '');
  return m ? m[1] : '';
}

/**
 * Steps worth proposing for removal, each with the reason.
 *
 * Returns `[{ index, why }]` — never mutates. Only CLICKS are considered: a
 * fill or a wait cannot be product-recovery furniture, and dropping either
 * changes what the demo says rather than how clean it looks.
 */
function proposeDrops(flow) {
  const out = [];
  (flow.steps ?? []).forEach((s, index) => {
    if (s.action !== 'click') return;
    const name = nameOf(s) || s.why || '';
    const recovery = RECOVERY.find((r) => r.test(name));
    if (recovery) {
      out.push({ index, why: `recovering from a product error (${JSON.stringify(name)})` });
      return;
    }
    const interstitial = INTERSTITIAL.find((r) => r.test(name));
    if (interstitial) out.push({ index, why: `interstitial furniture (${JSON.stringify(name)})` });
  });
  return out;
}

/** A flow with the given step indices removed. */
function without(flow, indices) {
  const drop = new Set(indices);
  return { ...flow, steps: (flow.steps ?? []).filter((_, i) => !drop.has(i)) };
}

/**
 * End on a hold.
 *
 * The last thing a viewer sees is the payoff, and without a trailing wait the
 * recording stops as soon as the final action returns — on an agent app that is
 * the instant the result appears, so it is on screen for a single frame. Added
 * by hand to every take that worked.
 */
function ensureTrailingHold(flow, { quietMs = 2000, maxMs = 20000 } = {}) {
  const steps = [...(flow.steps ?? [])];
  if (steps.length && steps[steps.length - 1].action === 'wait') return { flow, added: false };
  steps.push({ action: 'wait', quietMs, maxMs, why: 'Hold on the result' });
  return { flow: { ...flow, steps }, added: true };
}

module.exports = { proposeDrops, without, ensureTrailingHold, RECOVERY, INTERSTITIAL };
