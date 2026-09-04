// ENG-5778 / ENG-5768 — the bridge: this pipeline's clip timeline -> the Moda
// canvas compiler's input document.
//
//   node to-moda-timeline.js output/<name>.timeline.json [> moda-timeline.json]
//
// DISPOSABLE SPIKE. Milestone 0's rule is "build only the disposable spike each
// gate needs", so this is an adapter in the prototype rather than a coupling in
// studio: the compiler's contract must not grow a dependency on this repo's
// format. If the shape settles, the right move is for buildClipTimeline() to emit
// the document directly and for this file to be deleted.
//
// Three things the two formats genuinely disagree about, and none of them is
// cosmetic:
//
// 1. `box` UNITS. buildClipTimeline passes Playwright's `locator.boundingBox()`
//    straight through, which is CSS PIXELS. ENG-5768's contract says "normalized
//    bbox" and the parser enforces 0..1 against the viewport. The ticket and the
//    only real producer have disagreed since the contract was written; nothing
//    caught it because nothing had ever fed one to the other. Normalizing here.
//
// 2. `provenance`. buildClipTimeline emits none, so the parser defaults every
//    action to `inferred` — which would send every zoom to a human for
//    confirmation despite the clicks being as observed as they get. They qualify
//    under the strict reading: recorder.js's loop calls doAction(), which
//    resolves the locator, reads its box and clicks, and RETURNS the geometry that
//    is pushed onto the timeline in the same iteration. The record is a byproduct
//    of the click, not a report about it.
//
//    But only when the identity actually resolved — see below.
//
// 3. `integrity`. buildClipTimeline emits no completeness header, and the parser
//    treats absence as UNKNOWN rather than complete. It can be filled in honestly
//    here, because the recorder's loop has no per-action catch: doAction() throwing
//    aborts the whole recording, so a timeline that exists at all covers every
//    action up to `done`. Completeness is structural, not asserted.

const fs = require('fs');
const path = require('path');
const { scriptCaptions, captionTransport } = require('./src/captions');

/** Actions the recorder never gives a screen location, and must not be scored as if it did. */
const UNLOCATED_TYPES = new Set(['wait', 'nav', 'goto', 'scroll', 'key', 'press']);

