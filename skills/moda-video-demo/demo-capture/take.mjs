// Record a take — script FIRST, then record to fit it.
//
// The order is the whole point (ENG-5919): the narration is written and voiced
// before a frame is captured, and the recorder holds each step long enough for
// its line. Recording first and squeezing the script into the gaps afterwards is
// what produced clipped, robotic sentences.
import { chromium } from 'playwright';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { capture } from './capture.mjs';
import { resolveStorageState } from './auth.mjs';

const require = createRequire(import.meta.url);
const { planPacing } = require('./src/pacing.js');
const { validateFlow, MIN_NET_CHANGE } = require('./src/validate.js');
const { describeHealth } = require('./src/page-health.js');
const { chooseStyle } = require('./src/style.js');
const { speak, TTS_VOICE, TTS_MODEL } = require('./src/narrate.js');

const flow = JSON.parse(readFileSync(process.env.DEMO_FLOW || '/tmp/flow5.json', 'utf8'));
const start = process.env.DEMO_START || 'https://moda.app/';
const id = `${process.env.DEMO_NAME || 'take'}-${new Date().toISOString().replace(/[:.]/g, '-')}`;
const outDir = `out/${id}`;
mkdirSync(outDir, { recursive: true });

const auth = resolveStorageState(start);
console.log(`auth: ${auth.source}`);

// VALIDATE BEFORE RECORDING. A selector that no longer resolves does not fail
// loudly during a capture — the step throws, the loop breaks, and the take comes
// out with fewer actions than the flow and no error anywhere. Both selector bugs
// found on 2026-09-01 presented exactly that way. Better to lose a minute here
// than to publish a truncated demo.
if (process.env.DEMO_SKIP_VALIDATE !== '1') {
  const v = await validateFlow({ flow, startUrl: start, storageState: auth.path, chromium });
  if (!v.ok) {
    console.error(`\nflow is not replayable (${v.stage}):`);
    if (v.errors) for (const e of v.errors) console.error(`  ${e}`);
    else console.error(`  step ${v.step}: ${v.locator ?? '(no locator)'} — ${v.reason}`);
    console.error('\nRe-run discovery, or fix the flow. DEMO_SKIP_VALIDATE=1 overrides.');
    process.exit(1);
  }
  // Validation also measured WHERE each step changes the page. The camera needs
  // it: a punch-in that frames the click while the result is elsewhere hides the
  // payoff. Attached to the flow so it reaches the timeline.
  let measured = 0;
  for (const [i, box] of Object.entries(v.resultBoxes ?? {})) {
    if (box) {
      flow.steps[i].resultBox = box;
      measured++;
    }
  }
  console.log(`validated: ${v.steps} step(s) replayable, ${measured} with a measured result region`);
  // Loud, because nothing else notices. The step resolved, executed and raised
  // nothing — it just did not DO anything, and the video shows a cursor acting
  // on a control to no effect.
  for (const n of v.noOps ?? []) {
    console.warn(`  ⚠ step ${n.step} (${n.action} ${n.locator ?? ''}) changed NOTHING on the page`);
  }
  for (const o of v.offscreen ?? []) {
    console.warn(`  ⚠ step ${o.step}: what it produced runs off the ${o.edge} of the viewport — the demo will not show it`);
  }
  if ((v.noOps ?? []).length) {
    console.warn('    a demo of an action with no visible effect is worse than one step shorter.');
  }
  if (v.netChange != null && v.netChange < MIN_NET_CHANGE) {
    console.warn(`  ⚠ the last frame is ${(v.netChange * 100).toFixed(1)}% different from the first — the demo ends where it began`);
    console.warn('    a viewer comparing the start to the end sees nothing happened. End on the changed state, not back at the default.');
  }
  // A step that lands where the video has already been. Not a rendering fault —
  // the flow going nowhere, which no amount of camera or pacing work can fix.
  for (const r of v.revisited ?? []) {
    const where = r.sameAs < 0 ? 'the state it opened on' : `the state after step ${r.sameAs}`;
    console.warn(`  ⚠ step ${r.step} returns the page to ${where} — the viewer has already seen it`);
  }
  if ((v.revisited ?? []).length) {
    console.warn('    a demo that revisits a state is exercising a control, not showing a product.');
  }
  for (const c of v.clobbered ?? []) {
    console.warn(`  ⚠ step ${c.step} DELETES ${c.chars} characters already on screen before typing`);
    console.warn('    the demo opens by destroying its own starting state — the end will look poorer than the start.');
  }
  // Not about any step — about the page. These sit in EVERY frame, so they are
  // the most damaging thing here and the cheapest to have avoided.
  const bad = describeHealth(v.health ?? { brokenImages: [], overlays: [], issueBadges: [] });
  for (const line of bad) console.warn(`  ⚠ ${line}`);
  if (bad.length) {
    console.warn('    this is in every frame of the video. Record against a production build, or fix it first.');
  }
}

// Voiced up front, so `stepMinDurations` is real measured audio rather than a
// guess at how long a sentence takes to say.
// The GENRE decides whether there is anything to pace to, and it has to be
// decided HERE rather than in `finish.mjs`. A marketing demo has no voiceover,
// so voicing one and then stretching every step to fit it leaves the take
// holding silence on a static screen — measured at ~5s on the QR tool demo,
// for lines finish then discarded.
//
// `chooseStyle` reads the flow's action types, which exist before the recording
// does, so both halves reach the same answer.
// The GOAL is the judge's most important input — it is being asked whether a
// viewer with the sound off would understand what they watched, and the goal is
// what says what they were meant to understand. Passing only the action types
// made it answer "goal unstated" and fall back to reasoning about the shape of
// the flow alone.
const genre = chooseStyle({
  goal: flow.goal,
  actions: flow.steps.map((s) => ({ type: s.action === 'press' ? 'key' : s.action, label: s.why })),
});
console.log(`style: ${genre.style} — ${genre.why}`);
// WRITE IT DOWN. `chooseStyle` is a model call, and finish.mjs used to ask the
// same question again over the same clip — two independent answers that can
// disagree. On one run they did, three ways: take said tutorial and voiced a
// script, finish said marketing and dropped it, and the loop's next finish said
// tutorial again. The mux then produced a cut 0.8s short of what the report
// claimed and the duration guard stopped the run.
//
// The recording is PACED for a genre. Choosing a different one afterwards
// invalidates the pacing the take was built around, so the take's answer is the
// one that counts and this is where it is recorded.
writeFileSync(`${outDir}/genre.json`, JSON.stringify(genre, null, 2));

const pacing =
  process.env.DEMO_NO_VOICE === '1' || genre.style === 'marketing'
    ? { stepMinDurations: null }
    : await planPacing({ goal: flow.goal, steps: flow.steps, outDir, speak, voice: TTS_VOICE, model: TTS_MODEL });

const cap = await capture({
  id, flow, start, outDir, storageState: auth.path, stepMinDurations: pacing.stepMinDurations,
});
console.log(JSON.stringify({ id, outDir, ...cap }, null, 2).slice(0, 1200));
