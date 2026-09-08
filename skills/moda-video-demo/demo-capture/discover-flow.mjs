// Step 1: find the steps, in a browser nobody is filming.
//
// Throwaway by construction — the output is a flow file for `take.mjs` to
// replay, not a recording. See src/discovery.js.
import { chromium } from 'playwright';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolveStorageState } from './auth.mjs';

const require = createRequire(import.meta.url);
const { discover } = require('./src/discovery.js');

const goal = process.argv[2];
const startUrl = process.argv[3] || 'https://moda.app/';
const out = process.argv[4] || '/tmp/flow-discovered.json';
if (!goal) {
  console.error('usage: node discover-flow.mjs "<goal>" [startUrl] [outFile]');
  process.exit(2);
}
// Guidance from a previous run's critique. This is what closes the loop: the
// notes go into discovery's system prompt so the next attempt avoids what the
// last one got wrong, rather than rediscovering the same bad path.
const gi = process.argv.indexOf('--guidance');
const guidance = gi > 0 && process.argv[gi + 1] ? readFileSync(process.argv[gi + 1], 'utf8').trim() : null;
if (guidance) console.log(`guided by the last critique:\n${guidance}`);

const auth = resolveStorageState(startUrl);
console.log(`auth: ${auth.source}`);
console.log(`discovering: "${goal}"`);
const result = await discover({ goal, startUrl, storageState: auth.path, chromium, guidance });
// `sawTextField` rides along because the PAGE is gone by the time anything
// downstream could look, and the pre-record input check (ENG-6124) needs to tell
// "this product takes no input" from "this demo skipped the input". Dropping it
// here does not fail loudly — the check just goes quiet — so it has a test.
writeFileSync(out, JSON.stringify(
  { goal, steps: result.steps, sawTextField: result.sawTextField, typeableFields: result.typeableFields },
  null, 2));
console.log(`\nstopped: ${result.stopped} — ${result.steps.length} replayable step(s) -> ${out}`);
for (const s of result.steps) console.log(`  ${s.action.padEnd(5)} ${s.locator || ''}  (${s.why})`);
