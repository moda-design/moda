// The gate between discovery and recording — PORTED from the reference
// generator's `src/validate.js` (ENG-5919). Two stages:
//
//   1. STRUCTURAL, offline: every step has a known action and the fields that
//      action needs, and no click/fill is missing its selector.
//   2. DURABILITY, in a fresh headless browser with the same auth the capture
//      uses: walk the flow and EXECUTE it, requiring each selector to resolve to
//      exactly one visible element before it is used. Stops at the first
//      failure, because every later step is then testing diverged state.
//
// The capture should run only when this returns ok.
//
// Why it earns its place here. Two selector bugs shipped in the same afternoon
// and BOTH presented as a short timeline rather than as an error: a body-anchored
// CSS path that matched a different element on replay, and a `role=` selector
// built from innerText that matched nothing at all. In each case the capture
// caught the exception, broke out of its loop, and produced a recording with
// fewer actions than the flow — with nothing anywhere saying a selector had
// failed. I found both by noticing the action count by eye. This is the module
// that turns that into a named failure before a single frame is recorded.
const { enterText } = require('./steps.js');
const { checkPageHealth } = require('./page-health.js');

const VISIBLE_TIMEOUT_MS = 5000;
const KNOWN = new Set(['click', 'fill', 'press', 'wait', 'scroll']);
//: Below this, the field held a placeholder or a word, not content worth
//: keeping — clearing it reads as ordinary editing rather than as demolition.
const CLOBBER_MIN_CHARS = 80;
//: The size everything here measures at, and the size the capture records at.
//: They must agree: a region measured against one viewport and framed against
//: another is a punch-in aimed at the wrong part of the page.
const VIEWPORT = { width: 1280, height: 800 };
//: Below this fraction of changed pixels between the first and last frame, the
//: demo has no before/after worth showing.
const MIN_NET_CHANGE = 0.02;
//: Two states this close are the same state. A step that lands back on one the
//: video has already shown spends its time going nowhere — the viewer watches a
//: control being exercised rather than a product doing something.
//:
//: `netChange` only compares the FIRST and LAST frame, so a flow that wanders
//: away and comes back mid-way passes it as long as it ends somewhere new. That
//: is exactly what a theme picker demo does: light, dark, and back to light.
const SAME_STATE = 0.02;

/** Stage 1: everything checkable without a browser. Collects ALL errors. */
function validateStructural(flow) {
  const errors = [];
  if (!flow || !Array.isArray(flow.steps) || flow.steps.length === 0) {
    return { ok: false, errors: ['flow.steps must be a non-empty array'] };
  }
  flow.steps.forEach((s, i) => {
    if (!s || !KNOWN.has(s.action)) {
      errors.push(`step ${i}: unknown action ${JSON.stringify(s && s.action)}`);
      return;
    }
    if ((s.action === 'click' || s.action === 'fill') && !s.locator) {
      // Discovery emits no step at all when it cannot find a durable selector,
      // so one arriving here means the flow was hand-edited.
      errors.push(`step ${i}: ${s.action} has no locator`);
    }
    if (s.action === 'fill' && !s.text) errors.push(`step ${i}: fill has no text`);
    if (s.action === 'wait' && !s.untilGone && !s.selector && !s.quietMs) {
      errors.push(`step ${i}: wait needs untilGone, selector, or quietMs`);
    }
  });
  return { ok: errors.length === 0, errors };
}

//: Below this share of sampled pixels, whatever moved is not a result.
const NEGLIGIBLE_CHANGE = 0.001;
//: And below this bounding-box area, kept from the original test so a genuinely
//: small change (a checkbox, a badge) is still admitted on extent alone.
const NEGLIGIBLE_AREA = 0.0004;

/**
 * Did this step change nothing?
 *
 * Two ways to be nothing, because a bounding box is the EXTENT and not the
 * amount: two tiny changes at opposite corners bound a quarter of the page. A
 * near-zero SHARE of moved pixels is inert however large a box it spans.
 */
function isInert(region) {
  if (!region) return true;
  if (region.changed != null && region.changed < NEGLIGIBLE_CHANGE) return true;
  return region.width * region.height < NEGLIGIBLE_AREA;
}

