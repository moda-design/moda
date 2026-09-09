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
const { existsSync, mkdtempSync, readFileSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');

const { proposeDrops, ensureTrailingHold } = require('../src/curate.js');
const { checkShots } = require('../src/shot-check.js');
const { projectActions } = require('../src/ledger.js');
const { checkCaptions } = require('../src/caption-check.js');
const { isInert } = require('../src/validate.js');
const { checkFlowShape } = require('../src/flow-shape.js');
const { emptyCameraReason } = require('../src/shot-check.js');
const { parseCameraReport, cameraPlanPath } = require('../src/camera-emit.js');
const { checkInputShown, inputEvidence, evidenceFor } = require('../src/input-check.js');
const { checkWalkFinished, GAVE_UP } = require('../src/walk-outcome.js');
const { checkLegibility } = require('../src/legibility-check.js');
const { recordIsMeasured } = require('../src/measured.js');

const { keptReport, nextStep, canSelect } = require('../src/kept-report.js');

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

// ── The camera the SERVER emits must grade identically to a local compile ────
//
// Without a studio checkout `<id>.motion.js` is never written, so zoomSync,
// zoomFraming, zoomRelease and noCamera all reported "not measured" — the
// critique loop was blind to framing for every external user (ENG-6059).
// `publish` now returns the program it applied and the client writes it here.
//
// The risk that buys is drift: if the returned program grades differently from
// the local one, external users get numbers nobody has ever seen. So this pins
// the two against each other on ONE real take.

//: Produced by `compile.py motion` on take e2e-palette-2026-09-04T18-30-16-193Z,
//: with the iterate loop's placeholder ids.
const LOCAL_PROGRAM = `motion.page("p_iter", (t) => {
  t.clearTarget("n_iter");
  t.keyframes("n_iter", "scale", [{"tMs":900,"value":1.0,"easing":"easeOutBack"},{"tMs":1953,"value":1.3,"easing":"linear"},{"tMs":2553,"value":1.3,"easing":"easeInOutCubic"},{"tMs":3223,"value":1.0,"easing":"easeInOut"}]);
  t.motionPath("n_iter", [{"tMs":900,"value":{"x":0.0,"y":0.0},"easing":"easeOutBack"},{"tMs":1953,"value":{"x":11.7,"y":120.0},"easing":"linear"},{"tMs":2553,"value":{"x":11.7,"y":120.0},"easing":"easeInOutCubic"},{"tMs":3223,"value":{"x":0.0,"y":0.0},"easing":"easeInOut"}]);
});`;

//: The SAME take as PUBLISHED, transcribed from the animation track of canvas
//: d4c3da5d-5ee9-4578-b3e7-e668488924e1 (`moda canvas read`), which carries the
//: real page and node ids the server assigned.
//:
//: Written out literally rather than derived from LOCAL_PROGRAM by replacing the
//: ids: a derived string can only ever disagree if the id regex breaks, so it
//: could not detect the drift this test exists to catch. These digits came off
//: the published canvas independently of the local compile.
const SERVER_PROGRAM = `motion.page("p_a", (t) => {
  t.clearTarget("n1");
  t.keyframes("n1", "scale", [{"tMs":900,"value":1.0,"easing":"easeOutBack"},{"tMs":1953,"value":1.3,"easing":"linear"},{"tMs":2553,"value":1.3,"easing":"easeInOutCubic"},{"tMs":3223,"value":1.0,"easing":"easeInOut"}]);
  t.motionPath("n1", [{"tMs":900,"value":{"x":0.0,"y":0.0},"easing":"easeOutBack"},{"tMs":1953,"value":{"x":11.7,"y":120.0},"easing":"linear"},{"tMs":2553,"value":{"x":11.7,"y":120.0},"easing":"easeInOutCubic"},{"tMs":3223,"value":{"x":0.0,"y":0.0},"easing":"easeInOut"}]);
});`;

test('readCamera reads a server-assigned-id program the same way as a local one', () => {
  const { readCamera } = require('../src/shot-check.js');
  const dir = mkdtempSync(`${tmpdir()}/cam-`);

  writeFileSync(`${dir}/local.motion.js`, LOCAL_PROGRAM);
  writeFileSync(`${dir}/server.motion.js`, SERVER_PROGRAM);

  const local = readCamera(`${dir}/local.motion.js`);
  const server = readCamera(`${dir}/server.motion.js`);

  // The precondition: both actually parsed. `readCamera` returns null on a miss,
  // and two nulls would compare equal and prove nothing.
  assert.ok(local, 'the local program did not parse');
  assert.ok(server, 'the server program did not parse — real node ids broke the reader');

  // WHAT THIS DOES AND DOES NOT PIN. Both constants are frozen literals, so this
  // cannot notice the server's emit drifting from the local compile in future —
  // they already take different inputs (publish passes accepted_zoom_actions,
  // compile.py constructs the emitter with none). It pins the one thing a frozen
  // pair can: that the reader treats a program carrying the server's real page
  // and node ids exactly as it treats the placeholder-id one, on values taken off
  // a real published canvas. Live divergence is knowingly unpinned here.
  assert.deepStrictEqual(server, local,
    'readCamera read the server-id program differently from the placeholder-id ' +
    'one, so the ids are leaking into what gets graded');

  // And it is a real program, not an empty pair that trivially matches.
  assert.strictEqual(local.scale.length, 4);
  assert.strictEqual(local.path.length, 4);
  assert.strictEqual(Math.max(...local.scale.map((k) => k.value)), 1.3);
});

// ── "Was this published?" must be told, not guessed from disk ───────────────
//
// It used to be `existsSync(<id>.markup.xml)`. Nothing has written that file
// since publishing became one server-side verb, so the predicate was permanently
// false and the FLAT-TAKE finding below — a published demo the compiler planned
// no punch-ins for, which is a finding and not a gap — had never once fired.

test('a published take with no camera is a finding, not an unmeasured check', () => {
  const { checkShots } = require('../src/shot-check.js');
  const dir = mkdtempSync(`${tmpdir()}/flat-`);
  const id = 'take';
  const doc = {
    durationSec: 6.0,
    viewport: { width: 1280, height: 800 },
    actions: [{ index: 0, type: 'click', label: 'Go', startSec: 0.5, endSec: 2.0, clickSec: 1.0, clickX: 100, clickY: 100 }],
  };
  writeFileSync(`${dir}/${id}.moda.json`, JSON.stringify(doc));
  const base = { doc, outDir: dir, id, motionPath: `${dir}/absent.motion.js` };

  // Published, and no camera came back: the video is one flat wide shot.
  const flat = checkShots({ ...base, cameraWasAttempted: true }).noCamera;
  assert.strictEqual(flat.measured, true, 'a published take with no punch-ins is measured, not unknown');
  assert.strictEqual(flat.bad, true, 'a flat camera is a finding');
  // No plan record was passed, so the checker must say it was not told rather
  // than assert a cause (ENG-6128).
  assert.match(flat.reason, /did not report why/);

  // Given the planner's report, it names the real cause — and distinguishes a
  // flat take from a held one, which have different remedies.
  const told = checkShots({ ...base, cameraWasAttempted: true, cameraPlan: { planned: 0, programs: 0 } }).noCamera;
  assert.match(told.reason, /planned NO punch-ins/);
  const heldTake = checkShots({ ...base, cameraWasAttempted: true, cameraPlan: { planned: 2, programs: 0, warnings: ['zoom_awaiting_confirmation: 2 punch-in(s) … actions [0, 1]'] } }).noCamera;
  assert.match(heldTake.reason, /wrote none — zoom_awaiting_confirmation/);

  // Not published yet: genuinely unknown, and must not read as a finding.
  const early = checkShots({ ...base, cameraWasAttempted: false }).noCamera;
  assert.strictEqual(early.measured, false);
  assert.strictEqual(early.bad, undefined, 'an unmeasured check must not read as bad either');
  assert.match(early.reason, /emitted at publish/);
});

// ── The camera file is the signal, so it must be authoritative ──────────────
//
// Neither planner writes anything when it plans nothing, so once suppressions
// have removed every punch-in the previous round's program would survive on
// disk — and the loop keys the flat-take finding on whether the file exists.

test('a replan that plans nothing leaves no camera behind', () => {
  const { emitCameraInto } = require('../src/camera-emit.js');
  const dir = mkdtempSync(`${tmpdir()}/emit-`);
  const out = `${dir}/take.motion.js`;

  // Round 1: the planner writes a camera.
  assert.strictEqual(emitCameraInto(out, (o) => writeFileSync(o, 'motion.page("p", () => {});')).ran, true);
  assert.ok(existsSync(out), 'fixture did not write a camera, so round 2 proves nothing');

  // Round 2: every punch-in suppressed, so the planner writes nothing at all.
  assert.strictEqual(emitCameraInto(out, () => {}).ran, true, 'the planner still RAN');
  assert.strictEqual(existsSync(out), false,
    'last round\'s camera survived — the loop would grade punch-ins this plan does not contain');
});

test('a planner that throws leaves no camera behind either, and says it did not run', () => {
  const { emitCameraInto } = require('../src/camera-emit.js');
  const dir = mkdtempSync(`${tmpdir()}/emit-`);
  const out = `${dir}/take.motion.js`;
  writeFileSync(out, 'motion.page("stale", () => {});');

  const threw = emitCameraInto(out, () => { throw new Error('no compiler'); });
  assert.strictEqual(threw.ran, false);
  assert.strictEqual(threw.report, null, 'a planner that never ran reported nothing to parse');
  assert.strictEqual(existsSync(out), false, 'a failed plan left a stale camera to be graded');
});

test('the camera verb accepts the located actions, or every punch-in comes back held', () => {
  const { cameraVerbArgs } = require('../src/camera-emit.js');
  const doc = { actions: [{ index: 0, clickX: 10 }, { index: 1 }, { index: 2, clickX: 40 }] };
  const args = cameraVerbArgs('/tmp/take.moda.json', '/tmp/take.motion.js', doc);

  assert.deepStrictEqual(args.slice(0, 2), ['demo', 'camera']);
  // Only the actions with a click — index 1 never landed one.
  assert.strictEqual(args[args.indexOf('--accept-zoom') + 1], '0,2');

  // And no flag at all when nothing is located, rather than an empty argument.
  assert.ok(!cameraVerbArgs('/tmp/a.json', '/tmp/b.js', { actions: [{ index: 0 }] }).includes('--accept-zoom'));
});

// ENG-6103: the publish gate used to wait on the bytes rather than on the
// measurement, so it cleared instantly and published ~35s early. These pin the
// distinction the old gate could not make — a record can be perfectly readable
// and still be unplaceable.
test('a record with bytes but no dimensions is NOT ready to place', () => {
  // Exactly the shape `file show` returns between upload and probe: the file is
  // there, named, sized in BYTES — and unmeasured. The old byte-proxy poll saw
  // a healthy object here and let publish run.
  assert.equal(recordIsMeasured({
    id: 'file_01HZX', name: 'take.mp4', mime_type: 'video/mp4', size_bytes: 197392,
    width: null, height: null, duration_ms: null,
  }), false);
});

test('a record is ready only once BOTH dimensions are real and non-zero', () => {
  assert.equal(recordIsMeasured({ width: 1280, height: 800 }), true);
  // Half-measured: the probe writes the pair or neither, so one alone means
  // something else wrote it and the other is not about to arrive.
  assert.equal(recordIsMeasured({ width: 1280, height: null }), false);
  assert.equal(recordIsMeasured({ width: null, height: 800 }), false);
  // Zero is not a size. It is also falsy, which is why the predicate must not
  // be re-inlined as a bare `width && height` truthiness test elsewhere.
  assert.equal(recordIsMeasured({ width: 0, height: 0 }), false);
  assert.equal(recordIsMeasured({ width: 1280, height: 0 }), false);
  // Strings are not measurements — a JSON lane that starts stringifying numbers
  // must not read as ready.
  assert.equal(recordIsMeasured({ width: '1280', height: '800' }), false);
});

test('a missing or malformed record is never ready', () => {
  assert.equal(recordIsMeasured(undefined), false);
  assert.equal(recordIsMeasured(null), false);
  assert.equal(recordIsMeasured({}), false);
});

// ENG-6104: the loop reverted a REGRESSION but never reconciled the artifact
// with `best` on the way out, so a round scoring EXACTLY the best left its own
// cut on disk while iterate.json named the earlier round. The revert is
// `score < best` and the re-best is `score > best`; a tie does neither.
//
// Driven as a real process against stub stages, because the defect is control
// flow across the whole loop — every pure-function slice of it was already
// correct on its own, which is exactly why this survived.
test('the cut left on disk is the round iterate.json says it kept', () => {
  const dir = tmp();
  const id = 'take';

  // The stage stubs. `finish.mjs` is the only thing that rewrites the artifact,
  // so recording the speed it was invoked at IS the on-disk state.
  writeFileSync(path.join(dir, 'finish.mjs'), [
    "import { appendFileSync, writeFileSync } from 'node:fs';",
    "const [outDir, id] = process.argv.slice(2);",
    "const speed = process.env.DEMO_COMPRESS_SPEED;",
    // The doc iterate.mjs reads back, regenerated exactly as the real stage does.
    "writeFileSync(`${outDir}/${id}.moda.json`, JSON.stringify({ actions: [",
    "  { index: 0, type: 'click', clickX: 100, clickY: 100, clickSec: 1 } ] }));",
    // Last writer wins, which is the point: this file is what the artifact is.
    "writeFileSync(`${outDir}/speed.txt`, String(speed));",
    // finish.mjs is METERED (it regenerates the music bed through a paid
    // generative render), so how often it runs is itself a thing to assert.
    "appendFileSync(`${outDir}/finishes.log`, speed + '\\n');",
  ].join('\n'));

  // Round 1 scores 5. Every later round scores 5 too — the tie. Each round
  // reports a pacing finding so the loop always has a cheap fix to apply and
  // keeps going (pacing, not camera, so no planner is needed).
  writeFileSync(path.join(dir, 'critique-take.mjs'), [
    "import { writeFileSync } from 'node:fs';",
    "const [outDir] = process.argv.slice(2);",
    "writeFileSync(`${outDir}/critique.json`, JSON.stringify({ score: 5, shots: [],",
    "  issues: [{ stage: 'pacing', severity: 'high', type: 'no_visible_change', fix: 'speed_up' }] }));",
  ].join('\n'));

  // Keep the camera planner off the network no matter how the host is set up —
  // BOTH lanes, since which one iterate.mjs picks depends on whether this
  // checkout has a backend virtualenv.
  writeFileSync(path.join(dir, 'moda'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  writeFileSync(path.join(dir, 'compile.py'), 'import sys\nsys.exit(1)\n');

  // Seed the artifact at the starting speed, as run.mjs would have left it.
  writeFileSync(path.join(dir, `${id}.moda.json`), JSON.stringify({ actions: [] }));
  writeFileSync(path.join(dir, 'speed.txt'), '6');

  const res = spawnSync('node', [path.join(HERE, 'iterate.mjs'), dir, id, '--rounds', '3', '--target', '9'], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, DEMO_COMPRESS_SPEED: '6' },
  });
  assert.strictEqual(res.status, 0, `iterate.mjs failed:\n${res.stdout}\n${res.stderr}`);

  const kept = JSON.parse(readFileSync(path.join(dir, 'iterate.json'), 'utf8'));
  const onDisk = readFileSync(path.join(dir, 'speed.txt'), 'utf8').trim();

  // The fixture has to have actually reached the tie, or this asserts nothing:
  // more than one round, and a later round that did NOT become the kept one.
  assert.ok(kept.rounds.length > 1, `fixture never got past round 1: ${JSON.stringify(kept.rounds)}`);
  assert.strictEqual(kept.keptRound, 1, 'a tie must not re-best, or the premise has changed');

  // Round 1 ran at 6; every applied pacing fix raises it. So a disk speed above
  // 6 is a cut the loop did not keep.
  assert.strictEqual(onDisk, '6',
    `iterate.json kept round ${kept.keptRound} (cut at 6x) but the artifact on disk is ${onDisk}x`);
});

// ENG-6104 round 1: the first cut of the fix restored UNCONDITIONALLY, which on
// the common path (last round is best) re-ran finish.mjs for nothing. That is
// not free — finish.mjs re-runs narration TTS and regenerates the music bed
// through `moda media generate-audio`, a metered generative render — so every
// demo run would have paid for an extra render AND shipped a cut whose audio no
// critique ever scored, which is the very mismatch this fix exists to remove.
test('a run whose best round is its last does not re-cut the artifact', () => {
  const dir = tmp();
  const id = 'take';

  writeFileSync(path.join(dir, 'finish.mjs'), [
    "import { appendFileSync, writeFileSync } from 'node:fs';",
    "const [outDir, id] = process.argv.slice(2);",
    "writeFileSync(`${outDir}/${id}.moda.json`, JSON.stringify({ actions: [] }));",
    "appendFileSync(`${outDir}/finishes.log`, (process.env.DEMO_COMPRESS_SPEED ?? '?') + '\\n');",
  ].join('\n'));

  // Scores the target on round 1, so the loop breaks immediately with best ===
  // the state already on disk. Nothing needs re-cutting.
  writeFileSync(path.join(dir, 'critique-take.mjs'), [
    "import { writeFileSync } from 'node:fs';",
    "const [outDir] = process.argv.slice(2);",
    "writeFileSync(`${outDir}/critique.json`, JSON.stringify({ score: 9, shots: [], issues: [] }));",
  ].join('\n'));

  // The planner is a SERVER round trip, so count it too: since the camera-only
  // path no longer re-cuts, a needless restore shows up here rather than in
  // finishes.log, and a test that watched only the re-cut would go blind to it.
  writeFileSync(path.join(dir, 'moda'), `#!/bin/sh\necho sh >> ${dir}/planner.log\nexit 0\n`, { mode: 0o755 });
  // BOTH planner lanes. iterate.mjs runs `<studio>/backend/.venv/bin/python
  // compile.py` when that interpreter exists and falls back to `moda demo
  // camera` when it does not — so stubbing only one makes the test depend on
  // whether this checkout happens to have a backend virtualenv. compile.py is
  // resolved against the CWD, which is this fixture dir.
  writeFileSync(path.join(dir, 'compile.py'),
    `import pathlib, sys\npathlib.Path(r'${dir}/planner.log').open('a').write('py\\n')\n`);

  writeFileSync(path.join(dir, `${id}.moda.json`), JSON.stringify({ actions: [] }));
  // Pre-seeded so the loop-top emit is skipped and any planner call is the
  // restore's doing.
  writeFileSync(path.join(dir, `${id}.motion.js`), '// already emitted\n');

  const res = spawnSync('node', [path.join(HERE, 'iterate.mjs'), dir, id, '--rounds', '3', '--target', '8'], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, DEMO_COMPRESS_SPEED: '6' },
  });
  assert.strictEqual(res.status, 0, `iterate.mjs failed:\n${res.stdout}\n${res.stderr}`);

  const kept = JSON.parse(readFileSync(path.join(dir, 'iterate.json'), 'utf8'));
  assert.strictEqual(kept.keptRound, 1, 'fixture must end on the round it kept, or it tests nothing');
  assert.strictEqual(kept.reconciled, true);

  // The fixture must not have re-cut at all: the artifact it started with is
  // already the kept cut.
  const finishes = existsSync(path.join(dir, 'finishes.log'))
    ? readFileSync(path.join(dir, 'finishes.log'), 'utf8').trim().split('\n')
    : [];
  assert.deepStrictEqual(finishes, [],
    `finish.mjs ran ${finishes.length} time(s) at speed(s) ${finishes.join(',')} on a run that ` +
    'changed nothing — each one is a metered music render, and re-cuts audio no critique scored');

  const planned = existsSync(path.join(dir, 'planner.log'))
    ? readFileSync(path.join(dir, 'planner.log'), 'utf8').trim().split('\n')
    : [];
  assert.deepStrictEqual(planned, [],
    `the camera planner ran ${planned.length} time(s) reconciling a run that changed nothing — ` +
    'a server round trip for a no-op restore');
});

