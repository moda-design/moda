// Is an uploaded clip's RECORD measured enough to place? (ENG-6103)
//
// `<video>` placement sizes its node from the File record's width/height and
// hard-fails without them. Those are probed from the container asynchronously,
// seconds after the upload call returns — so "the upload succeeded" and "the
// clip can be placed" are two different facts, and the publish lane needs the
// second one.
//
// This predicate exists as its own function because the readiness poll in
// `publish-take.mjs` previously asked the WRONG question: it fetched the byte
// proxy and broke on any non-404. Bytes exist the instant the object lands, so
// that poll always cleared immediately and publish ran ~35s before dimensions
// were written. Naming the real condition once, and testing it, is what stops
// the poll quietly regressing to some other easy-to-observe fact.

/**
 * Whether `record` (a `moda file show --json` `file` object) reports the
 * dimensions placement requires.
 *
 * Both must be present and non-zero. `probed_metadata_updates` writes width and
 * height as a PAIR — the probe yields both or neither — so a half-measured
 * record means something else wrote it, and a zero is not a size anything can
 * be laid out against. Treating either as ready would put the failure back in
 * the browser parser, which is where it is unreadable.
 */
function recordIsMeasured(record) {
  if (!record || typeof record !== 'object') return false;
  const { width, height } = record;
  return typeof width === 'number' && width > 0 && typeof height === 'number' && height > 0;
}

module.exports = { recordIsMeasured };
