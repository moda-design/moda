// Where does the page actually CHANGE when you act on it?
//
// The camera frames the CLICK. On a page whose result sits beside the control
// that is fine; on one where the result is elsewhere the punch-in hides the
// payoff. This measures which is which instead of guessing from a contact sheet.
//
// The diff runs IN THE PAGE on a canvas. ffmpeg's cropdetect was the first
// attempt and it silently emitted nothing for every pair — including two frames
// I could see differed — so it was reporting "no change" for a page that plainly
// changed. Checked the tool against a known-different pair before believing it.
import { chromium } from 'playwright';
import { readFileSync, mkdirSync } from 'node:fs';

const [flowPath, startUrl] = process.argv.slice(2);
const flow = JSON.parse(readFileSync(flowPath, 'utf8'));
const W = 1280, H = 800;
mkdirSync('/tmp/diffshots', { recursive: true });

/** Bounding box of pixels that differ, normalized. Null if nothing moved. */
async function changedBox(page, beforeB64, afterB64) {
  return page.evaluate(async ([a, b, w, h]) => {
    const load = (src) => new Promise((res) => { const i = new Image(); i.onload = () => res(i); i.src = src; });
    const [ia, ib] = await Promise.all([load(a), load(b)]);
    const mk = (img) => { const c = document.createElement('canvas'); c.width = w; c.height = h;
      c.getContext('2d').drawImage(img, 0, 0, w, h); return c.getContext('2d').getImageData(0, 0, w, h).data; };
    const pa = mk(ia), pb = mk(ib);
    let x0 = w, y0 = h, x1 = -1, y1 = -1, n = 0;
    for (let y = 0; y < h; y += 2) {
      for (let x = 0; x < w; x += 2) {
        const i = (y * w + x) * 4;
        // 24 tolerates antialiasing and cursor shadow; a real UI change is far larger.
        if (Math.abs(pa[i] - pb[i]) + Math.abs(pa[i+1] - pb[i+1]) + Math.abs(pa[i+2] - pb[i+2]) > 24) {
          n++; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
        }
      }
    }
    return x1 < 0 ? null : { x0: x0/w, y0: y0/h, x1: x1/w, y1: y1/h, pixels: n };
  }, [beforeB64, afterB64, W, H]);
}

const b = await chromium.launch({ headless: true });
const page = await (await b.newContext({ viewport: { width: W, height: H } })).newPage();
await page.goto(startUrl, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(3000);

const BAND = 1 / 1.55; // visible fraction of the frame at DEFAULT_ZOOM_SCALE
for (const [i, s] of flow.steps.entries()) {
  if (!s.locator) continue;
  const loc = page.locator(s.locator).first();
  const box = await loc.boundingBox().catch(() => null);
  if (!box) { console.log(`  step ${i}: locator did not resolve`); continue; }
  const shot = async () => 'data:image/png;base64,' + (await page.screenshot()).toString('base64');
  const before = await shot();
  if (s.action === 'fill') await loc.fill(s.text ?? 'test');
  else await loc.click({ timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(1200);
  const after = await shot();

  const ch = await changedBox(page, before, after);
  const clickY = (box.y + box.height / 2) / H;
  if (!ch) { console.log(`  step ${i}: nothing changed`); continue; }
  // CONTAINMENT, not centre distance. The first version compared the change's
  // CENTRE to the click and called a gap under half a band "visible" — which
  // passed the gradient page's steps 1-3 even though their change SPANS 0.67 of
  // the page against a 0.645 band, i.e. cannot fit however it is positioned.
  // A centre can sit right on the click while both ends hang off the frame.
  const span = ch.y1 - ch.y0;
  const lo = Math.max(0, Math.min(clickY - BAND / 2, 1 - BAND));
  const hi = lo + BAND;
  const fits = span <= BAND;
  const contained = fits && ch.y0 >= lo - 0.01 && ch.y1 <= hi + 0.01;
  console.log(
    `  step ${i}: click y=${clickY.toFixed(2)} | change y=${ch.y0.toFixed(2)}-${ch.y1.toFixed(2)} ` +
    `(span ${span.toFixed(2)} vs band ${BAND.toFixed(2)}, ${ch.pixels} px) -> ` +
    (contained ? 'result FITS the punch-in' : fits ? '*** fits but sits outside the frame ***' : '*** TOO BIG for the punch-in ***')
  );
}
await b.close();