/** Does this selector name exactly one visible thing, right now? */
async function resolvesUniquely(page, locator) {
  try {
    await page.locator(locator).first().waitFor({ state: 'visible', timeout: VISIBLE_TIMEOUT_MS });
  } catch {
    return { ok: false, why: `did not become visible within ${VISIBLE_TIMEOUT_MS}ms` };
  }
  const n = await page.locator(locator).count();
  // EXACTLY one. `.first()` on an ambiguous selector silently picks whichever
  // the DOM happens to order first, which is how a replay clicks the wrong
  // element and still reports success.
  if (n !== 1) return { ok: false, why: `matches ${n} elements, not exactly one` };
  return { ok: true };
}

/**
 * The bounding box of everything that CHANGED after a step, normalized.
 *
 * Measured here because validation already walks and executes the flow in a
 * browser nobody is filming — the recording pays nothing for it, and taking
 * screenshots mid-capture would risk a hitch in the footage.
 *
 * This is what tells the camera whether a punch-in can actually show the result.
 * The camera frames the CLICK, and on a page whose result sits elsewhere that
 * hides the payoff: measured on the CSS gradient tool, every step changed a
 * region spanning 0.67-0.99 of the page against the 0.645 a 1.55x punch-in
 * leaves visible, so the gradient preview was off-screen for most of the video.
 *
 * The diff runs in the page on a canvas. ffmpeg's `cropdetect` was tried first
 * and silently reported no change for every pair, including frames that plainly
 * differed.
 */
async function changedRegion(page, before, after, w, h, ignore) {
  return page.evaluate(
    async ([a, b, W, H, skip]) => {
      const load = (src) =>
        new Promise((res) => {
          const i = new Image();
          i.onload = () => res(i);
          i.src = src;
        });
      const [ia, ib] = await Promise.all([load(a), load(b)]);
      const data = (img) => {
        const c = document.createElement('canvas');
        c.width = W;
        c.height = H;
        c.getContext('2d').drawImage(img, 0, 0, W, H);
        return c.getContext('2d').getImageData(0, 0, W, H).data;
      };
      const pa = data(ia);
      const pb = data(ib);
      let x0 = W, y0 = H, x1 = -1, y1 = -1;
      let hits = 0;
      let seen = 0;
      for (let y = 0; y < H; y += 2) {
        for (let x = 0; x < W; x += 2) {
          // IGNORE THE CONTROL ITSELF. A focus ring, a caret, a pressed state —
          // all change pixels, none of them is a RESULT. Counting them made
          // "did this step do anything" answer yes for a step that set a colour
          // to the value it already had, three times before this was noticed.
          if (skip && x >= skip.x && x <= skip.x + skip.width && y >= skip.y && y <= skip.y + skip.height) continue;
          seen++;
          const i = (y * W + x) * 4;
          // 24 tolerates antialiasing and the cursor's own shadow; a real UI
          // change is far larger than that.
          if (Math.abs(pa[i] - pb[i]) + Math.abs(pa[i + 1] - pb[i + 1]) + Math.abs(pa[i + 2] - pb[i + 2]) > 24) {
            hits++;
            if (x < x0) x0 = x;
            if (x > x1) x1 = x;
            if (y < y0) y0 = y;
            if (y > y1) y1 = y;
          }
        }
      }
      if (x1 < 0) return null;
      // `changed` is the SHARE OF SAMPLED PIXELS that moved, and it is what
      // decides whether anything happened. The box is the extent, which the
      // camera needs — and which is a terrible measure of amount: two small
      // changes at opposite corners span a box covering a quarter of the page.
      return { x: x0 / W, y: y0 / H, width: (x1 - x0) / W, height: (y1 - y0) / H, changed: hits / seen };
    },
    [before, after, w, h, ignore]
  );
}

/** What is already in this control, before the flow writes to it? */
async function currentValue(locator) {
  return locator.evaluate((el) => {
    if (el.isContentEditable) return el.textContent || '';
    return 'value' in el ? String(el.value ?? '') : '';
  }).catch(() => '');
}

/**
 * What fraction of the page differs between two shots?
 *
 * `changedRegion` answers "where", which is what the camera needs. This answers
 * "how much", which is what tells you whether the demo went anywhere at all.
 */
