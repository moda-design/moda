#!/usr/bin/env node
// The whole thing, once: goal and URL in, published demo out.
//
// Every stage already existed and none of them were joined up. Producing the two
// samples that got shipped took five commands per demo AND hand-editing the
// discovered flow both times — deleting the steps where the agent nursed the
// product through an error, and adding a hold on the payoff. A pipeline whose
// good output depends on someone knowing to do that is not a pipeline.
//
// The order matters, and it is cheapest-first on purpose:
//
//   discover   drive the app, find the steps            model calls, minutes
//   curate     drop what a demo must never show         free
//   validate   walk the flow, measure every step        one headless browser
//   take       record it                                minutes, drives the app
//   finish     pace, score, caption                     seconds
//   iterate    critique and fix what is cheap to fix    seconds per round
//   publish    upload, compile the camera, export       minutes
//
// Curation and validation both run BEFORE the recording, because that is the
// expensive irreversible step, and every defect they catch is one that would
// otherwise have to be found by watching the output.
//
// THE OUTER LOOP is here rather than in `iterate.mjs` on purpose. `iterate`
// fixes a finished take in place — re-pacing and re-framing need no new
// footage — but a finding that says the STEPS are wrong cannot be fixed that
// way, and re-recording produces a new output directory, so `iterate` would
// have to change its own identity halfway through. So `iterate` owns the cheap
// in-place lane and this owns the expensive one: when the only findings left
// are about the flow, the critique becomes guidance, discovery runs again with
// it, and the whole thing is re-recorded. The best attempt is what gets
// published, not the last.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolveStorageState } from './auth.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const { validateFlow } = require('./src/validate.js');
const { proposeDrops, without, ensureTrailingHold } = require('./src/curate.js');
const { checkFlowShape } = require('./src/flow-shape.js');

const args = process.argv.slice(2);
//: Flags that consume the next argument, so it is not mistaken for a positional.
const VALUED = new Set(['--name', '--flow', '--publish', '--rounds', '--attempts', '--target']);
const flag = (f, d) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : d; };
const has = (f) => args.includes(f);
const positional = [];
for (let i = 0; i < args.length; i++) {
  if (args[i].startsWith('--')) { if (VALUED.has(args[i])) i++; continue; }
  positional.push(args[i]);
}
const [goal, startUrl] = positional;

if (!goal || !startUrl) {
  console.error('usage: node run.mjs "<goal>" <url> [--name N] [--flow F] [--no-auth]\n              [--publish "Title"] [--rounds N] [--attempts N] [--target S]');
  process.exit(2);
}

const name = flag('--name', 'demo');
const noAuth = has('--no-auth');
const rounds = flag('--rounds', '3');
//: How many times the whole thing may be RE-RECORDED with the critique's
//: findings fed back into discovery. Default 1 — a second attempt drives the
//: user's product again and costs minutes, so it is opt-in.
const attempts = Number(flag('--attempts', '1'));
const target = Number(flag('--target', '8'));
const publishAs = flag('--publish', null);
const env = { ...process.env, ...(noAuth ? { DEMO_NO_AUTH: '1' } : {}) };
//: Stages STREAM to the terminal. Piping their stdout swallowed it — a run
//: printed "[5] finishing" and "[6] critiquing" with nothing under either, so
//: the scores, the pacing and every warning the stages exist to emit were
//: invisible in the one command anybody is meant to use.
const run = (c, a, e = {}) => execFileSync(c, a, { encoding: 'utf8', maxBuffer: 64 << 20, env: { ...env, ...e }, stdio: ['ignore', 'inherit', 'inherit'] });
//: ...and `capture` for the few calls whose OUTPUT is the point.
const capture = (c, a, e = {}) => execFileSync(c, a, { encoding: 'utf8', maxBuffer: 64 << 20, env: { ...env, ...e }, stdio: ['ignore', 'pipe', 'inherit'] });
// `resolveStorageState` decides this everywhere else — take.mjs and capture.mjs
// both call it — and it does real work: not every target is Moda, and it is
// what stops a local app with no sign-in being asked for a Clerk session.
// Hardcoding the filename here made this the one call site that could not
// benefit from any of that.
const storageState = noAuth ? undefined : resolveStorageState(startUrl).path;

const work = mkdtempSync(path.join(tmpdir(), 'demo-run-'));