// ENG-6104 round 2: putting a SUPPRESSION back is a doc rewrite plus a re-emit.
// Routing it through finish.mjs would re-run narration TTS and regenerate the
// music bed through a metered render, replacing audio the critique already
// scored — the same waste the guard removed from the common path, on the one
// path that does need reconciling.
test('restoring a camera-only difference does not re-cut the picture', () => {
  const dir = tmp();
  const id = 'take';

  writeFileSync(path.join(dir, 'finish.mjs'), [
    "import { appendFileSync, writeFileSync } from 'node:fs';",
    "const [outDir, id] = process.argv.slice(2);",
    "writeFileSync(`${outDir}/${id}.moda.json`, JSON.stringify({ actions: [",
    "  { index: 0, type: 'click', clickX: 100, clickY: 100, clickSec: 1 } ] }));",
    "appendFileSync(`${outDir}/finishes.log`, (process.env.DEMO_COMPRESS_SPEED ?? '?') + '\\n');",
  ].join('\n'));

  // Every round scores the same and reports a CAMERA finding naming action 0,
  // so the loop suppresses a punch-in and ties — reconciling on the way out
  // without any speed ever changing.
  writeFileSync(path.join(dir, 'critique-take.mjs'), [
    "import { writeFileSync } from 'node:fs';",
    "const [outDir] = process.argv.slice(2);",
    "writeFileSync(`${outDir}/critique.json`, JSON.stringify({ score: 5, shots: [],",
    "  issues: [{ stage: 'camera', severity: 'high', type: 'result_cropped',",
    "    fix: 'disable_zoom', detail: '{\"action\":0}' }] }));",
  ].join('\n'));

  // The planner must SUCCEED here: a camera fix only counts as applied when the
  // re-emit works, and an unapplied fix stops the loop at round 1 — which would
  // never reach the tie this test is about.
  writeFileSync(path.join(dir, 'moda'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  writeFileSync(path.join(dir, 'compile.py'), 'pass\n');
  writeFileSync(path.join(dir, `${id}.moda.json`), JSON.stringify({ actions: [
    { index: 0, type: 'click', clickX: 100, clickY: 100, clickSec: 1 }] }));

  const res = spawnSync('node', [path.join(HERE, 'iterate.mjs'), dir, id, '--rounds', '3', '--target', '9'], {
    cwd: dir, encoding: 'utf8',
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, DEMO_COMPRESS_SPEED: '6' },
  });
  assert.strictEqual(res.status, 0, `iterate.mjs failed:\n${res.stdout}\n${res.stderr}`);

  const kept = JSON.parse(readFileSync(path.join(dir, 'iterate.json'), 'utf8'));
  // The fixture has to have actually suppressed something and tied, or the
  // restore path under test was never entered.
  assert.ok(kept.rounds.length > 1, `never got past round 1: ${JSON.stringify(kept.rounds)}`);
  assert.ok(/dropping the punch-in/.test(res.stdout), 'fixture never suppressed a punch-in');
  assert.strictEqual(kept.reconciled, true);

  // THE OUTCOME, not just the cost. Round 1 — the kept round — had a punch-in on
  // action 0; round 2 suppressed it. Restoring has to bring the coordinates back,
  // and asserting only that finish.mjs stayed unrun cannot see whether it did:
  // `applySuppressions` used to be subtractive-only, so it left round 2's doc in
  // place and this test passed green on exactly the bug it was written for.
  const doc = JSON.parse(readFileSync(path.join(dir, `${id}.moda.json`), 'utf8'));
  assert.strictEqual(doc.actions[0].clickX, 100,
    'the kept round had a punch-in on action 0, but the doc on disk still has it suppressed');
  assert.strictEqual(doc.actions[0].clickY, 100);

  const finishes = existsSync(path.join(dir, 'finishes.log'))
    ? readFileSync(path.join(dir, 'finishes.log'), 'utf8').trim().split('\n')
    : [];
  assert.deepStrictEqual(finishes, [],
    `finish.mjs ran ${finishes.length} time(s) to put a suppression back — that is a metered ` +
    'music render and a fresh narration pass for a change that never touched the picture');
});

// The flag has to MEAN something to the caller: before it existed, a failed
// final re-cut threw and stopped the pipeline. Recording it and carrying on is
// strictly worse than that crash if nothing acts on it — run.mjs would rank the
// attempt by a score belonging to a cut that is not on disk, and with `!best`
// true on the first attempt it would then PUBLISH it.
//
// Tested through the real decision, not a copy of it: an earlier version of this
// test regex-matched run.mjs's source and re-evaluated a hand-transcribed pair of
// expressions, which would stay green through any behaviour change that kept the
// substring.
test('an unreconciled report is unusable, not merely low-scoring', () => {
  const critique = { score: 4, issues: [{ severity: 'high', type: 'x', description: 'from the last cut' }] };
  const kept = { keptRound: 1, score: 9, reconciled: false, issues: [{ severity: 'high', type: 'y' }] };

  const bad = keptReport({ kept, critique });
  assert.strictEqual(bad.usable, false, 'an unreconciled attempt must not be selectable or publishable');
  assert.strictEqual(bad.score, 0, 'it must not be able to win on a score it cannot back');
  assert.deepStrictEqual(bad.issues, [], 'its findings must not steer a re-record');

  // A reconciled report is unaffected: the kept cut's score and ITS findings win
  // over the last critique's, which after a revert describe a discarded video.
  const good = keptReport({ kept: { ...kept, reconciled: true }, critique });
  assert.strictEqual(good.usable, true);
  assert.strictEqual(good.score, 9);
  assert.deepStrictEqual(good.issues, [{ severity: 'high', type: 'y' }]);

  // No iterate.json at all (the loop never ran) is unscored but still usable —
  // only a FAILED reconciliation makes an attempt unusable.
  const none = keptReport({ kept: null, critique });
  assert.strictEqual(none.usable, true);
  assert.strictEqual(none.score, 4);
  assert.deepStrictEqual(none.issues, critique.issues);
});

// ENG-6104 round 3: an unusable attempt reports NO findings, because they were
// dropped with it. If the "no findings left" branch is reached first, that empty
// list reads as "nothing a different flow would fix" and the loop retires the
// expensive lever on the strength of a report it just refused — and on the
// default single-attempt run it also stops before anything can replace it.
// The order of these checks IS the decision, so it is pinned here.
test('an unusable attempt is re-recorded, never read as nothing-left-to-fix', () => {
  const unusable = { usable: false, score: 0, flowFindings: [], target: 8 };
  assert.strictEqual(nextStep({ ...unusable, n: 1, attempts: 3 }), 're-record',
    'empty findings from a REFUSED report must not retire the re-record lever');

  // A trusted report with nothing left is the case that genuinely should stop.
  assert.strictEqual(nextStep({ usable: true, score: 5, flowFindings: [], target: 8, n: 1, attempts: 3 }),
    'nothing-to-fix');

  // An unusable attempt can never claim the target, however its score reads.
  assert.strictEqual(nextStep({ usable: false, score: 9, flowFindings: [], target: 8, n: 1, attempts: 3 }),
    're-record', 'a refused report must not be able to end the run by hitting the target');
  assert.strictEqual(nextStep({ usable: true, score: 9, flowFindings: [], target: 8, n: 1, attempts: 3 }),
    'reached-target');

  // Budget still wins over re-recording, or the loop would never end.
  assert.strictEqual(nextStep({ ...unusable, n: 3, attempts: 3 }), 'out-of-attempts');
});

// ENG-6104: an unreconciled attempt must not be selectable, and therefore must
// not be published. Caught in review TWICE on this surface — the second time
// because a merge left the older unguarded assignment beside the guarded one and
// the unguarded one ran first — so both the decision and its uniqueness are
// pinned here rather than left to the next reviewer.
test('only a recorded, reconciled attempt may be selected as best', () => {
  assert.strictEqual(canSelect({ outDir: '/tmp/x', usable: true }), true);
  assert.strictEqual(canSelect({ outDir: '/tmp/x', usable: false }), false, 'unreconciled must never be publishable');
  // Nothing recorded is not selectable either, but it is not "unusable" — the
  // caller turns that into guidance instead.
  assert.strictEqual(canSelect({ outDir: null, usable: true }), false);
  // A flow that predates the flag is selectable: only an explicit false refuses.
  assert.strictEqual(canSelect({ outDir: '/tmp/x' }), true);
  assert.strictEqual(canSelect(undefined), false);
});

test('run.mjs has exactly ONE best-selection assignment', () => {
  // A source-level count because the defect is source-level: a merge duplicating
  // the line is invisible to any behavioural test of the predicate, and the
  // duplicate wins by running first. This asserts the shape that made the bug
  // possible cannot come back.
  const src = readFileSync(path.join(HERE, 'run.mjs'), 'utf8');
  const assignments = src.split('\n').filter((l) => /\bbest\s*=\s*r\b/.test(l) && !l.trim().startsWith('//'));
  assert.strictEqual(assignments.length, 1,
    `expected one \`best = r\` assignment, found ${assignments.length}:\n${assignments.join('\n')}`);
  assert.match(assignments[0], /canSelect\(/,
    'the selection assignment must go through canSelect, not an inline predicate');
});



// ENG-6124: every take was clicks only. The pipeline can type — discovery has a
// `type` action, curate never drops a fill, and capture types it visibly at
// 45ms/char with the cursor faded out — but discovery never proposed one,
// because its prompt optimises for the most direct path and clicking Run IS the
// most direct path when the editor already shows a placeholder.
test('a flow that skipped the input the product offered is refused', () => {
  const offered = (steps) => ({ sawTextField: true, steps });
  assert.strictEqual(checkInputShown(offered([{ action: 'click' }, { action: 'wait' }])).bad, true);
  // One fill is enough — this asks whether the demo SHOWS the asking, not how much.
  assert.strictEqual(checkInputShown(offered([{ action: 'fill', text: 'select 1' }, { action: 'click' }])).bad, false);
});

test('a product that offers no text field is not refused for having no typing', () => {
  // The failure that would be worse than the bug: refusing every click-only demo
  // of a product that legitimately takes no input.
  const r = checkInputShown({ sawTextField: false, steps: [{ action: 'click' }] });
  assert.strictEqual(r.measured, false);
  assert.strictEqual(r.bad, undefined);
  assert.match(r.reason, /finished on offered no typeable field/);
});

test('a flow with no text-field record says so rather than guessing', () => {
  const r = checkInputShown({ steps: [{ action: 'click' }] });
  assert.strictEqual(r.measured, false);
  assert.strictEqual(r.bad, undefined);
  assert.match(r.reason, /predates the text-field record/);
});

test('discover-flow persists sawTextField, or the check goes silently blind', () => {
  // The one link in this chain that fails QUIETLY: if the writer drops the field,
  // checkInputShown reports "unknown" forever and the gate never fires again —
  // a check that measures nothing while every test above still passes.
  const src = readFileSync(path.join(HERE, 'discover-flow.mjs'), 'utf8');
  const write = /writeFileSync\(\s*out,\s*JSON\.stringify\(\s*\{([\s\S]*?)\}/.exec(src);
  assert.ok(write, 'could not find the flow write in discover-flow.mjs');
  assert.match(write[1], /typeableFields/,
    'discover-flow.mjs must persist typeableFields — the guidance names the field it saw');
  assert.match(write[1], /sawTextField/,
    'discover-flow.mjs must persist sawTextField — without it the pre-record input check can never fire');

  // And end to end through the curation transforms the flow actually passes through.
  const { without, ensureTrailingHold } = require('../src/curate.js');
  const flow = JSON.parse(JSON.stringify({ goal: 'g', steps: [{ action: 'click' }], sawTextField: true }));
  const curated = without(ensureTrailingHold(flow).flow, []);
  assert.strictEqual(checkInputShown(curated).measured, true,
    'curation dropped sawTextField, so the check would report "unknown" on every real run');
  assert.strictEqual(checkInputShown(curated).bad, true);
});

// ENG-6124 round 1: the first cut read typeability off the snapshot ROLE, which
// is wrong in both directions — and wrong in the direction that matters most for
// exactly the case that filed the ticket.
//
// This EXECUTES the rule that ships. The first version of this test asserted
// `list.some((e) => e.typeable)` over hand-written literals that already carried
// the value being asserted, so reverting typeableOf to role-based inference left
// it green — a test whose name promised the coverage its body did not have,
// which is the class this file's own header was written about. The rule lives
// inside `pageSnapshot` because that function is serialized into the browser and
// cannot reference anything outside itself, so it is lifted out of the source
// text and run against element stubs rather than re-typed here.
test('typeability is decided from the DOM, not from the snapshot role', () => {
  const src = readFileSync(path.join(HERE, 'src', 'snapshot.js'), 'utf8');
  const block = /const TYPEABLE_KINDS = \[[\s\S]*?const typeableOf = [^;]+;/.exec(src);
  assert.ok(block, 'could not lift the typeability rule out of snapshot.js — it was renamed or removed');
  const typeableOf = new Function(`${block[0]}; return typeableOf;`)();

  const el = ({ tag = 'input', type, contentEditable = false, readOnly = false }) => ({
    tagName: tag.toUpperCase(),
    isContentEditable: contentEditable,
    readOnly,
    getAttribute: (a) => (a === 'type' ? type ?? null : null),
  });

  // The shape the ticket describes: a rich-text/prompt/code editor. Its snapshot
  // ROLE is its tag ("div"), so role-based inference misses it entirely.
  assert.strictEqual(typeableOf(el({ tag: 'div', contentEditable: true })), true);
  assert.strictEqual(typeableOf(el({ tag: 'textarea' })), true);
  assert.strictEqual(typeableOf(el({ type: 'text' })), true);
  assert.strictEqual(typeableOf(el({ type: 'search' })), true);
  // An <input> with no type attribute defaults to text.
  assert.strictEqual(typeableOf(el({})), true);

  // ...and the other direction: roleOf reports BOTH of these as "textbox", so
  // role-based inference would refuse a click-only demo that merely has a slider.
  assert.strictEqual(typeableOf(el({ type: 'range' })), false);
  assert.strictEqual(typeableOf(el({ type: 'file' })), false);
  assert.strictEqual(typeableOf(el({ type: 'color' })), false);
  assert.strictEqual(typeableOf(el({ tag: 'button' })), false);
  // A field you cannot type into is a display, not an input the demo skipped.
  assert.strictEqual(typeableOf(el({ type: 'text', readOnly: true })), false);
});

test("the snapshot's typeable rule matches the module that does the typing", () => {
  // snapshot.js runs inside the page and cannot require steps.js, so the kind
  // list is duplicated. steps.js's own header records what happened last time
  // two of these disagreed: the recorder typed into a control that ignores
  // typing and the demo showed a cursor entering values that never took.
  const snap = readFileSync(path.join(HERE, 'src', 'snapshot.js'), 'utf8');
  const steps = readFileSync(path.join(HERE, 'src', 'steps.js'), 'utf8');
  const kinds = (src, decl) => {
    const m = new RegExp(decl + '[^\\[]*\\[([^\\]]*)\\]').exec(src);
    assert.ok(m, `could not find ${decl} in the source`);
    return new Set([...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]));
  };
  const fromSnapshot = kinds(snap, 'TYPEABLE_KINDS');
  const fromSteps = kinds(steps, 'const TYPEABLE = new Set\\(');
  assert.deepStrictEqual([...fromSnapshot].sort(), [...fromSteps].sort(),
    'snapshot.js TYPEABLE_KINDS and steps.js TYPEABLE disagree — one of them is now lying about what can be typed into');
});

test('a fill with no text is not showing the input', () => {
  // `asFlowStep` builds fills as `text: action.text ?? ''`, so a `type` action
  // returned without text yields an empty fill and `enterText` clears the field
  // and types nothing. Counting it would report clean on the defect itself.
  const offered = (steps) => ({ sawTextField: true, steps });
  assert.strictEqual(checkInputShown(offered([{ action: 'fill', text: '' }])).bad, true);
  assert.strictEqual(checkInputShown(offered([{ action: 'fill', text: '   ' }])).bad, true);
  assert.strictEqual(checkInputShown(offered([{ action: 'fill' }])).bad, true);
  assert.strictEqual(checkInputShown(offered([{ action: 'fill', text: 'select 1' }])).bad, false);
});

// ENG-6124 round 2: three separate bugs lived in this derivation, each invisible
// until a reviewer read it. All three are shapes a real page produces.
test('a typeable field with no name is still a field', () => {
  // The commonest labelling on the web — <label for> or aria-labelledby — leaves
  // the snapshot's name AND placeholder empty. Filtering on "has a name we can
  // print" reported no field at all, so the gate never fired for it. Naming is
  // presentation; it must not gate detection.
  const r = inputEvidence([{ typeable: true, role: 'textbox', name: '', placeholder: undefined }]);
  assert.strictEqual(r.sawTextField, true, 'an unnamed input is still an input the demo skipped');
  assert.deepStrictEqual(r.typeableFields, [], 'and there is simply nothing to quote back');
});

test('the page the flow ENDS on decides, so a landing-page search box does not stick', () => {
  // Clicking through a landing page with a search box into a click-only tool.
  // Only overwriting on a non-empty snapshot carried that box to the end and
  // refused the flow, costing another full discovery.
  const landing = [{ typeable: true, name: 'Search', placeholder: 'Search docs' }, { typeable: false, name: 'Tools' }];
  const tool = [{ typeable: false, name: 'Run' }, { typeable: false, name: 'Reset' }];
  assert.strictEqual(inputEvidence(landing).sawTextField, true);
  assert.strictEqual(inputEvidence(tool).sawTextField, false,
    'a field-less final page must read as no-input-offered, not inherit the landing page');
  assert.deepStrictEqual(inputEvidence(landing).typeableFields, ['Search docs']);
});

test('no snapshot at all is not a claim that input was offered', () => {
  assert.deepStrictEqual(inputEvidence(null), { sawTextField: false, typeableFields: [] });
  assert.deepStrictEqual(inputEvidence([]), { sawTextField: false, typeableFields: [] });
});

// ENG-6124 round 3: this line has been wrong twice — first sticky (only
// overwriting on a non-empty snapshot), then wait-clobbered. `list` at the top
// of a discovery turn is the page AFTER the previous action, and every demo ends
// on a hold, so counting waits replaced the composer page with whatever the
// click produced. On the ticket's own shape — "click Run, hold" — that silences
// the gate on precisely the demo it exists to refuse.
test('a trailing wait does not move the evidence off the page that was clicked', () => {
  const composer = [{ typeable: true, placeholder: 'Ask anything' }];
  const spinner = [{ typeable: false, name: 'Cancel' }];

  // click Run on the composer page, then hold while it runs.
  let evidence = null;
  evidence = evidenceFor('click', composer, evidence);
  evidence = evidenceFor('wait', spinner, evidence);
  assert.deepStrictEqual(evidence, composer,
    'the hold replaced the composer page with the result page, so the skipped input became invisible');
  assert.strictEqual(inputEvidence(evidence).sawTextField, true);
});

test('a later click into a click-only tool still clears the evidence', () => {
  // The round-2 bug must not come back while fixing the round-3 one: a landing
  // page's search box must not survive into a tool that offers no input.
  const landing = [{ typeable: true, placeholder: 'Search' }];
  const tool = [{ typeable: false, name: 'Run' }];
  let evidence = null;
  evidence = evidenceFor('click', landing, evidence);
  evidence = evidenceFor('click', tool, evidence);
  assert.deepStrictEqual(evidence, tool, 'a later interaction must overwrite, or the signal is sticky again');
  assert.strictEqual(inputEvidence(evidence).sawTextField, false);
});

test('discovery records the evidence in exactly one place, through evidenceFor', () => {
  // A source guard because the defect is source-shaped and has recurred: an
  // inline assignment beside the shared one would win or lose by ordering, the
  // way the duplicated `best = r` did.
  const src = readFileSync(path.join(HERE, 'src', 'discovery.js'), 'utf8');
  const writes = src.split('\n').filter((l) => /listAtLastKeptStep\s*=/.test(l) && !l.trim().startsWith('//'));
  assert.strictEqual(writes.length, 2,
    `expected the declaration and one assignment, found ${writes.length}:\n${writes.join('\n')}`);
  assert.match(writes[1], /evidenceFor\(/,
    'the evidence assignment must go through evidenceFor, not an inline rule');
});

// ENG-6128: an empty camera program had ONE reported cause — "every action
// changed too much of the page to frame" — which the checker cannot know. All
// it observes is that a camera was attempted and no file appeared. The server
// publishes `planned` alongside the program precisely so a FLAT take can be told
// from a HELD one, and its own comment says a caller must not report them alike.
test('an empty camera program reports the cause it was given, not an assumed one', () => {
  // Planned nothing: genuinely flat.
  assert.match(emptyCameraReason({ planned: 0, emitted: 0 }), /planned NO punch-ins/);

  // Planned some, emitted none: HELD. A different finding with a different
  // remedy — the zooms exist and were withheld, so "reframe the page" is wrong.
  // TOLD, not deduced: the emitter states the held count and the action indices
  // in this warning, so the reason quotes it rather than subtracting a program
  // count from a punch-in count to reach a number it already has.
  const warning = 'zoom_awaiting_confirmation: 3 punch-in(s) were planned from inferred clicks and NOT written — actions [0, 1, 2].';
  const held = emptyCameraReason({ planned: 3, programs: 0, warnings: [warning] });
  assert.match(held, /planned 3 punch-in\(s\) and wrote none/);
  assert.match(held, /actions \[0, 1, 2\]/, 'the reason must carry the indices the planner named');
  assert.doesNotMatch(held, /planned NO punch-ins/, 'a held take must not be reported as a flat one');

  // Planned some, wrote none, and said nothing about why: that is its own answer.
  const silent = emptyCameraReason({ planned: 3, programs: 0, warnings: [] });
  assert.match(silent, /did not say which were held/);
  assert.doesNotMatch(silent, /awaiting confirmation/, 'never claim held without being told');

  // A program WAS written and could not be read back — not flat, not held.
  const unread = emptyCameraReason({ planned: 3, programs: 1, warnings: [] });
  assert.match(unread, /none could be read back/);
  assert.doesNotMatch(unread, /awaiting confirmation|were withheld/,
    'nothing was withheld, so it must not be reported as a held take');
});

test('no plan record says so, rather than inventing a reason', () => {
  // The compile.py lane writes a file and returns no JSON, and a hand-run
  // critique has no record at all. "I was not told" is a third state.
  for (const absent of [null, undefined, {}, { planned: 'three' }]) {
    assert.match(emptyCameraReason(absent), /did not report why/);
    assert.doesNotMatch(emptyCameraReason(absent), /changed too much|no action offered/,
      'the checker must not assert a cause it was never given');
  }
});

test('the planner report is parsed only when it is actually a report', () => {
  assert.deepStrictEqual(
    parseCameraReport('{"planned":2,"camera_program":["a"],"warnings":["w"]}'),
    // `programs`, not `emitted`: the emitter writes ONE string carrying the whole
    // merged path, so this counts programs and must never be subtracted from
    // `planned`, which counts punch-ins.
    { planned: 2, programs: 1, warnings: ['w'] });
  // The verb prints progress before its JSON; the last object line is the body.
  assert.deepStrictEqual(
    parseCameraReport('planning…\n{"planned":0,"camera_program":[],"warnings":[]}'),
    { planned: 0, programs: 0, warnings: [] });
  // Nothing to parse must be null, NOT a zero-valued report — a fabricated
  // `planned: 0` would report a flat take on the lane that simply does not say.
  for (const nothing of ['', '   ', undefined, null, 'not json', '{"camera_program":[]}']) {
    assert.strictEqual(parseCameraReport(nothing), null, `expected null for ${JSON.stringify(nothing)}`);
  }
});

test('iterate reads `.ran`, never the emitCameraInto object itself', () => {
  // emitCameraInto now returns an OBJECT, and an object is always truthy — so a
  // call site left branching on the raw return would silently read every failed
  // emit as success. Source-level because that is the shape of the mistake.
  const src = readFileSync(path.join(HERE, 'iterate.mjs'), 'utf8');
  const raw = src.split('\n').filter((l) => /emitCameraInto\(/.test(l) && !l.trim().startsWith('//'));
  assert.strictEqual(raw.length, 1, `expected one emitCameraInto call, found ${raw.length}`);
  assert.match(raw[0], /\{\s*ran\s*,\s*report\s*\}/,
    'the emitCameraInto result must be destructured, not used as a boolean');
});

// ENG-6128 round 1: the whole handoff hinges on one filename, written by
// iterate.mjs and read by critique-take.mjs in a different process. Two
// independent literals would drift, the reader's catch would swallow the miss,
// and the checker would revert to "the planner did not report why" on every
// take — a silent fail-open. Nothing exercised the write→read path.
test('the plan record written by one process is the one the other reads', () => {
  const dir = tmp();
  const id = 'take';
  const report = { planned: 2, programs: 0, warnings: ['zoom_awaiting_confirmation: 2 punch-in(s) … actions [0, 1]'] };

  // WRITE the way iterate.mjs does, READ the way critique-take.mjs does — both
  // through the shared path, which is the point.
  writeFileSync(cameraPlanPath(dir, id), JSON.stringify(report, null, 2));
  const readBack = JSON.parse(readFileSync(cameraPlanPath(dir, id), 'utf8'));
  assert.deepStrictEqual(readBack, report);
  assert.match(emptyCameraReason(readBack), /actions \[0, 1\]/,
    'the reason must survive the round trip between the two processes');
});

test('both processes derive the plan path from one definition', () => {
  // A source guard because the failure is silent: if either side goes back to
  // its own literal the read misses and the checker quietly says it was never
  // told, which is indistinguishable from the lane that genuinely is not.
  for (const f of ['iterate.mjs', 'critique-take.mjs']) {
    const src = readFileSync(path.join(HERE, f), 'utf8');
    assert.doesNotMatch(src, /camera-plan\.json/,
      `${f} spells the plan filename itself instead of using cameraPlanPath`);
    assert.match(src, /cameraPlanPath\(/, `${f} must derive the plan path from camera-emit.js`);
  }
});

// ENG-6133: discovery ends on one of eight reasons and only `done` is success.
// The other seven were printed to the console and dropped from the flow file,
// so an abandoned walk was curated, recorded, scored and published exactly like
// a finished one. The take that filed this scored 2/10 with three of its five
// actions being the agent narrating an absence before it gave up.
test('a walk the agent abandoned is not treated as a finished one', () => {
  assert.strictEqual(checkWalkFinished({ stopped: 'done' }).finished, true);
  // Every non-done ending is an abandonment, and each says something a
  // re-discovery could act on.
  for (const stopped of Object.keys(GAVE_UP)) {
    const r = checkWalkFinished({ stopped });
    assert.strictEqual(r.measured, true, `${stopped} must be measured`);
    assert.strictEqual(r.finished, false, `${stopped} is not a completed walk`);
    assert.ok(r.reason && r.reason.length > 20, `${stopped} must explain itself, got ${r.reason}`);
    assert.ok(r.advice && r.advice.length > 20, `${stopped} must tell the next attempt what to do`);
  }
});

test('an ending this list has not learned is still not a success', () => {
  // A new `stopped` value added to discovery must fail closed: not done is not
  // done, even when there is no sentence for it yet.
  const r = checkWalkFinished({ stopped: 'some_future_reason' });
  assert.strictEqual(r.finished, false);
  assert.match(r.reason, /some_future_reason/, 'name the value rather than inventing an explanation');
});

test('a flow with no discovery outcome is unknown, not failed', () => {
  // A hand-supplied `--flow` never ran discovery, and a file written before this
  // existed has no field. Refusing those would be worse than the bug.
  for (const flow of [{}, null, undefined, { stopped: '' }, { stopped: 7 }]) {
    const r = checkWalkFinished(flow);
    assert.strictEqual(r.measured, false, `${JSON.stringify(flow)} must read as unknown`);
    assert.strictEqual(r.finished, undefined, 'unknown must not read as finished OR failed');
  }
});

test('discover-flow persists the stop reason, or the gate can never fire', () => {
  // The same silent-drop this ticket is about: the writer printed it and left it
  // out of the file. Nothing downstream fails loudly when that happens — the
  // gate just goes quiet — so it is pinned here.
  const src = readFileSync(path.join(HERE, 'discover-flow.mjs'), 'utf8');
  const write = /writeFileSync\(\s*out,\s*JSON\.stringify\(\s*\{([\s\S]*?)\},/.exec(src);
  assert.ok(write, 'could not find the flow write in discover-flow.mjs');
  assert.match(write[1], /stopped:\s*result\.stopped/,
    'discover-flow.mjs must persist `stopped` — without it run.mjs cannot tell an abandoned walk from a finished one');
});

test('run.mjs HARD-refuses an unfinished walk, on any number of attempts', () => {
  const src = readFileSync(path.join(HERE, 'run.mjs'), 'utf8');
  assert.match(src, /checkWalkFinished\(/, 'run.mjs must consult the walk outcome');

  // A SOFT pre-record finding would not do: that lane only refuses while
  // attempts remain (`preRecord.length && n < attempts`), so on the default
  // --attempts 1 it logs "recording anyway (no attempts left)" and films the
  // abandoned walk — the exact harm this exists to stop. It must return the
  // same no-recording shape as `empty_flow` and `walk_failed`.
  const gate = src.slice(src.indexOf('const walkOutcome'), src.indexOf('const walkOutcome') + 900);
  assert.match(gate, /return \{ outDir: null, id: null, score: 0, flowFindings:/,
    'the walk gate must hard-refuse, not push a soft pre-record finding');
  assert.match(gate, /walk_unfinished/);

  // ...and BEFORE curation and the validation walk, which cost a headless
  // browser and up to four restore-and-rewalk passes. Nothing about this check
  // depends on either.
  assert.ok(src.indexOf('walk_unfinished') < src.indexOf('[2] curating'),
    'the walk check must run before curation, or an abandoned walk still pays for validation');
});

// ENG-6133 round 2: the finding becomes GUIDANCE in the next discovery's system
// prompt, so the advice has to match what actually broke. Three of the seven
// endings are harness failures, not path failures — telling a run that hit a
// Cloudflare wall to "find a different path" steers it off a route that may
// have been fine.
test('a harness failure is not blamed on the path', () => {
  const { checkWalkFinished } = require('../src/walk-outcome.js');
  for (const stopped of ['bot_challenge', 'model_error', 'unparsable']) {
    const r = checkWalkFinished({ stopped });
    assert.strictEqual(r.kind, 'harness', `${stopped} broke on the tooling or the site`);
    assert.match(r.advice, /walk it again/, `${stopped} should be retried, not re-planned`);
    assert.doesNotMatch(r.advice, /different goal.*from here|Find a path that reaches/,
      `${stopped} must not send the next attempt looking for another path`);
  }
  for (const stopped of ['max_steps', 'timeout', 'waited_out', 'repeated_action']) {
    const r = checkWalkFinished({ stopped });
    assert.strictEqual(r.kind, 'path', `${stopped} is the route failing`);
    assert.match(r.advice, /Find a path that reaches the goal/);
  }
});

test('an unrecognised ending gets the conservative advice', () => {
  // Claiming the tooling broke would be an assertion about something we were
  // never told; asking for a different route is the safe half.
  const { checkWalkFinished } = require('../src/walk-outcome.js');
  const r = checkWalkFinished({ stopped: 'some_future_reason' });
  assert.strictEqual(r.kind, 'path');
  assert.match(r.advice, /Find a path that reaches the goal/);
});

