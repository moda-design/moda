// GATE 2 · capture — take a CONVERGED flow the rest of the way.
//
// The pipeline's own sequencing is `repaired passing flow -> authoritative
// capture -> good video`, so this consumes Gate 1's output rather than
// re-deriving it.
//
// The RESET is the load-bearing part of the lifecycle: capture runs in a FRESH
// browser context, so the authoritative recording cannot contain the wreckage of
// the search for a working flow. Probe and capture are different runs, by
// construction, not by discipline.
import { createRequire } from 'node:module';
import { chromium } from 'playwright';

const _req = createRequire(import.meta.url);
const { enterText } = _req('./src/steps.js');
const { ffmpeg: FFMPEG, ffprobe: FFPROBE } = _req('./src/bin.js');
const { isBusy } = _req('./src/busy.js');
const { projectActions } = _req('./src/ledger.js');
import { readFileSync, writeFileSync, mkdirSync, renameSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolveStorageState } from './auth.mjs';

const VIEWPORT = { width: 1280, height: 800 };
//: Render the page at 2x and record at 1x, so the frames are DOWNSAMPLED from a
//: retina raster rather than rasterized at output size. Text and icons are
//: visibly cleaner; it does not add pixels.
//:
//: It cannot add pixels, and that is worth writing down because the obvious fix
//: does not work. A punch-in on a recording captured at the OUTPUT size is pure
//: upscale — 2.2x on 1280x800 shows 581x363 real pixels blown back up — so the
//: instinct is to record at 2560x1600. Playwright will not: `recordVideo.size`
//: scales the page picture DOWN to fit and never up, so a 1280-CSS-px viewport
//: in a 2560x1600 video is drawn at natural size in the corner of an empty
//: frame. Measured, and it looks exactly as broken as it sounds.
//:
//: Real options, neither free: a 2560x1600 VIEWPORT (a genuine 27-inch layout,
//: but it changes breakpoints and doubles the canvas), or a recorder that is not
//: Playwright's. Until then a punch-in is an upscale, and that is the ceiling on
//: how sharp a zoomed frame can be.
const RENDER_SCALE = 2;
//: These three are ONE setting, not three, because the wide beat between two
//: punch-ins is arithmetic on them:
//:
//:     beat = HOLD_AFTER + click overhead - hold_sec - release_sec
//:
//: which at 900/0.6/0.25 is 0.11s on EVERY demo — three frames of wide, the
//: pulse that made the camera unusable. It is structural, not a property of any
//: one take, and HOLD_BEFORE is not in the expression at all.
//:
//: `HOLD_BEFORE` was 1100 "so the zoom has something to ease into", which it
//: never did: the rise is tied to move_start->arrival, so a stationary dwell
//: after arrival lands entirely on the FLAT top. Measured on a real take the
//: camera snapped in over 0.18s and then stared for 1.7s — the inverse of the
//: intent. The glide now carries that time instead, so the rise is a real move
//: and the dwell at peak lands at 0.9s, inside the 0.5-1.0s the references hold.
const GLIDE_MS = 500;       // the cursor's travel — this IS the zoom's rise
const HOLD_BEFORE = 300;    // settle before the click, not a stare
const HOLD_AFTER = 1100;    // let the result register AND buy the wide beat back
const END_HOLD = 700;
const SCROLL_MS = 420;    // an off-screen target is scrolled to, never jumped to       // the last frames before the card; see the note at the call site
//: How much of the starting state to keep before the cursor first moves. Enough
//: to read the page, not enough to wait on it.
const LEAD_IN_SEC = 0.9;

/**
 * "Is the async work done?" — PORTED from the reference generator's
 * `awaitQuiescence` (`kleo-autogen-feature-demo/src/recorder.js`).
 *
 * Keyed on NETWORK, not DOM, and its comment explains why better than a rewrite
 * could: the generation is backend work (requests in flight), whereas a "learn
 * while you wait" splash with rotating sample prompts is pure client-side
 * animation — the DOM churns forever while nothing is happening. Waiting on DOM
 * quiet never resolves; waiting on network quiet does.
 *
 * `minWaitMs` stops it resolving instantly before the request has even been
 * issued; `maxWaitMs` caps a page that never goes quiet.
 */