/**
 * One whole attempt: discover, curate, validate, record, finish, iterate.
 *
 * `guidancePath` is the previous attempt's flow findings. Discovery already
 * takes guidance and appends it to its system prompt — that path existed and
 * nothing had ever called it, because the only thing that wrote guidance was a
 * printed suggestion at the end of a critique.
 *
 * Returns `{ outDir, id, score, flowFindings }`, or null if the flow cannot be
 * made to walk at all.
 */
async function attemptOnce(n, guidancePath) {
  const tag = attempts > 1 ? ` (attempt ${n}/${attempts})` : '';

  // ── 1. discover ─────────────────────────────────────────────────────────
  let flowPath = n === 1 ? flag('--flow', null) : null;
  if (!flowPath) {
    flowPath = path.join(work, `flow-${n}.json`);
    console.log(`\n[1] discovering the flow${tag}`);
    const argv = ['discover-flow.mjs', goal, startUrl, flowPath];
    if (guidancePath) argv.push('--guidance', guidancePath);
    run('node', argv);
  } else {
    console.log(`\n[1] using the flow at ${flowPath}`);
  }
  let flow = JSON.parse(readFileSync(flowPath, 'utf8'));

  // ── 2. curate ───────────────────────────────────────────────────────────
  console.log('\n[2] curating');
  const proposed = proposeDrops(flow);
  for (const d of proposed) console.log(`    would drop step ${d.index}: ${d.why}`);
  const held = ensureTrailingHold(flow);
  if (held.added) console.log('    appending a hold so the payoff is on screen for more than a frame');
  flow = held.flow;
  // Indices shift once a step is appended, but only at the END, so the proposed
  // indices still address the same steps.
  let dropped = proposed.map((d) => d.index);
  let curated = dropped.length ? without(flow, dropped) : flow;

  // ── 3. validate, restoring any drop that turns out to be load-bearing ───
  console.log('\n[3] validating');
  const walk = (f) => validateFlow({ flow: f, startUrl, storageState, chromium });
  let report = await walk(curated);

  // A dismissal is junk when the dialog did not appear and load-bearing when it
  // did. Rather than guess, the flow is walked without it and the step is put
  // back if the walk breaks — the only way to tell from outside the app.
  for (let attempt = 0; !report.ok && dropped.length && attempt < 4; attempt++) {
    const restore = dropped.pop();
    console.log(`    the walk failed at step ${report.step ?? '?'} (${report.reason ?? report.errors?.[0] ?? 'unknown'})`);
    console.log(`    putting step ${restore} back — its removal was load-bearing`);
    curated = without(flow, dropped);
    report = await walk(curated);
  }
  if (!report.ok) {
    console.error(`\n  the flow does not survive a walk: ${report.reason ?? JSON.stringify(report.errors)}`);
    return null;
  }

  // Steps that provably changed nothing are dropped outright — no dialog can be
  // hiding behind a step that moved zero pixels — but the walk still gets
  // redone, because "changed nothing visible" is not "did nothing".
  const acts = (f) => f.steps.filter((x) => x.action === 'click' || x.action === 'fill').length;
  let inert = (report.noOps ?? []).map((x) => x.step);
  // NEVER drop the demo. Dropping every inert step is right until it empties
  // the flow: on the markdown publisher both discovered steps measured as
  // no-ops, both were dropped, and the run recorded the appended hold on its
  // own — a 3.9s video of a static page that scored 2/10. An empty flow is a
  // discovery failure to feed back, not a tidy-up to perform.
  if (inert.length && acts(without(curated, inert)) === 0) {
    console.log(`    NOT dropping step(s) ${inert.join(', ')} — nothing would be left to record`);
    inert = [];
  }
  if (inert.length) {
    console.log(`    dropping step(s) ${inert.join(', ')}: measured, they change nothing on the page`);
    const trimmed = without(curated, inert);
    const recheck = await walk(trimmed);
    if (recheck.ok) { curated = trimmed; report = recheck; }
    else console.log('    ...restored: without them the flow does not walk');
  }
  // IS THIS A DEMO OR A TOUR OF ONE WIDGET? Judged before the recording, from
  // where the controls sit — the recorder measures the same thing, but only
  // after it has driven the app, by which point the take is already paid for.
  const shape = checkFlowShape(report.clickPoints ?? []);
  if (shape.measured && shape.bad) {
    console.log(`    ⚠ ${shape.band.count} of ${shape.clicks} clicks land on one ${shape.band.axis === 'y' ? 'row' : 'column'} of controls (steps ${shape.band.steps.join(', ')})`);
    console.log('      that is a tour of a widget, not a demo of a product.');
  }
  for (const r of report.revisited ?? []) {
    const where = r.sameAs < 0 ? 'the state it opened on' : `the state after step ${r.sameAs}`;
    console.log(`    ⚠ step ${r.step} returns the page to ${where} — the viewer has already seen it`);
  }
  for (const c of report.clobbered ?? []) console.log(`    ⚠ step ${c.step} deletes ${c.chars} characters already on screen`);
  for (const line of (report.health?.brokenImages ?? []).map((b) => `broken image "${b.alt}"`)
    .concat((report.health?.overlays ?? []).map((o) => `dev overlay ${o}`))) {
    console.log(`    ⚠ ${line} — in every frame of the video`);
  }
  console.log(`    ${curated.steps.length} step(s) will be recorded`);

  // HOW MANY THINGS DOES THIS DEMO ACTUALLY SHOW? Counted after the drops,
  // because that is when a flow gets thin: on one run the no-op check correctly
  // removed the opening step and left two, whose only remaining action put its
  // result below the fold — a demo with nothing to watch, and nothing said so.
  //
  // A warning rather than a refusal. One dramatic change can carry a demo, and
  // refusing that would be substituting a rule for a judgement. It becomes a
  // flow finding, so a re-discover is what acts on it.
  const outcomes = curated.steps.filter((_, i) => {
    const r = report.resultBoxes?.[i];
    return r && !(report.noOps ?? []).some((n) => n.step === i);
  }).length;
  const offscreenCount = (report.offscreen ?? []).length;
  if (outcomes + offscreenCount < 2) {
    console.log(`    ⚠ only ${outcomes} step(s) produce something the viewer can see` +
      (offscreenCount ? ` (${offscreenCount} more change off screen)` : '') + ' — this is a thin demo');
  }

  if (acts(curated) === 0) {
    console.log('\n  this flow performs no action a viewer could see — refusing to record it.');
    return { outDir: null, id: null, score: 0, flowFindings: [{ type: 'empty_flow', description:
      'every discovered step changed nothing on the page. Find a path where each step visibly changes the page.' }] };
  }

  // DON'T RECORD A DEMO THE CHECKS HAVE ALREADY CONDEMNED.
  //
  // Everything above already knew: the no-op was dropped, the remaining step
  // returned to the opening state, nothing produced a visible outcome. Then the
  // run recorded it anyway, published it, and scored 3/10 — because the
  // re-discover lane only ever fired AFTER a take and a critique.
  //
  // These findings are cheaper AND better than the post-hoc ones: they come
  // from a measured walk rather than a model reading stills, and acting on them
  // costs no recording at all. So they become guidance here, and the outer loop
  // re-discovers without paying for a take first.
  const preRecord = [];
  if (outcomes + offscreenCount < 1) {
    preRecord.push({ type: 'nothing_visible', description:
      'no step produced a change the viewer could see. Find a path whose steps visibly change the page.' });
  }
  if ((report.revisited ?? []).length >= acts(curated)) {
    preRecord.push({ type: 'goes_nowhere', description:
      'every step returned the page to a state already shown. Find a path that ends somewhere new.' });
  }
  if (shape.measured && shape.bad) {
    preRecord.push({ type: 'one_control', description:
      `${shape.band.count} of ${shape.clicks} clicks land on a single row of controls. Demonstrate what the product DOES, not every option in one widget.` });
  }
  if (preRecord.length && n < attempts) {
    console.log(`\n  not recording this flow — ${preRecord.map((f) => f.type).join(', ')}.`);
    console.log('    re-discovering instead; a take would cost minutes to confirm what the walk already measured.');
    return { outDir: null, id: null, score: 0, flowFindings: preRecord };
  }
  if (preRecord.length) {
    console.log(`\n  ⚠ recording anyway (no attempts left): ${preRecord.map((f) => f.type).join(', ')}`);
  }

  const finalFlow = path.join(work, `curated-${n}.json`);
  writeFileSync(finalFlow, JSON.stringify({ ...curated, goal }, null, 2));

  // ── 4-6. record, finish, iterate ────────────────────────────────────────
  const runName = attempts > 1 ? `${name}-a${n}` : name;
  console.log(`\n[4] recording${tag}`);
  run('node', ['take.mjs'], { DEMO_NAME: runName, DEMO_START: startUrl, DEMO_FLOW: finalFlow });
  const outDir = capture('bash', ['-c', `ls -dt out/${runName}-*/ | head -1`]).trim().replace(/\/$/, '');
  const id = path.basename(outDir);

  console.log('\n[5] finishing');
  run('node', ['finish.mjs', outDir, id]);

  console.log('\n[6] critiquing and fixing what is cheap to fix');
  run('node', ['iterate.mjs', outDir, id, '--rounds', rounds]);

  let score = 0;
  let flowFindings = [];
  try {
    const c = JSON.parse(readFileSync(`${outDir}/critique.json`, 'utf8'));
    // The KEPT cut's score when iterate recorded one. `critique.json` is the
    // last critique, which after a revert scored a video that was discarded.
    let kept = null;
    try { kept = JSON.parse(readFileSync(`${outDir}/iterate.json`, 'utf8')); } catch { /* not iterated */ }
    score = kept?.score ?? c.score ?? 0;
    // The findings must come from the SAME cut as the score. Taking the score
    // from the kept cut and the findings from the last critique was half a fix:
    // after a revert those findings describe the video that was discarded, and
    // they are what drives a re-discover and a re-record.
    const issues = kept?.issues ?? c.issues ?? [];
    // Only findings the cheap lane could NOT own. `iterate` has already spent
    // every pacing and camera fix it has, so whatever is left and still not
    // low severity is either about the steps or about nothing actionable.
    flowFindings = issues.filter((i) =>
      i.severity !== 'low' && !['speed_up', 'shorten_narration', 'disable_zoom'].includes(i.fix));
  } catch { /* no critique — treat as unscored */ }
  return { outDir, id, score, flowFindings };
}

