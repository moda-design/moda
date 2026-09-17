// The brand READ for a demo's closing card: logo, tagline, URL, and the
// ground/ink polarity chosen from the logo.
//
// Unanimous across three published demos — every one ends on a logo and a call
// to action, 5 to 9 seconds. It is also the one piece of the intro/outro
// question that is NOT a design decision: two of the three open cold on the
// product, but all three close this way.
//
// THE CARD IS CANVAS NODES NOW (ENG-6306) — the last page of a three-page film
// that `--scope sequence` stitches into one mp4. It used to be composited into
// the recording's bytes, and this header used to argue for that as an honest
// trade. Keeping the history, because it is the reason the attempt looked
// unwise and it names what has to stay fixed:
//
// Three earlier attempts at the canvas route did not render. The read-back
// showed an `<image>` coming back as a 79x79 SQUARE rectangle with a pattern
// fill instead of the 282x79 asked for, the tagline text node missing from the
// scene entirely, and only two of the nodes receiving their opacity tracks —
// so the card was invisible at every point in the clip while every command
// reported success.
//
// What makes the canvas route safe this time is that those three failures are
// now ASSERTED AGAINST THE REAL PARSER, not hoped for. The chrome golden
// (`demo_markup.chrome.golden.xml`) is parsed in
// `tests/vitest/utils/markup/demoVideoCompilerContract.test.ts`, which checks
// the mark lands at the authored box (not merely square), that the tagline and
// url nodes both exist, and that the quiet tone survives as a real opacity.
// A silent regression to any of the three reds that test.
const { execFileSync } = require('node:child_process');

//: WHAT THIS MODULE USED TO DO. It composited the closing card into the
//: recording's own bytes: render the card as a page in Playwright, screenshot
//: it, extend the clip's tail with ffmpeg and cross-fade the card over it.
//:
//: That is deleted (ENG-6306). The card is a PAGE now — the last page of a
//: three-page canvas that `--scope sequence` stitches into one mp4 — so the
//: same facts reach the same film as editable nodes instead of baked pixels.
//: `outroSeconds`, `extendTail`, `outroMarkup` and `outroMotion` went with it,
//: along with this module's browser launch and its ffmpeg pass; the
//: `NON_PRODUCT_LAUNCHERS` exemption they needed is gone from
//: `test/browser-and-mux.test.js` too.
//:
//: What survives is the brand READ, because the facts are still the facts.

function brandCard(brandId) {
  const raw = execFileSync('moda', ['brand', 'show', brandId, '--json'], { encoding: 'utf8', maxBuffer: 32 << 20 });
  return cardFromKit(JSON.parse(raw.trim().split('\n').filter((l) => l.startsWith('{')).pop()).brand_kit);
}

/**
 * The card, from a `moda brand show --json` kit. Split from the shell call so
 * it can be tested against the REAL wire shape — the field names here are the
 * public response's, not the internal structured-data ones, and reading the
 * wrong one is exactly how the mark silently vanished once already.
 */
function cardFromKit(kit) {
  // A kit carries a palette per MODE, so a flat label lookup keeps whichever
  // came last — which silently returned the dark-mode value and inverted the
  // card. Scoped to the kit's own default.
  const mode = kit.default_color_mode || 'light';
  const byLabel = Object.fromEntries(
    (kit.colors || []).filter((c) => (c.mode || mode) === mode).map((c) => [c.label, c.color])
  );

  // The LOGO decides the ground, not the other way round. This kit ships only
  // "Logo (Dark)" — a dark-coloured mark — so a card on the inverted ground would
  // have a hole where the logo is. Pick the mark, then a ground it shows on.
  const logos = (kit.logos || []).flatMap((g) => g.images || []);
  const wordmark = logos.filter((l) => !/icon/i.test(l.name));
  const logo = wordmark[0] || logos[0] || null;
  const logoIsDark = logo ? /dark/i.test(logo.name) : true;
  return {
    background: logoIsDark ? byLabel['bg-primary'] || '#ffffff' : byLabel['bg-inverted'] || '#0a090a',
    ink: logoIsDark ? byLabel['text-primary'] || '#0a090a' : byLabel['bg-primary'] || '#ffffff',
    // THE DURABLE `file_` ID, not the preview URL. The kit already carries one
    // for every image, and it is what markup and media inputs are supposed to
    // take. Downloading the preview and re-uploading it was a round trip that
    // could fail while the source file was perfectly accessible, and it saved
    // every logo as `brand-mark.png` regardless of what the bytes were — an
    // SVG or a JPEG declared as PNG is an unrenderable mark.
    // `id`, which is the PUBLIC wire field. `_public_logo_groups` rebuilds each
    // image as `{name, id, uuid, url}` where `id` is the encoded `file_` ref —
    // there is no `file_id` on that shape, and the CLI's own `brand show`
    // renderer reads `id` too. Reading `file_id` returned null for every logo,
    // so the mark vanished from every close page and a logo-only kit lost its
    // close entirely, with a zero exit. Exactly the failure this module's
    // header is a monument to.
    //
    // It degrades correctly: `_public_logo_groups` OMITS `id` for an image
    // whose File row did not validate (it sets `url_unavailable` instead), so
    // an unusable mark becomes no mark rather than a 422 at publish.
    logoFileId: logo ? logo.id ?? null : null,
    tagline: kit.tagline || '',
    url: (kit.company_url || '').replace(/^https?:\/\//, ''),
    font: ((kit.fonts || []).find((f) => f.label === 'display' && f.supported)
        || (kit.fonts || []).find((f) => f.label === 'heading' && f.supported) || {}).family,
  };
}

module.exports = { brandCard, cardFromKit };
