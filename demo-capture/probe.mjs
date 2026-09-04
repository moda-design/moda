// Step 2 probe. A DIFFERENT run from the capture, by construction.
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { resolveStorageState } from './auth.mjs';
const flow = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const start = process.argv[3];
const auth = resolveStorageState(start);
const b = await chromium.launch({ headless: true });
const ctx = await b.newContext({ storageState: auth.path, viewport: { width: 1280, height: 800 }, userAgent: 'kleodemobot' });
const page = await ctx.newPage();
await page.goto(start, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(4000);
let failed = null;
for (const [i, s] of flow.steps.entries()) {
  try {
    const loc = page.locator(s.locator).first();
    await loc.waitFor({ state: 'visible', timeout: 8000 });
    await loc.click({ timeout: 8000 });
    await page.waitForTimeout(1500);
    console.log(`  step ${i} OK   ${s.locator}`);
  } catch (e) {
    failed = i;
    console.log(`  step ${i} FAIL ${s.locator} :: ${String(e.message).split('\n')[0].slice(0,90)}`);
    break;
  }
}
console.log(`URL at end: ${page.url()}`);
if (failed !== null) {
  // re-author from an ACCESSIBILITY SNAPSHOT, not a stack trace
  // ariaSnapshot, not page.accessibility (removed). This is the thing the skill
  // says to re-author FROM: roles and names as the app actually exposes them.
  const snap = await page.locator('body').ariaSnapshot();
  // Surface what OPENED, not the first 90 lines of chrome. A menu/dialog/tab
  // that just appeared is what the next authoring turn needs; head-truncating a
  // long sidebar hides exactly that and wastes the repair turn.
  const lines = snap.split('\n');
  // A popup's CHILDREN are what the next turn needs, and they do not match a
  // role filter — they are ordinary buttons nested under it. So print the
  // SUBTREE of anything that looks like it just opened, by indentation.
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/dialog|menu\b|tablist|listbox/i.test(lines[i])) continue;
    const base = lines[i].search(/\S/);
    out.push(lines[i]);
    for (let j = i + 1; j < lines.length && out.length < 70; j++) {
      if (lines[j].trim() && lines[j].search(/\S/) <= base) break;
      out.push(lines[j]);
    }
  }
  console.log('--- aria snapshot at failure: what is open ---');
  console.log((out.length ? out : lines).slice(0, 70).join('\n'));
}
await ctx.close(); await b.close();
