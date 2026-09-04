// The JS half had no tests at all while the compiler it feeds has 263.
//
// Every check in `src/` was verified by running a script by hand once and
// reading the output, which is exactly how three of them shipped green while
// measuring nothing: a key that was never returned, a metric the camera pinned
// at zero, a shot type the scanner could not see. These pin the behaviours that
// were wrong, so they cannot go quiet again.
//
//   node --test test/
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync, spawnSync } = require('node:child_process');
const { mkdtempSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');

const { proposeDrops, ensureTrailingHold } = require('../src/curate.js');
const { checkShots } = require('../src/shot-check.js');
const { projectActions } = require('../src/ledger.js');
const { checkCaptions } = require('../src/caption-check.js');
const { isInert } = require('../src/validate.js');
const { checkFlowShape } = require('../src/flow-shape.js');
const { checkLegibility } = require('../src/legibility-check.js');

const HERE = path.join(__dirname, '..');
const tmp = () => mkdtempSync(path.join(tmpdir(), 'demo-test-'));

test('curate proposes the steps that nurse a product through an error', () => {
  const flow = { steps: [
    { action: 'click', locator: 'role=button[name="Social"i]', why: 'pick a format' },
    { action: 'click', locator: 'role=button[name="Maybe later"i]', why: 'dismiss a dialog' },
    { action: 'fill', locator: '#prompt', text: 'hi', why: 'type' },
    { action: 'click', locator: 'role=button[name="Try again"i]', why: 'retry the render' },
  ] };
  assert.deepStrictEqual(proposeDrops(flow).map((d) => d.index), [1, 3]);
});

test('curate leaves an ordinary flow alone', () => {
  const flow = { steps: [
    { action: 'click', locator: 'role=button[name="Publish"i]', why: 'publish' },
    { action: 'click', locator: 'role=button[name="Midnight"i]', why: 'theme' },
  ] };
  assert.deepStrictEqual(proposeDrops(flow), []);
});

test('curate appends a hold, and only when the flow lacks one', () => {
  const bare = { steps: [{ action: 'click', locator: '#a', why: 'x' }] };
  assert.strictEqual(ensureTrailingHold(bare).added, true);
  const held = { steps: [{ action: 'click', locator: '#a', why: 'x' }, { action: 'wait', quietMs: 1, why: 'y' }] };
  assert.strictEqual(ensureTrailingHold(held).added, false);
});

test('the completeness header reports what the RECORDER issued, not its own output', () => {
  // The regression: this was `actions.length`, derived from the array it
  // certifies, so `actions_issued == actions_recorded` could never be false.
  const dir = tmp();
  const clip = {
    name: 'fx', goal: 'g', durationSec: 12, viewport: { width: 1280, height: 800 },
    marks: { setup_done: 0.5, feature_done: 11 },
    _issued: 3,                        // three steps attempted
    actions: [                         // ...one of them threw and never landed
      { index: 0, type: 'click', label: 'one', startSec: 1, endSec: 3, clickX: 600, clickY: 300,
        box: { x: 0.4, y: 0.35, width: 0.1, height: 0.05 }, moveStartSec: 1, arrivalSec: 1.6, clickSec: 1.9,
        selectorType: 'role', selector: 'role=button[name="one"]', identityResolved: true },
      { index: 1, type: 'click', label: 'two', startSec: 3, endSec: 6, clickX: 700, clickY: 400,
        box: { x: 0.5, y: 0.45, width: 0.1, height: 0.05 }, moveStartSec: 3, arrivalSec: 3.6, clickSec: 3.9,
        selectorType: 'role', selector: 'role=button[name="two"]', identityResolved: true },
    ],
  };
  const f = path.join(dir, 'clip.json');
  writeFileSync(f, JSON.stringify(clip));
  const out = JSON.parse(execFileSync('node', ['to-moda-timeline.js', f], { cwd: HERE, encoding: 'utf8' }));
  assert.strictEqual(out.actions.length, 2, 'fixture must record fewer than it issued');
  assert.strictEqual(out.integrity.actionsIssued, 3, 'reported its own output instead of the issued count');
});

test('a chained shot counts as a shot, and its framing is checked', () => {
  // The camera stays zoomed and PANS between actions. Counting only scale
  // rises saw the first shot of a chain and none of the rest — and reported
  // "all on target" for a field held 4.8% from the frame edge.
  const dir = tmp();
  const id = 'x';
  writeFileSync(path.join(dir, `${id}.motion.js`), [
    'motion.page("p", (t) => {',
    '  t.keyframes("n1", "scale", [',
    '    {"tMs":3160,"value":1.0},{"tMs":4220,"value":1.3},',
    '    {"tMs":7000,"value":1.3},{"tMs":16330,"value":1.3},{"tMs":17000,"value":1.0}]);',
    // translate = (viewportCentre - focus) * scale
    '  t.motionPath("n1", [',
    '    {"tMs":3160,"value":{"x":0,"y":0}},',
    `    {"tMs":4220,"value":{"x":${(640 - 738) * 1.3},"y":${(400 - 492) * 1.3}}},`,
    `    {"tMs":7000,"value":{"x":${(640 - 782) * 1.3},"y":${(400 - 482) * 1.3}}},`,
    `    {"tMs":16330,"value":{"x":${(640 - 782) * 1.3},"y":${(400 - 482) * 1.3}}},`,
    '    {"tMs":17000,"value":{"x":0,"y":0}}]);',
    '});',
  ].join('\n'));

  const doc = {
    durationSec: 20, viewport: { width: 1280, height: 800 },
    actions: [
      { index: 1, type: 'click', startSec: 3, endSec: 7, clickSec: 4.221, clickX: 491, clickY: 385 },
      { index: 2, type: 'fill', startSec: 7, endSec: 16, clickSec: 7.0, clickX: 778, clickY: 204,
        cursorHiddenWhileTyping: true },
    ],
  };
  const r = checkShots({ doc, outDir: dir, id });
  assert.strictEqual(r.zoomFraming.peaks, 2, 'missed the panned shot');
  assert.deepStrictEqual(r.zoomFraming.offenders.map((o) => o.action), [2],
    'the field held near the frame edge was not flagged');
});

test('a take that typed nothing does not report the cursor as clear', () => {
  // "clear of the text while typing" on a take with no typing is the same
  // vacuous green as a test whose subject never ran.
  const r = checkShots({ doc: { durationSec: 10, viewport: { width: 1280, height: 800 },
    actions: [{ index: 0, type: 'click', startSec: 1, endSec: 3 }] }, outDir: tmp(), id: 'none' });
  assert.strictEqual(r.cursorOcclusion.measured, false);
});

test('a step that threw is issued but NOT recorded', () => {
  // The gap the compiler's completeness gate exists to name. It could never
  // fire: `to-moda-timeline` derived the issued count from its own output, and
  // fixing that to read the recorder's `_issued` changed nothing, because a
  // failed step was still pushed to the ledger. Both numbers stayed equal by
  // construction, and the test written for that fix passed only because its
  // fixture — 3 issued, 2 recorded — was a state the recorder cannot produce.
  const ledger = [
    { index: 0, type: 'click', label: 'ok', tStart: 1000, tEnd: 2000 },
    { index: 1, type: 'click', label: 'threw', tStart: 2000, tEnd: 2100, failed: 'locator.click: Timeout' },
    { index: 2, type: 'wait', label: 'ok', tStart: 2100, tEnd: 4000 },
  ];
  const actions = projectActions(ledger);
  assert.strictEqual(ledger.length, 3, 'the recorder attempted three');
  assert.strictEqual(actions.length, 2, 'a failed step must not be recorded as an action');
  assert.deepStrictEqual(actions.map((a) => a.index), [0, 2]);
});

test('the projection carries the fields the checks read', () => {
  // A whitelist that silently drops a field is how cursorHiddenWhileTyping
  // reached the timeline and then vanished before anything could read it.
  const [a] = projectActions([{
    index: 0, type: 'fill', label: 'type', tStart: 1000, tEnd: 3000,
    clickX: 700, clickY: 200, box: { x: 1, y: 2, width: 3, height: 4 },
    moveStartT: 1000, arrivalT: 1500, clickT: 1800,
    resultBox: { x: 0, y: 0, width: 0.5, height: 0.5 },
    cursorHiddenWhileTyping: true, identityResolved: true,
  }]);
  for (const k of ['clickX', 'clickY', 'clickSec', 'arrivalSec', 'moveStartSec', 'resultBox', 'cursorHiddenWhileTyping']) {
    assert.ok(k in a, `projection dropped ${k}, which a check reads`);
  }
});

test('a caption too dense for its window is flagged; a comfortable one is not', () => {
  // The tutorial branch puts text on screen and no countable check read it —
  // a caption could be twice too long for its window and every signal in the
  // pipeline would report a clean take.
  const fast = checkCaptions({ actions: [{ index: 0, type: 'click',
    label: 'Publish the branded page to a shareable URL', startSec: 1, endSec: 2.2 }] });
  assert.strictEqual(fast.bad, true, '43 chars in 1.2s should not pass');

  const flash = checkCaptions({ actions: [{ index: 0, type: 'click',
    label: 'Publish', startSec: 1, endSec: 1.4 }] });
  assert.strictEqual(flash.bad, true, '0.4s on screen should not pass');

  // The real one captions.js warns about: the agent's reasoning, burned in.
  const sentence = checkCaptions({ actions: [{ index: 0, type: 'click',
    label: 'let me scroll up to find the Go to App link and click it', startSec: 1, endSec: 20 }] });
  assert.strictEqual(sentence.bad, true, 'a sentence is not a caption');

  const fine = checkCaptions({ actions: [{ index: 0, type: 'click',
    label: 'Try "Midnight"', startSec: 1, endSec: 7 }] });
  assert.strictEqual(fine.bad, false, 'a short caption with room to read must pass');
});

test('a cut with no captions is not reported as having readable ones', () => {
  const r = checkCaptions({ actions: [{ index: 0, type: 'click', label: '', startSec: 1, endSec: 3 }] });
  assert.strictEqual(r.measured, false);
});

test('the camera must be showing what the caption is talking about', () => {
  // A CROSS-SIGNAL invariant: the caption check says the text is readable, the
  // framing check says the punch-in is on target, and the pair can still be
  // wrong because shots CHAIN — the camera can still be framed on the previous
  // action's subject while this caption is up.
  //
  // NO REAL INSTANCE has been observed. A model reported one and the frame
  // disproved it. This pins the invariant and proves the check can fire, which
  // is the least a guard with no sighting owes.
  const dir = mkdtempSync(path.join(tmpdir(), 'demo-test-'));
  const id = 'x';
  const S = 1.6;
  // Camera parked on the TOP-LEFT for the whole clip.
  writeFileSync(path.join(dir, `${id}.motion.js`), [
    'motion.page("p", (t) => {',
    `  t.keyframes("n1", "scale", [{"tMs":0,"value":${S}},{"tMs":30000,"value":${S}}]);`,
    `  t.motionPath("n1", [{"tMs":0,"value":{"x":${(640 - 260) * S},"y":${(400 - 180) * S}}},`,
    `    {"tMs":30000,"value":{"x":${(640 - 260) * S},"y":${(400 - 180) * S}}}]);`,
    '});',
  ].join('\n'));

  const base = { durationSec: 30, viewport: { width: 1280, height: 800 } };
  const offscreen = checkShots({ outDir: dir, id, doc: { ...base, actions: [{
    index: 0, type: 'click', label: 'Publish it', startSec: 5, endSec: 10, clickSec: 5.2,
    clickX: 260, clickY: 180, resultBox: { x: 0.72, y: 0.80, width: 0.26, height: 0.18 } }] } });
  assert.strictEqual(offscreen.captionSubject.measured, true);
  assert.deepStrictEqual(offscreen.captionSubject.offenders.map((o) => o.action), [0],
    'a caption whose result sits outside the framed region must be flagged');

  const inFrame = checkShots({ outDir: dir, id, doc: { ...base, actions: [{
    index: 0, type: 'click', label: 'Publish it', startSec: 5, endSec: 10, clickSec: 5.2,
    clickX: 260, clickY: 180, resultBox: { x: 0.16, y: 0.16, width: 0.20, height: 0.14 } }] } });
  assert.strictEqual(inFrame.captionSubject.bad, false,
    'a result the camera IS showing must not be flagged');

  // AND WITH NO CAPTION AT ALL. This required a label, and the marketing genre
  // clears every one — so on marketing cuts the check never ran, which is the
  // genre where the screen has to speak for itself. A real take spent two
  // thirds of its runtime punched into the editor with the payoff cropped to a
  // sliver, and this reported "not measured".
  const uncaptioned = checkShots({ outDir: dir, id, doc: { ...base, actions: [{
    index: 0, type: 'click', label: '', startSec: 5, endSec: 10, clickSec: 5.2,
    clickX: 260, clickY: 180, resultBox: { x: 0.72, y: 0.80, width: 0.26, height: 0.18 } }] } });
  assert.strictEqual(uncaptioned.captionSubject.measured, true,
    'a marketing cut has no captions and still has results to show');
  assert.strictEqual(uncaptioned.captionSubject.bad, true);
});

test('a huge bounding box around almost no change is inert', () => {
  // A bounding box is the extent, not the amount. Measured on a real no-op —
  // clicking an already-active theme — the box covered 24.9% of the viewport
  // while 2.26% of pixels had moved, and the step was recorded as a result.
  assert.strictEqual(isInert(null), true, 'no region at all is inert');
  assert.strictEqual(isInert({ x: 0.06, y: 0.22, width: 0.41, height: 0.60, changed: 0.0002 }), true,
    'a quarter-page box around 0.02% moved pixels is not a result');
  assert.strictEqual(isInert({ x: 0.1, y: 0.1, width: 0.8, height: 0.6, changed: 0.31 }), false,
    'a real restyle must not be called inert');
  // A genuinely small change still passes on extent, as it did before.
  assert.strictEqual(isInert({ x: 0.4, y: 0.4, width: 0.05, height: 0.04, changed: 0.02 }), false,
    'a checkbox-sized change is a result');
  // An older take carries no `changed` field; fall back to the area test.
  assert.strictEqual(isInert({ x: 0.4, y: 0.4, width: 0.001, height: 0.001 }), true);
  assert.strictEqual(isInert({ x: 0.1, y: 0.1, width: 0.5, height: 0.5 }), false);
});

test('a flow that is mostly one row of controls is a tour, not a demo', () => {
  // A person preferred the demo that scored WORSE. The higher-scoring take
  // clicked six controls in the same row — every theme in a picker, then back
  // to the first — and every countable check passed it, because they all
  // measure execution and none asks what the flow is made of.
  const mk = (pts) => pts.map(([x, y], i) => ({ index: i, clickX: x, clickY: y, label: `c${i}` }));

  // The real take: six of seven clicks at y=151.
  const tour = checkFlowShape(mk([[748,151],[825,151],[895,151],[964,151],[1202,151],[748,151],[300,691]]));
  assert.strictEqual(tour.bad, true);
  assert.strictEqual(tour.band.count, 6);

  assert.strictEqual(checkFlowShape(mk([[100,120],[600,400],[1100,700],[300,250]])).bad, false,
    'clicks spread across the page are not a tour');
  assert.strictEqual(checkFlowShape(mk([[100,151],[200,151],[600,400],[1100,700],[300,250]])).bad, false,
    'a picker used twice out of five clicks is being USED, not toured');
  assert.strictEqual(checkFlowShape(mk([[200,100],[200,160],[200,220],[900,400]])).bad, true,
    'a vertical menu column is the same shape sideways');

  // Too few clicks to have a shape: say so rather than guess.
  assert.strictEqual(checkFlowShape(mk([[100,151],[200,151]])).measured, false);
});

test('a payoff you can read less well than what it replaced is flagged', (t) => {
  // `ink-check` asks whether content SURVIVED — whether pixels still differ
  // from the background. That is presence, not legibility, and it passed a demo
  // whose payoff was grey-on-navy body text: "content: intact — 0 of 26 inked
  // regions emptied". The text was there; you could not read it.
  //
  // Needs ffmpeg to build its fixtures, so it skips where ffmpeg is absent
  // rather than failing for the wrong reason.
  const dir = mkdtempSync(path.join(tmpdir(), 'demo-test-'));
  const fades = path.join(dir, 'fades.mp4');
  const crisp = path.join(dir, 'crisp.mp4');
  const run = (args) => spawnSync('ffmpeg', args, { encoding: 'utf8' });
  if (run(['-version']).error) return t.skip('ffmpeg not available');
  run(['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=640x400:rate=30:duration=2',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', crisp]);
  run(['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=640x400:rate=30:duration=2',
    '-f', 'lavfi', '-i', 'color=c=0x202028:size=640x400:rate=30:duration=2',
    '-filter_complex', '[0:v][1:v]concat=n=2:v=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', fades]);

  const doc = (a, b) => ({ actions: [{ index: 0, type: 'click',
    resultBox: { x: 0, y: 0, width: 1, height: 1 }, startSec: a, endSec: b }] });

  const washed = checkLegibility({ rawVideo: fades, doc: doc(0.5, 3.5) });
  assert.strictEqual(washed.bad, true, 'detail giving way to a flat panel must be flagged');
  assert.ok(washed.offenders[0].after < washed.offenders[0].before);

  const kept = checkLegibility({ rawVideo: crisp, doc: doc(0.3, 1.8) });
  assert.strictEqual(kept.bad, false, 'a payoff as readable as before must not be flagged');
});

test('the binary resolver never claims a tool it cannot point at', () => {
  // `doctor` reads this, and a resolver that says "present" without evidence
  // would put the pipeline's worst failure mode — a check that cannot run
  // reading as a pass — into the one command whose job is to say what is
  // missing before anything is recorded.
  const bin = require('../src/bin.js');
  for (const [name, r] of Object.entries(bin.report)) {
    assert.ok(['bundled', 'PATH', 'missing'].includes(r.from), `${name}: unexpected source ${r.from}`);
    if (r.from === 'missing') {
      assert.strictEqual(r.path, null, `${name}: reported missing but still offered a path`);
    } else {
      assert.ok(r.path, `${name}: reported ${r.from} with no path`);
    }
  }
  // And the exported names always fall back to something runnable-by-name, so
  // a caller never gets `undefined` spliced into an argv.
  assert.strictEqual(typeof bin.ffmpeg, 'string');
  assert.strictEqual(typeof bin.ffprobe, 'string');
});
