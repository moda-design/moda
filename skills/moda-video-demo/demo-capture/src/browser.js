// How every stage that touches the product launches Chromium.
//
// ONE list, because there were two: `capture.mjs` enabled WebGPU and every other
// stage did not. That is not a tidiness problem — it means the gates run against
// a DIFFERENT PRODUCT than the camera records.
//
// Moda's own canvas is the worst case and the one that found this. Without
// WebGPU the editor cannot initialize its renderer and puts up a "Troubleshoot
// WebGPU in Chrome" modal whose overlay swallows every pointer event. So on
// 2026-09-08, against local studio:
//
//   - discovery spent turns authoring steps to dismiss it, and diagnosed its own
//     symptom ("the open data-dialog-overlay is intercepting pointer events,
//     which is why prior clicks silently failed");
//   - curate correctly proposed dropping those steps as product-error recovery;
//   - validate put them back as "load-bearing" — in a GPU-less browser they are;
//   - and validate then failed the whole flow, so nothing was recorded.
//
// The recorder would have captured that flow perfectly. A pre-flight browser
// that is not the surface under test measures itself, not the product.
//
// `outro.js` is deliberately NOT a caller: it renders a static card in a browser
// that never visits the product, so it needs none of this.

/**
 * Chromium args for any launch that drives, measures or records the product.
 *
 * Frozen so a caller cannot push onto the shared array and silently change what
 * every other stage launches with.
 */
const PRODUCT_BROWSER_ARGS = Object.freeze([
  '--enable-unsafe-webgpu',
  '--ignore-gpu-blocklist',
  '--enable-gpu',
]);

/**
 * Launch options for a stage that touches the product.
 *
 * Takes overrides so a caller can add its own options without restating the
 * args — restating them is exactly how the two lists drifted apart.
 */
function productLaunchOptions(overrides = {}) {
  const { args = [], ...rest } = overrides;
  return { headless: true, ...rest, args: [...PRODUCT_BROWSER_ARGS, ...args] };
}

module.exports = { PRODUCT_BROWSER_ARGS, productLaunchOptions };