async function changedFraction(page, before, after, w, h) {
  return page.evaluate(
    async ([a, b, W, H]) => {
      const load = (src) => new Promise((res) => { const i = new Image(); i.onload = () => res(i); i.src = src; });
      const [ia, ib] = await Promise.all([load(a), load(b)]);
      const data = (img) => {
        const c = document.createElement('canvas');
        c.width = W; c.height = H;
        c.getContext('2d').drawImage(img, 0, 0, W, H);
        return c.getContext('2d').getImageData(0, 0, W, H).data;
      };
      const pa = data(ia); const pb = data(ib);
      let diff = 0; let seen = 0;
      for (let y = 0; y < H; y += 2) {
        for (let x = 0; x < W; x += 2) {
          const i = (y * W + x) * 4;
          seen++;
          if (Math.abs(pa[i] - pb[i]) + Math.abs(pa[i + 1] - pb[i + 1]) + Math.abs(pa[i + 2] - pb[i + 2]) > 24) diff++;
        }
      }
      return seen ? diff / seen : 0;
    },
    [before, after, w, h]
  );
}

async function execStep(page, s) {
  const loc = s.locator ? page.locator(s.locator).first() : null;
  switch (s.action) {
    case 'click':
      await loc.click({ timeout: 8000 });
      break;
    case 'fill':
      // The SAME executor the capture uses. Two implementations diverged once
      // and validation certified a flow the recording did not perform.
      await enterText(loc, s.text, { visible: false });
      break;
    case 'press':
      await page.keyboard.press(s.key || 'Enter');
      break;
    case 'scroll':
      await page.mouse.wheel(0, s.dy || 400);
      break;
    case 'wait':
      // Validation only has to advance the state far enough for the NEXT
      // selector to be checkable, so it does not sit out a full generation.
      // Whether the real wait resolves is the capture's problem, not a
      // durability property of the flow.
      await page.waitForTimeout(Math.min(s.maxMs ?? 3000, 8000));
      break;
  }
}

/**
 * Walk the flow in a real browser and report the first step that would break.
 *
 * Returns `{ ok }` or `{ ok: false, stage, step, reason }`.
 */
