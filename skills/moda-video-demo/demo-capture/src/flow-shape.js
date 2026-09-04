// Is this a demo of a product, or a tour of one widget?
//
// A person watched two demos and preferred the one that scored WORSE. The
// higher-scoring take clicked six controls in the same row — every theme in a
// picker, then back to the first — and every countable check passed it, because
// they all measure execution: framing, timing, readability, dead air. None asks
// what the flow is made of.
//
// Clicking every option in one control is the shape that reads as a tour. It is
// not the same as a demo that happens to use one control twice; what makes it a
// tour is that MOST of the demo is that control.
//
// The signal is the click coordinates, which the recorder measures directly. On
// the take above, six of seven clicks landed at exactly y=151.

//: Clicks whose centres sit within this many pixels of each other, on one axis,
//: are the same row or column of controls.
const SAME_BAND_PX = 14;
//: A band has to hold at least this many clicks to be a tour rather than a
//: control used more than once.
const MIN_BAND = 3;
//: ...and account for at least this share of the demo's clicks. A flow that
//: spends three of ten clicks in a picker is using it; three of four is a tour.
const TOUR_SHARE = 0.6;

/** The largest set of clicks sharing a row or a column. */
function largestBand(clicks) {
  let best = { axis: null, at: null, members: [] };
  for (const axis of ['y', 'x']) {
    for (const anchor of clicks) {
      const members = clicks.filter((c) => Math.abs(c[axis] - anchor[axis]) <= SAME_BAND_PX);
      if (members.length > best.members.length) best = { axis, at: anchor[axis], members };
    }
  }
  return best;
}

/**
 * Whether the flow is mostly one control.
 *
 * Returns `{ measured, clicks, band, bad }`. `measured: false` when there are
 * too few clicks to have a shape — two clicks in a row is not a tour, and
 * saying nothing is better than a verdict the data cannot support.
 */
function checkFlowShape(actions) {
  const clicks = (actions ?? [])
    .filter((a) => a.clickX != null && a.clickY != null)
    .map((a) => ({ index: a.index, x: a.clickX, y: a.clickY, label: (a.label ?? '').trim() }));
  if (clicks.length < MIN_BAND) {
    return { measured: false, reason: `only ${clicks.length} located click(s) — too few to have a shape` };
  }
  const band = largestBand(clicks);
  const share = band.members.length / clicks.length;
  const bad = band.members.length >= MIN_BAND && share >= TOUR_SHARE;
  return {
    measured: true,
    clicks: clicks.length,
    band: { axis: band.axis, at: band.at, count: band.members.length, share: +share.toFixed(2),
            steps: band.members.map((m) => m.index) },
    bad,
  };
}

module.exports = { checkFlowShape, SAME_BAND_PX, MIN_BAND, TOUR_SHARE };