async function awaitQuiescence(page, { quietMs = 3000, maxWaitMs = 120000, minWaitMs = 1500 } = {}) {
  let inflight = 0;
  let lastNet = Date.now();
  const onReq = () => { inflight += 1; lastNet = Date.now(); };
  const onDone = () => { inflight = Math.max(0, inflight - 1); lastNet = Date.now(); };
  page.on('request', onReq);
  page.on('requestfinished', onDone);
  page.on('requestfailed', onDone);
  const start = Date.now();
  let sawBusy = false;
  while (Date.now() - start < maxWaitMs) {
    const elapsed = Date.now() - start;
    if (elapsed >= minWaitMs && inflight === 0 && Date.now() - lastNet >= quietMs) {
      // QUIET IS NOT DONE. On an agent app the stream between turns goes silent
      // while the product is still generating, and the recorder used to stop
      // there — one take ended on "Designing. Please wait to edit" and scored
      // 3/10, where the run before it happened to be quick and reached 7/10
      // from the identical flow. The difference was how long the product took,
      // which is the one thing a fixed quiet window cannot adapt to.
      const busy = await isBusy(page);
      if (!busy.busy) break;
      if (!sawBusy) {
        sawBusy = true;
        console.log(`    network went quiet but the page says "${busy.by}" — still waiting`);
      }
    }
    await page.waitForTimeout(300);
  }
  page.off('request', onReq);
  page.off('requestfinished', onDone);
  page.off('requestfailed', onDone);
  return Date.now() - start;
}

/**
 * Bring an off-screen target into view by SCROLLING to it, over real time.
 *
 * Playwright scrolls implicitly before it acts, and that scroll is a teleport:
 * measured on a real take, the page jumped 424px in a single frame, held, then
 * jumped another 68px — three moving frames out of 47. At 30fps that is a cut,
 * not a camera move, and it is the first thing a viewer sees.
 *
 * Doing it explicitly and early also means the cursor glide that follows starts
 * from a settled page, so the two motions do not fight.
 *
 * Native `scroll-behavior: smooth` is not enough on its own — plenty of pages
 * override it, and its duration is not ours to choose — so the steps are driven
 * here.
 */
async function scrollIntoFrame(page, box, { ms = SCROLL_MS } = {}) {
  const need = await page.evaluate(
    ([top, height, h]) => {
      const margin = h * 0.18; // land it inside the frame, not flush to the edge
      if (top >= margin && top + height <= h - margin) return 0;
      const target = top - (h - height) / 2;
      return Math.round(Math.max(0, Math.min(target + window.scrollY, document.body.scrollHeight - h)) - window.scrollY);
    },
    [box.y, box.height, 800]
  );
  if (!need) return 0;
  return smoothScrollBy(page, need, { ms });
}

/**
 * Scroll by `delta` over real time, easing in and out.
 *
 * Shared with `scrollIntoFrame` so a `scroll` STEP and an implicit scroll-to-
 * target move the page identically — a demo should not have two scroll feels.
 */
async function smoothScrollBy(page, delta, { ms = SCROLL_MS } = {}) {
  if (!delta) return 0;
  const steps = Math.max(2, Math.round(ms / 16));
  const from = await page.evaluate(() => window.scrollY);
  for (let i = 1; i <= steps; i++) {
    const k = i / steps;
    const e = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2; // easeInOutQuad
    await page.evaluate((y) => window.scrollTo(0, y), Math.round(from + delta * e));
    await page.waitForTimeout(ms / steps);
  }
  await page.waitForTimeout(120); // let it settle before the cursor moves
  return page.evaluate(() => window.scrollY).then((to) => to - from);
}