async function toModa(clip, { captions = true } = {}) {
  const vp = clip.viewport;
  if (!vp || !(vp.width > 0) || !(vp.height > 0)) {
    throw new Error(`timeline has no usable viewport: ${JSON.stringify(vp)}`);
  }

  // Normalize and clip to the frame. A box that hangs off the edge is real — a
  // button flush to the right edge measures a pixel or two over — so clamp the
  // extent rather than refusing, but never move the origin: shifting a box to
  // make it fit would silently relocate the thing the camera aims at.
  const normalize = (box) => {
    if (!box) return undefined;
    const x = box.x / vp.width;
    const y = box.y / vp.height;
    if (x < 0 || y < 0 || x >= 1 || y >= 1) return undefined; // off-screen: no honest normalization
    return {
      x: +x.toFixed(6),
      y: +y.toFixed(6),
      width: +Math.min(box.width / vp.width, 1 - x).toFixed(6),
      height: +Math.min(box.height / vp.height, 1 - y).toFixed(6),
    };
  };

  // Captions come from a writer fed the RESOLVED ELEMENT, not from `label`.
  // In llm mode `label` is the discovery agent's reasoning — it describes what
  // the agent was considering, including its wrong turns, and putting that on
  // screen is what made the first real run unshippable. See src/captions.js.
  const captionText = captions
    ? await scriptCaptions({ goal: clip.goal, steps: clip.actions })
    : clip.actions.map((a) => a.label ?? '');

  const unresolved = [];
  const actions = clip.actions.map((a, i) => {
    const located = a.clickX != null;
    // `identityResolved` is written by recorder.js at the moment of the click.
    // Absent on a timeline recorded before that landed — treat that as UNKNOWN and
    // fall to the unsafe side, exactly as the parser does for actionsIssued: an old
    // artifact must not be able to pass for a verified one.
    const identified = located && a.selector != null && a.identityResolved === true;
    if (located && !identified) unresolved.push(a.index);

    const out = {
      index: a.index,
      type: a.type,
      // '' means "no caption node" to the compiler, which is the honest output
      // for a step with no resolved identity: better silent than confidently wrong.
      label: captionText[i] ?? '',
      startSec: a.startSec,
      endSec: a.endSec,
    };
    // Where the page changed after this action, normalized. The compiler uses it
    // to decide whether a punch-in can actually show the result.
    if (a.resultBox) out.resultBox = a.resultBox;
    // The SECOND whitelist between the recorder and the checks. The capture
    // records whether it hid the cursor while typing, the timeline projection
    // carries it, and this one dropped it — so the occlusion check reported
    // "not measured" on takes that had in fact recorded the answer. Two
    // hand-maintained projections in series means a new field is invisible
    // until BOTH are updated, and neither says anything when it is not.
    if (a.cursorHiddenWhileTyping !== undefined) out.cursorHiddenWhileTyping = a.cursorHiddenWhileTyping;
    if (located) {
      out.clickX = a.clickX;
      out.clickY = a.clickY;
      out.moveStartSec = a.moveStartSec;
      out.arrivalSec = a.arrivalSec;
      out.clickSec = a.clickSec;
    }
    // Only claim identity the run actually verified. Emitting the selector we TRIED
    // would assert an identity the fallback disproved, which is worse than omitting
    // it — the compiler cannot tell, and a zoom would inherit a name that is wrong.
    if (identified) {
      out.selectorType = a.selectorType;
      out.selector = a.selector;
      const box = normalize(a.box);
      if (box) out.box = box;
    }
    // An UNLOCATED action was never a click; provenance still describes how we know
    // it happened, and the recorder issued it.
    out.provenance = 'observed';
    out.meta = { discoveryLabel: a.label ?? null };
    if (!identified && located) {
      out.meta.attemptedSelector = a.selector ?? null;
      out.meta.identityResolved = false;
    }
    return out;
  });

  // WHAT THE RECORDER SET OUT TO DO, not what came back.
  //
  // This was `actions.length` — the length of the array two lines above — so
  // the completeness header was derived from the very thing it certifies and
  // `Integrity.complete` (actions_issued == actions_recorded) could not ever be
  // false. capture.mjs already counts one per FLOW STEP and writes it as
  // `_issued`; the number was there and this recomputed it from the output.
  //
  // A step that throws is caught per-action, so the ledger can legitimately be
  // shorter than the flow — which is precisely the gap the header exists to
  // surface. Falling back to the old value keeps takes recorded before
  // `_issued` existed parseable rather than marking them all incomplete.
  const issued = Number.isInteger(clip._issued) ? clip._issued : actions.length;
  return {
    name: clip.name,
    goal: clip.goal,
    durationSec: clip.durationSec,
    // Where the real footage stops, when a closing line pushed `durationSec`
    // past it. The publish step brings the outro card up here so the conclusion
    // lands on the card instead of on a frozen screenshot.
    ...(clip.footageEndSec ? { footageEndSec: clip.footageEndSec } : {}),
    viewport: { width: vp.width, height: vp.height },
    integrity: {
      actionsIssued: issued,
      unresolved,
      note:
        'recorder.js has no per-action catch — doAction() throwing aborts the whole ' +
        'recording, so a timeline that exists covers every action it issued. ' +
        (unresolved.length
          ? `${unresolved.length} action(s) executed via the position fallback and are NOT identity-verified.`
          : 'Every located action resolved its selector.'),
    },
    actions,
  };
}

if (require.main === module) {
  const src = process.argv[2];
  if (!src) {
    console.error('usage: node to-moda-timeline.js <clip.timeline.json>');
    process.exit(1);
  }
  const clip = JSON.parse(fs.readFileSync(path.resolve(src), 'utf8'));
  const derive = !process.argv.includes('--raw-labels');
  toModa(clip, { captions: derive }).then((doc) => {
    const located = doc.actions.filter((a) => a.clickX != null).length;
    console.error(
      `[bridge] ${doc.actions.length} action(s), ${located} located, ` +
        `${doc.actions.filter((a) => a.selector).length} identity-verified, ` +
        `${doc.integrity.unresolved.length} on the position fallback, ` +
        `${doc.actions.filter((a) => a.label).length} captioned` +
        // NAME THE TRANSPORT. "derived" means nothing polished them and they read
        // `Click "User menu"` — which is a materially worse video, and used to be
        // reported with the same words as a good pass.
        // `--raw-labels` means the caller wrote them (the script pass); the
        // caption transport never ran, so reporting its initial value would
        // claim they were derived here when nothing here touched them.
        ` (${derive ? captionTransport() : 'authored upstream'})`
    );
    process.stdout.write(JSON.stringify(doc, null, 2) + '\n');
  });
}

module.exports = { toModa, UNLOCATED_TYPES };
