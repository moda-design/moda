// Is the page FIT TO FILM — right now, before a frame is recorded?
//
// Distinct from validation, which asks whether the flow's steps work. These are
// defects of the page itself: present in every frame, unrelated to any step, and
// invisible to every other signal here. The selectors resolve, the regions
// change, the flow is perfect — and the video still shows a broken product.
//
// Both checks come from real takes that shipped and were scored down by a person:
//
//   - a red "1 issue" Next.js dev-overlay badge pinned to the corner of ALL 11
//     sampled frames. The frame critique called it "the product being broken
//     during the entire demo" — correctly, and only after the video existed.
//   - a brand logo rendering as a broken-image icon, on a demo whose whole point
//     was branded output.
//
// Neither needs a model and neither needs a recording: both are true of the DOM
// the moment the page loads. Catching them here costs one evaluate() and moves
// the finding from "watch the output and hope" to "told before recording".
//
// This WARNS rather than blocks. A dev badge is usually fixable by pointing the
// capture at a production build, but it is the operator's call, not ours.
//
// EVERY FRAME, not just the top one. The first version scanned `document.images`
// on the main frame and reported the markdown publisher clean — its broken brand
// logo lives in the `about:srcdoc` preview iframe, which is the one place a demo
// of a preview tool is guaranteed to point the camera. A page-health check that
// cannot see into the pane being demonstrated returns the reassuring answer for
// exactly the pages it exists to catch.

//: Bot-challenge interstitials. Not a page defect — a page that is not the
//: product at all. Worth its own detector because of how it fails otherwise:
//: on a real run the discovery agent hit a Cloudflare challenge mid-flow,
//: correctly refused to report the goal met, and then spent every remaining
//: step waiting for a page that was never going to come back on its own.
//: Twenty model calls to arrive at no flow, and nothing named the cause.
const CHALLENGE_SELECTORS = [
  'iframe[src*="challenges.cloudflare.com"]',
  '#challenge-form',
  '#challenge-running',
  '.cf-turnstile',
  '#cf-please-wait',
];
const CHALLENGE_TEXT = [
  /performing security verification/i,
  /verify (that )?you are human/i,
  /checking your browser before/i,
  /enable javascript and cookies to continue/i,
];

//: Dev-server error overlays. Each framework ships its own and they are all
//: fixed-position, high-z-index, and unmissable on camera.
const OVERLAY_SELECTORS = [
  'nextjs-portal',                      // Next.js (App Router) — hosts the badge in a shadow root
  '[data-nextjs-toast]',                // Next.js error/issue toast
  '[data-nextjs-dialog-overlay]',
  'vite-error-overlay',                 // Vite
  '#webpack-dev-server-client-overlay', // webpack
  '.redbox',                            // parcel / RN web
];

/**
 * Is this a bot challenge rather than the product?
 *
 * Checked separately from the rest because the answer changes what the caller
 * should DO: a broken image is a warning to record anyway, a challenge means
 * there is nothing here to record at all.
 */
async function checkBotChallenge(page) {
  return page.evaluate(([sels, pats]) => {
    for (const sel of sels) if (document.querySelector(sel)) return { blocked: true, by: sel };
    const text = (document.body?.innerText || '').slice(0, 4000);
    for (const src of pats) {
      const re = new RegExp(src[0], src[1]);
      if (re.test(text)) return { blocked: true, by: (text.match(re) || [''])[0].trim().slice(0, 60) };
    }
    return { blocked: false };
  }, [CHALLENGE_SELECTORS, CHALLENGE_TEXT.map((r) => [r.source, r.flags])]).catch(() => ({ blocked: false }));
}

/**
 * Everything about this page that would embarrass the demo, as a flat list.
 *
 * Returns `{ brokenImages, overlays, issueBadges }` — each an array of short
 * descriptors, empty when clean.
 */
async function checkPageHealth(page) {
  const merged = { brokenImages: [], overlays: [], issueBadges: [] };
  for (const frame of page.frames()) {
    // A cross-origin frame cannot be evaluated in, and a frame can detach
    // mid-walk. Neither is a finding — skip and keep going.
    const found = await inspectFrame(frame).catch(() => null);
    if (!found) continue;
    merged.brokenImages.push(...found.brokenImages);
    merged.overlays.push(...found.overlays);
    merged.issueBadges.push(...found.issueBadges);
  }
  merged.overlays = [...new Set(merged.overlays)];
  merged.issueBadges = [...new Set(merged.issueBadges)];
  return merged;
}

async function inspectFrame(frame) {
  return frame.evaluate((selectors) => {
    const brokenImages = [];
    for (const img of document.images) {
      // `complete` alone is not enough: a still-loading image is complete=false
      // and perfectly fine. It is complete WITH no intrinsic width that means
      // the fetch resolved to nothing renderable.
      if (!img.complete || img.naturalWidth > 0) continue;
      const box = img.getBoundingClientRect();
      // Skip images the page never puts on screen — a preloaded sprite or a
      // hidden fallback is not something the camera can film.
      if (box.width < 2 || box.height < 2) continue;
      brokenImages.push({
        src: (img.currentSrc || img.src || '(no src)').slice(-70),
        alt: img.alt || '(no alt)',
      });
    }

    const overlays = [];
    for (const sel of selectors) {
      for (const el of document.querySelectorAll(sel)) {
        // A dev overlay's host element is often present but empty until there
        // is something to report — `nextjs-portal` ships on every dev page.
        // What makes it filmable is having rendered content.
        const hasContent = el.shadowRoot ? el.shadowRoot.childElementCount > 0 : el.childElementCount > 0;
        if (hasContent) overlays.push(sel);
      }
    }

    // The generic form, for frameworks not in the list above: a small
    // fixed-position element whose entire text is an issue/error count.
    const issueBadges = [];
    for (const el of document.querySelectorAll('body *')) {
      const text = (el.textContent || '').trim();
      if (text.length > 24 || !/^\d+\s+(issue|error|warning)s?\b/i.test(text)) continue;
      const style = getComputedStyle(el);
      if (style.position !== 'fixed' && style.position !== 'absolute') continue;
      if (style.visibility === 'hidden' || style.display === 'none') continue;
      issueBadges.push(text);
    }

    return { brokenImages, overlays, issueBadges: [...new Set(issueBadges)] };
  }, OVERLAY_SELECTORS);
}

/** One line per problem, ready to print. Empty when the page is fit to film. */
function describeHealth(health) {
  const lines = [];
  for (const b of health.brokenImages) lines.push(`broken image "${b.alt}" — ${b.src}`);
  for (const o of health.overlays) lines.push(`dev error overlay on screen (${o})`);
  for (const b of health.issueBadges) lines.push(`dev issue badge on screen ("${b}")`);
  return lines;
}

module.exports = { checkPageHealth, describeHealth, checkBotChallenge, OVERLAY_SELECTORS };