async function validateFlow({ flow, startUrl, storageState, chromium }) {
  const structural = validateStructural(flow);
  if (!structural.ok) return { ok: false, stage: 'structural', errors: structural.errors };

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ storageState, viewport: VIEWPORT });
  const page = await context.newPage();
  const done = (r) => browser.close().then(() => r);
  const resultBoxes = {};
  const noOps = [];
  const offscreen = [];
  const clobbered = [];
  const revisited = [];
  //: Where each step's control sits, so the flow's SHAPE can be judged before a
  //: frame is recorded. The recorder measures click coordinates too, but only
  //: once it has driven the app — by then a widget tour has already cost a take.
  const clickPoints = [];
  //: Page defects are checked at BOTH ends of the walk: some are true on load
  //: (a dev overlay), and some only appear once the flow has produced content
  //: (an image the demo itself renders). Checking once at either end misses one.
  const health = { brokenImages: [], overlays: [], issueBadges: [] };
  const absorb = (h) => {
    for (const k of Object.keys(health)) health[k].push(...h[k]);
  };

  try {
    await page.goto(startUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(2500);
    absorb(await checkPageHealth(page));
    //: The state the viewer sees in frame one. Compared against the last frame
    //: below, this is the demo's whole before/after in a single number.
    // A THROWAWAY FULL-PAGE SHOT FIRST, so the baseline is in the same state as
    // every shot that follows it.
    //
    // `fullPage: true` reflows the page — the bug behind ENG-6025, in a second
    // place. Each step takes one, so every later shot carries the reflow while
    // this baseline did not, leaving a permanent ~2.25% difference between the
    // opening state and everything after. That is above `MIN_NET_CHANGE`, so a
    // demo that truly ends where it began measured as having gone somewhere,
    // and a step returning to the opening state was never recognised as a
    // revisit. Taking one here puts the baseline on the same footing.
    await page.screenshot({ fullPage: true });
    const openingShot = 'data:image/png;base64,' + (await page.screenshot()).toString('base64');
    //: Every state the video will show, in order, so a later one can be
    //: recognised as somewhere the viewer has already been.
    const states = [{ step: -1, shot: openingShot, label: 'the opening state' }];

    for (const [i, s] of flow.steps.entries()) {
      if (s.locator) {
        const check = await resolvesUniquely(page, s.locator);
        if (!check.ok) {
          return done({ ok: false, stage: 'durability', step: i, locator: s.locator, reason: check.why });
        }
      }
      // A DEMO THAT OPENS BY DELETING WHAT IS ON SCREEN tells its story
      // backwards. Measured on the markdown publisher: the app seeds a rich
      // sample doc — feature table, code block, contents card — and the flow's
      // first act was to clear it and type four thinner lines. The critique's
      // top finding was that the end state looked like a downgrade from the
      // start state, "which inverts the story". Every other signal was happy:
      // the selector resolved, the region changed, nothing errored.
      //
      // No camera or pacing work can fix this; it is the flow being wrong. So
      // it is caught here, before a frame is recorded, and it is deterministic
      // — the field either had content or it did not.
      if (s.action === 'fill') {
        const existing = (await currentValue(page.locator(s.locator).first())).trim();
        if (existing.length >= CLOBBER_MIN_CHARS) {
          clobbered.push({ step: i, chars: existing.length });
        }
      }
      try {
        const shot = async () => 'data:image/png;base64,' + (await page.screenshot()).toString('base64');
        //: The viewport shot is what the CAMERA needs — its coordinates are
        //: viewport-relative and the punch-in maths depends on that. The
        //: full-page shot is only ever used to tell "inert" from "off screen".
        const shotFull = async () => 'data:image/png;base64,' + (await page.screenshot({ fullPage: true })).toString('base64');
        // EVERY step, not just the ones with a locator. Gating this on
        // `s.locator` made `scroll` and `press` structurally invisible to the
        // no-op check: a scroll of a page that does not scroll passed silently
        // and the recording held on a frozen frame for 11 of its 14 seconds,
        // with the report saying "4 steps replayable, 1 with a measured result
        // region" and flagging nothing. A `wait` is exempt — waiting for
        // something that has already settled is legitimate.
        // THE FULL-PAGE SHOT GOES FIRST, and the order is the whole point.
        //
        // `page.screenshot({ fullPage: true })` reflows the page — verified
        // directly: two plain viewport screenshots taken either side of one
        // differ, with no action in between. Taking it AFTER the baseline put
        // that reflow into `after`, and the diff charged it to the click.
        //
        // That made the no-op check miss a pure no-op: clicking an already
        // active theme measured a result region covering a QUARTER of the
        // viewport, the step was recorded, and the demo opened on a beat where
        // nothing happens. The offscreen fallback that needs this shot was
        // added earlier the same day, so the fix and the bug arrived together.
        const beforeFull = s.action === 'wait' ? null : await shotFull();
        const before = s.action === 'wait' ? null : await shot();
        await execStep(page, s);
        await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
        if (before) {
          await page.waitForTimeout(600); // let the result settle before measuring it
          const own = s.locator ? await page.locator(s.locator).first().boundingBox().catch(() => null) : null;
          if (own) {
            clickPoints.push({ index: i, clickX: Math.round(own.x + own.width / 2), clickY: Math.round(own.y + own.height / 2), label: s.why ?? '' });
          }
          const region = await changedRegion(page, before, await shot(), 1280, 800, own);
          resultBoxes[i] = region;

          // HAVE WE BEEN HERE BEFORE? Compared against every state so far, not
          // just the previous one: a flow can revisit something several steps
          // back, and that is the case worth catching.
          const here = await shot();
          for (const prev of states) {
            if (await changedFraction(page, prev.shot, here, VIEWPORT.width, VIEWPORT.height) < SAME_STATE) {
              revisited.push({ step: i, sameAs: prev.step, what: prev.label });
              break;
            }
          }
          states.push({ step: i, shot: here, label: `the state after step ${i}` });
          // A STEP THAT CHANGES NOTHING is a step the video shows going nowhere,
          // and it is invisible in every other signal: the selector resolved,
          // the action executed, no error was raised. Two real ones shipped
          // before this existed — colour swatches typed into with keystrokes
          // they ignore, and a theme button clicked while that theme was already
          // active. Both produced a demo of a cursor doing nothing.
          //
          // The threshold is in pixels of the sampled grid, not area, so a genuine
          // but small change (a checkbox, a badge) still counts.
          if (isInert(region)) {
            // NOTHING CHANGED IN THE VIEWPORT is not the same as nothing
            // changed. The markdown publisher renders its "Published" banner
            // and the shareable URL below the fold, so Publish — the entire
            // point of that product — measured as inert. An e2e run then
            // dropped it as a no-op along with one other step, recorded the
            // single remaining hold, and produced a 3.9s video of a static
            // page that scored 2/10.
            //
            // So before calling a step inert, look at the WHOLE PAGE. A change
            // that exists but sits outside the frame is a framing problem for
            // the recording to solve by scrolling; a step that changed nothing
            // anywhere is the only one that is genuinely useless.
            const pageH = await page.evaluate(() => document.documentElement.scrollHeight);
            // The acted-on control has to be excluded here TOO, in page
            // coordinates. Passing null made a button that does nothing at all
            // report as "changed below the fold", because its own focus ring is
            // a change and the full-page diff had nothing telling it to ignore
            // the control — the exact mistake the viewport diff was fixed for.
            const capH = Math.min(pageH, 4000);
            const scrollY = await page.evaluate(() => window.scrollY);
            const skip = own && {
              x: own.x, width: own.width,
              // viewport -> page, then into the capped/scaled capture space
              y: (own.y + scrollY) * (capH / pageH),
              height: own.height * (capH / pageH),
            };
            const full = pageH > VIEWPORT.height + 4
              ? await changedRegion(page, beforeFull, await shotFull(), VIEWPORT.width, capH, skip)
              : null;
            if (full && full.width * full.height >= 0.0004) {
              // 'bottom', to match the other edge values the report interpolates
              // into "runs off the ${edge} of the viewport" — 'below' produced
              // "runs off the below of the viewport".
              offscreen.push({ step: i, edge: 'bottom', why: 'the change is entirely outside the viewport' });
            } else {
              noOps.push({ step: i, action: s.action, locator: s.locator });
            }
          } else if (region.y + region.height >= 0.995 || region.y <= 0.005) {
            // THE RESULT RUNS OFF THE VIEWPORT. Not a camera problem — the
            // camera cannot pan to pixels the page never rendered. Measured on
            // the QR tool: the code occupies y 0.77-1.00, so its bottom is cut
            // by the fold and the demo never shows the thing it is about.
            //
            // Deterministic, unlike asking a model: the frame critique caught
            // this on one take and scored the identical defect 7/10 on the next.
            offscreen.push({ step: i, edge: region.y <= 0.005 ? 'top' : 'bottom' });
          }
        }
      } catch (e) {
        return done({
          ok: false, stage: 'durability', step: i, locator: s.locator,
          reason: `execution failed: ${String(e.message).split('\n')[0].slice(0, 120)}`,
        });
      }
    }
    absorb(await checkPageHealth(page));
    // DID THE DEMO GO ANYWHERE? Every check above is per-step, and a flow can
    // pass all of them while landing exactly where it started. Measured on the
    // markdown publisher: a flow switched the preview to Midnight and then back
    // to the opening theme, so each step changed a real region and the finished
    // video's last frame was indistinguishable from its first — "anyone
    // comparing start to end sees no restyle at all".
    //
    // A round trip is a legitimate thing for a person to do and a terrible thing
    // for a demo to end on.
    const closingShot = 'data:image/png;base64,' + (await page.screenshot()).toString('base64');
    const netChange = await changedFraction(page, openingShot, closingShot, 1280, 800);
    // Deduplicate across the two passes — a defect present throughout is one
    // problem, not two.
    health.brokenImages = [...new Map(health.brokenImages.map((b) => [b.src + b.alt, b])).values()];
    health.overlays = [...new Set(health.overlays)];
    health.issueBadges = [...new Set(health.issueBadges)];
    return done({ ok: true, steps: flow.steps.length, resultBoxes, noOps, offscreen, clobbered, revisited, clickPoints, health, netChange });
  } catch (e) {
    return done({ ok: false, stage: 'durability', reason: String(e.message).split('\n')[0].slice(0, 160) });
  }
}

module.exports = { validateStructural, validateFlow, isInert, VISIBLE_TIMEOUT_MS, MIN_NET_CHANGE, SAME_STATE };