/**
 * Move the cursor over a real span of time.
 *
 * `page.mouse.move(x, y, {steps})` has no delay between steps, so it dispatches
 * all of them in one go — 0.18s measured for 22 steps, which the camera tracks
 * as a snap. Playwright exposes no timed move, so the wait is ours, and the
 * position has to be tracked here because nothing reads it back.
 */
async function glide(page, from, x, y, ms = GLIDE_MS) {
  const steps = Math.max(2, Math.round(ms / 16));
  for (let i = 1; i <= steps; i++) {
    const k = i / steps;
    // easeInOutQuad: a cursor that accelerates away and settles reads as a hand,
    // and it also puts most of the travel in the middle of the rise.
    const e = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
    await page.mouse.move(from.x + (x - from.x) * e, from.y + (y - from.y) * e);
    await page.waitForTimeout(ms / steps);
  }
}

export async function capture({ id, flow, start, outDir, storageState, stepMinDurations }) {
  mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch({ headless: true, args: ['--enable-unsafe-webgpu','--ignore-gpu-blocklist','--enable-gpu'] });
  // FRESH context — this is the reset.
  const ctx = await browser.newContext({
    // Resolved by the caller so probe and capture cannot end up on different
    // sessions; falls back here so `capture()` stays usable on its own.
    storageState: storageState ?? resolveStorageState(start).path,
    viewport: VIEWPORT, userAgent: 'kleodemobot',
    deviceScaleFactor: RENDER_SCALE,
    recordVideo: { dir: outDir, size: VIEWPORT },
  });
  const page = await ctx.newPage();
  // a visible cursor, so the footage reads as a demonstration rather than as jump cuts
  await page.addInitScript(() => {
    const put = () => {
      if (document.getElementById('__cur')) return;
      const d = document.createElement('div');
      d.id = '__cur';
      d.style.cssText = 'position:fixed;z-index:2147483647;width:22px;height:22px;margin:-11px 0 0 -11px;border-radius:50%;background:rgba(255,255,255,.9);box-shadow:0 0 0 2px rgba(0,0,0,.55),0 2px 8px rgba(0,0,0,.4);pointer-events:none;transition:transform .08s linear,opacity .18s ease;opacity:1;left:-100px;top:-100px';
      document.body.appendChild(d);
      addEventListener('mousemove', (e) => { d.style.left = e.clientX + 'px'; d.style.top = e.clientY + 'px'; }, true);
      addEventListener('mousedown', () => { d.style.transform = 'scale(.7)'; }, true);
      addEventListener('mouseup', () => { d.style.transform = 'scale(1)'; }, true);
      // TYPING HIDES THE CURSOR. It clicks into the middle of the field and
      // then stays there while text streams out from the left, so the ring sits
      // on top of the sentence being typed — measured on a real take, it
      // occluded a character of "Moda x Claude Code" in every frame of the fill.
      // A person's hands are on the keyboard at that moment anyway, so fading
      // it out is both more legible and more truthful than parking it somewhere.
      window.__curTyping = (on) => { d.style.opacity = on ? '0' : '1'; };
    };
    if (document.body) put(); else addEventListener('DOMContentLoaded', put);
  });

  const t0 = Date.now();
  const ms = () => Date.now() - t0;
  const ledger = [];
  let issued = 0;

  await page.goto(start, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(3000);
  const setupDone = ms();

  const cursor = { x: 0, y: 0 };   // nothing reads the pointer back, so track it
  for (let i = 0; i < flow.steps.length; i++) {
    const s = flow.steps[i];
    issued++;
    const rec = { index: i, type: s.action === 'press' ? 'key' : s.action, label: s.why || s.action, tStart: ms() };
    try {
      if (s.action === 'wait') {
        // A completion wait: hold the recording until the async result lands, so
        // the video does not end mid-generation. The long loading footage is
        // what `compressIdleGaps` is for; the reveal at the end stays full speed.
        const t0 = Date.now();
        let how;
        if (s.untilGone) {
          // WAITING FOR A SPINNER TO CLEAR IS THE ONE THAT WORKS ON MODA.
          //
          // The ported `awaitQuiescence` keys on HTTP request events, which is
          // right for the reference's targets but wrong here: Moda streams the
          // agent's progress over a WEBSOCKET, so no `request` fires while it
          // works and the page reads as quiet within seconds. Measured — the wait
          // returned after 7.2s with "Thinking…" still on screen and the demo
          // ended mid-generation.
          // APPEAR, then clear. `waitFor({state:'hidden'})` resolves instantly on
          // an element that is not in the DOM yet, and after a click the agent
          // takes a beat to start working — measured, the second wait of a
          // five-step flow returned in 0.0s and the take ended before anything
          // was designed. So: give it a window to show up (absence there is
          // fine — the work may already be done), and only then wait it out.
          const spinner = page.locator(s.untilGone).first();
          const appeared = await spinner
            .waitFor({ state: 'visible', timeout: s.appearMs || 15_000 })
            .then(() => true)
            .catch(() => false);
          if (appeared) await spinner.waitFor({ state: 'hidden', timeout: s.maxMs || 180_000 }).catch(() => {});
          how = `for ${JSON.stringify(s.untilGone)} to ${appeared ? 'clear' : 'appear (it never did)'}`;
        } else if (s.selector) {
          await page.locator(s.selector).first().waitFor({ state: 'visible', timeout: s.maxMs || 180_000 }).catch(() => {});
          how = 'for the result to appear';
        } else {
          await awaitQuiescence(page, { quietMs: s.quietMs || 3000, maxWaitMs: s.maxMs || 180_000 });
          how = 'for the network to go quiet';
        }
        console.log(`    waited ${((Date.now() - t0) / 1000).toFixed(1)}s ${how}`);
      } else if (s.action === 'press') { await page.keyboard.press(s.key || 'Enter'); }
      // A `scroll` step had NO handler here at all. `validate.js` knows the
      // action and executes it, so a flow containing one passed the gate and
      // then fell into the branch below, which dereferences `s.locator` a
      // scroll step does not have. This is the same validate/capture
      // divergence that `steps.js` exists to prevent, in a different action:
      // the walk performs something the recording does not.
      else if (s.action === 'scroll') {
        const moved = await smoothScrollBy(page, s.dy ?? 400);
        console.log(`    scrolled ${moved}px`);
      } else {
        const loc = page.locator(s.locator).first();
        await loc.waitFor({ state: 'visible', timeout: 8000 });
        // Scroll FIRST, then re-measure: the box moves when the page does.
        const rough = await loc.boundingBox();
        if (rough) await scrollIntoFrame(page, rough);
        const box = await loc.boundingBox();
        if (box) {
          const x = Math.round(box.x + box.width / 2), y = Math.round(box.y + box.height / 2);
          rec.moveStartT = ms();
          await glide(page, cursor, x, y);
          cursor.x = x; cursor.y = y;
          rec.arrivalT = ms();
          await page.waitForTimeout(HOLD_BEFORE);
          rec.clickT = ms();
          rec.clickX = x; rec.clickY = y;
          rec.box = { x: +box.x.toFixed(2), y: +box.y.toFixed(2), width: +box.width.toFixed(2), height: +box.height.toFixed(2) };
          rec.selectorType = s.locator.startsWith('role=') ? 'role' : 'css';
          rec.selector = s.locator;
          rec.identityResolved = true;
          // Measured during VALIDATION, not here — see src/validate.js. Taking
          // screenshots mid-capture would risk a hitch in the footage.
          if (s.resultBox) rec.resultBox = s.resultBox;
        }
        if (s.action === 'click') await loc.click({ timeout: 8000 });
        else if (s.action === 'fill') {
          // Fade the cursor out for the duration of the typing — it clicked into
          // the middle of the field and would otherwise sit on top of the text.
          const fade = (on) => page.evaluate((v) => {
            if (!window.__curTyping) return false;
            window.__curTyping(v);
            return true;
          }, on).catch(() => false);
          // Recorded, not assumed: the overlay lives in an init script that a
          // page can fail to receive, and a check that reads "clean" because a
          // flag is missing is worse than one that says it could not tell.
          rec.cursorHiddenWhileTyping = await fade(true);
          // Shared with validation — see src/steps.js. Typing is visible where a
          // control accepts keystrokes and a plain value is set where it does not.
          try {
            rec.enteredVia = await enterText(loc, s.text, { visible: true, typeDelayMs: s.typeDelayMs ?? 45 });
          } finally {
            await fade(false);
          }
        }
      }
      // HOLD_AFTER is the FLOOR, never the whole wait. When the narration for
      // this step has already been voiced and measured, the step has to last
      // long enough for its line to land — that is the inversion: the video is
      // paced to the script, not the script squeezed into the video.
      //
      // HOLD_AFTER stays a floor because it is load-bearing elsewhere: the wide
      // beat between two punch-ins is `HOLD_AFTER + click overhead - hold_sec -
      // release_sec`, and dropping below it makes the camera pump.
      // SCROLL TO THE RESULT, not just to the control.
      //
      // `scrollIntoFrame` above puts the TARGET in view before acting. What the
      // action produces can be somewhere else entirely, and on the QR tool it is
      // below the fold: the code occupies y 0.77-1.00, so its bottom is cut off
      // by the viewport and no camera move can recover it — the camera cannot
      // pan to pixels the page never rendered. The demo then never shows the
      // thing it is about.
      //
      // The result region was measured during validation, so this is a scroll to
      // a known box rather than a guess. It happens BEFORE the hold, so the
      // result is settled and centred for however long the step lasts.
      if (s.resultBox && (s.resultBox.y + s.resultBox.height > 0.92 || s.resultBox.y < 0.06)) {
        await scrollIntoFrame(page, {
          y: s.resultBox.y * 800,
          height: Math.max(1, s.resultBox.height * 800),
        });
      }

      const needSec = stepMinDurations?.[i] ?? 0;
      // MEASURE FROM WHERE THE LINE STARTS, not from where the step does.
      //
      // `src/narrate.js` plays the first line from the cursor's move-start and
      // every later line from the CLICK. Budgeting from `tStart` therefore
      // spent the cursor glide and the pre-click dwell — about 1.6s — out of a
      // budget the line never gets. Measured on a real take: the step was held
      // for exactly its 6.57s budget and the 6.27s line still reported
      // "OVERRUNS by 1.33s", because its actual slot ran from the click and was
      // 4.94s. Two anchors for one number is what "sync by construction" was
      // supposed to rule out.
      //
      // A `wait` has no click, and narrate falls back to the step start for it
      // in exactly the same way.
      const lineStart = i === 0 ? (rec.moveStartT ?? rec.tStart) : (rec.clickT ?? rec.tStart);
      const spent = ms() - lineStart;
      // The LAST step does not pay HOLD_AFTER. Its whole job is to buy a wide
      // beat before the NEXT punch-in, and after the final action there is no
      // next one — so it is dead air on a finished screen, right where a
      // reviewer of the output complained the demo "holds a finished state with
      // nothing advancing". The narration floor still applies if a line is
      // still landing.
      const floor = i === flow.steps.length - 1 ? END_HOLD : HOLD_AFTER;
      await page.waitForTimeout(Math.max(floor, Math.round(needSec * 1000) - spent));
      rec.tEnd = ms();
      ledger.push(rec);
    } catch (e) {
      rec.tEnd = ms(); rec.failed = String(e.message).split('\n')[0].slice(0, 200);
      ledger.push(rec);
      // SAY SO. This used to break silently: the failed action was dropped by
      // the bridge, the timeline simply came out shorter than the flow, and
      // nothing anywhere said a step had thrown. A plain ReferenceError in this
      // file ("enterText is not defined") therefore presented as a 2.5s video of
      // one action, which is indistinguishable from a short demo. Validation
      // cannot catch this class — it has its own imports and its own browser.
      console.error(`\n  STEP ${i} FAILED (${s.action} ${s.locator ?? ''}): ${rec.failed}`);
      console.error(`  the take is void — ${i} of ${flow.steps.length} step(s) recorded.\n`);
      break;   // a converged flow should not fail here; if it does, the take is void
    }
  }
  // Long enough to land on the result rather than mid-transition, and no
  // longer. This is NOT `HOLD_AFTER`, which is already spent on the last action
  // and is load-bearing for the wide beat — do not fold the two together.
  //
  // It was 1600ms, and with HOLD_AFTER that put 2.6s of frozen final screen at
  // the end of a 10s demo. The branded card is the sign-off now, so the app does
  // not also have to hold one: 2.6s of still app plus a 2.5s card was 40% of the
  // runtime with nothing moving. `compressIdleGaps` could not save it either —
  // TAIL_KEEP protects the last 2.0s, leaving 0.57s to trim, which is under
  // MIN_GAP_SEC, so the pass correctly reported nothing to do.
  await page.waitForTimeout(END_HOLD);
  const featureDone = ms();
  const video = page.video();
  await ctx.close(); await browser.close();     // video only flushes on close
  const raw = await video.path();
  const webm = `${outDir}/${id}.webm`;
  renameSync(raw, webm);
  // TRIM THE HEAD. Measured on a real take: 9.8 of 17.6 seconds was the app
  // loading, before anything happened — 56% of the video, and the single worst
  // thing about the output. Proper re-pacing (speeding through spinners mid-clip)
  // needs an export scope the public API does not expose yet, but the LEADING
  // dead air is not a re-pace at all: nothing happens in it, so it is a cut.
  //
  // Everything downstream is in clip-relative seconds, so the trim has to shift
  // every timestamp by the same amount or the captions and the camera drift off
  // the footage they describe.
  const firstMove = ledger.length
    ? Math.min(...ledger.map((a) => a.moveStartT ?? a.tStart)) / 1000
    : 0;
  const trim = Math.max(0, firstMove - LEAD_IN_SEC);
  const shift = (sec) => +(sec - trim).toFixed(3);

  const mp4 = `${outDir}/${id}.mp4`;
  execFileSync(FFMPEG, ['-v','error',
    // -ss BEFORE -i seeks by keyframe and is fast, but it can land early and
    // leave a fraction of the dead air; the re-encode below is happening anyway,
    // so seek accurately instead and keep the timestamps honest.
    '-i',webm,'-ss',String(trim),
    '-vf',`scale=${VIEWPORT.width}:${VIEWPORT.height}`,'-r','30','-crf','18','-pix_fmt','yuv420p',mp4,'-y']);
  const durationSec = +(execFileSync(FFPROBE,['-v','error','-show_entries','format=duration','-of','default=nw=1:nk=1',mp4]).toString().trim());
  if (trim > 0) console.error(`    trimmed ${trim.toFixed(1)}s of load before the first action`);

  const clip = {
    name: id, goal: flow.goal || id, durationSec,
    viewport: VIEWPORT,
    marks: { setup_done: shift(setupDone / 1000), feature_done: shift(featureDone / 1000) },
    trimmedLeadSec: trim,
    // Failed steps are ISSUED but not RECORDED — see src/ledger.js.
    actions: projectActions(ledger, shift),
    _issued: issued,
  };
  writeFileSync(`${outDir}/${id}.timeline.json`, JSON.stringify(clip, null, 2));
  return { mp4, clip, failed: ledger.some((a) => a.failed) };
}