// ── the outer loop ────────────────────────────────────────────────────────
let best = null;
let guidancePath = null;
for (let n = 1; n <= attempts; n++) {
  const r = await attemptOnce(n, guidancePath);
  if (!r) { if (n === attempts) process.exit(1); continue; }
  if (r.outDir && (!best || r.score > best.score)) best = r;
  if (!r.outDir) {
    console.log(`\n  attempt ${n}: nothing recorded.`);
    if (n === attempts) break;
    guidancePath = path.join(work, `guidance-${n}.txt`);
    writeFileSync(guidancePath, r.flowFindings.map((i) => `- ${i.type}: ${i.description}`).join('\n'));
    console.log('  re-discovering with that as guidance.');
    continue;
  }
  console.log(`\n  attempt ${n}: ${r.score}/10${best === r ? ' (best so far)' : ` — best is still ${best.score}/10`}`);

  if (r.score >= target) { console.log(`  reached the target (${target}).`); break; }
  if (n === attempts) break;
  if (!r.flowFindings.length) {
    console.log('  nothing left that a different flow would fix — another recording would record the same problems.');
    break;
  }
  guidancePath = path.join(work, `guidance-${n}.txt`);
  writeFileSync(guidancePath, r.flowFindings.map((i) => `- ${i.type}: ${i.description}`).join('\n'));
  console.log(`  ${r.flowFindings.length} finding(s) are about the steps themselves — re-discovering with them as guidance.`);
}

// ── 7. publish the BEST attempt, not the last ─────────────────────────────
if (!best) {
  console.error('\n  no attempt produced a recording.');
  process.exit(1);
}
if (publishAs) {
  console.log(`\n[7] publishing ${best.id} (${best.score}/10)`);
  // The canvas name has to be unique: `canvas create` returns an EXISTING canvas
  // for a name already used, and the second publish then fails on a stale
  // revision against a canvas somebody else is editing.
  const stamp = new Date().toISOString().slice(11, 16).replace(':', '');
  run('node', ['publish-take.mjs', best.outDir, best.id, `${publishAs} ${stamp}`]);
} else {
  console.log(`\n  not published. To publish:  node publish-take.mjs ${best.outDir} ${best.id} "<Title>"`);
}
console.log(`\n  done — ${best.outDir} (${best.score}/10)`);
