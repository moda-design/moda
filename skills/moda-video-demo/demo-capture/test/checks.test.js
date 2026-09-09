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
const { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } = require('node:fs');
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


// ENG-6130: "long static tails" sat on the quality deck until the arithmetic
// closed — 2.023s of "dead time" in a 6.034s clip is 33.5%, and TAIL_KEEP is
// 2.0. The whole finding WAS the deliberate reveal beat, which compressIdleGaps
// protects and no pacing fix can touch. The loop raised it, applied its only
// lever, saw no change, and repeated until the plateau detector stopped it.
test('the protected reveal beat is not counted as dead time', () => {
  const { checkShots } = require('../src/shot-check.js');
  // The real take, to the millisecond.
  const doc = {
    durationSec: 6.034,
    viewport: { width: 1280, height: 800 },
    actions: [
      { index: 0, type: 'click', startSec: 0.5, endSec: 2.0, clickSec: 1.0, clickX: 100, clickY: 100 },
      { index: 1, type: 'wait', startSec: 4.011, endSec: 6.034 },
    ],
  };
  const dead = checkShots({ doc, outDir: '/tmp', id: 'x' }).deadTime;
  assert.strictEqual(dead.measured, true);
  // Nothing hidden: the viewer really does wait through all of it.
  assert.ok(Math.abs(dead.seconds - 2.023) < 0.001, `seconds should still report the full wait, got ${dead.seconds}`);
  assert.ok(Math.abs(dead.protectedWait - 2.0) < 0.05, `the wait IS the protected beat, got ${dead.protectedWait}`);
  assert.ok(dead.recoverable < 0.05, `only the sliver past the beat is recoverable, got ${dead.recoverable}`);
  assert.strictEqual(dead.bad, false,
    'a 6s take whose only wait IS the reveal must not be flagged — no fix could act on it');
});

test('a wait that genuinely outlasts the reveal is still flagged', () => {
  // The guard must not swallow real dead time: this is the case the check exists
  // for, and it has to survive the fix.
  const { checkShots } = require('../src/shot-check.js');
  const doc = {
    durationSec: 30,
    viewport: { width: 1280, height: 800 },
    actions: [
      { index: 0, type: 'click', startSec: 0.5, endSec: 1.0, clickSec: 0.8, clickX: 10, clickY: 10 },
      { index: 1, type: 'wait', startSec: 2, endSec: 20 },   // 18s of the product thinking
      { index: 2, type: 'wait', startSec: 28, endSec: 30 },  // the reveal
    ],
  };
  const dead = checkShots({ doc, outDir: '/tmp', id: 'x' }).deadTime;
  assert.strictEqual(dead.bad, true, '18s of waiting is dead time a pacing fix CAN remove');
  assert.ok(dead.recoverable > 17, `expected ~18s recoverable, got ${dead.recoverable}`);
});

test('a clip no longer than the reveal beat cannot go negative', () => {
  const { checkShots } = require('../src/shot-check.js');
  const doc = {
    durationSec: 1.5,
    viewport: { width: 1280, height: 800 },
    actions: [{ index: 0, type: 'wait', startSec: 0, endSec: 1.5 }],
  };
  const dead = checkShots({ doc, outDir: '/tmp', id: 'x' }).deadTime;
  assert.strictEqual(dead.recoverable, 0, 'nothing in a 1.5s clip is compressible, so nothing is recoverable');
  assert.ok(dead.recoverable >= 0, 'recoverable must never be negative');
});


// ENG-6130 round 1: the first cut subtracted the beat's LENGTH from the total
// wait, wherever the waits sat. The compressor protects a POSITION —
// `[D - TAIL_KEEP, D]` — so that excused 2s of fully compressible wait anywhere
// in the take, turning a false positive into a false negative, which is worse.
// The earlier "still flagged" test missed it because its wait was 18s.
test('a wait that misses the protected tail is not excused by it', () => {
  const { checkShots } = require('../src/shot-check.js');
  // 10s clip, one 4.5s wait at the START, tail fully active. Every second of
  // that wait is compressible.
  const doc = {
    durationSec: 10,
    viewport: { width: 1280, height: 800 },
    actions: [
      { index: 0, type: 'wait', startSec: 0, endSec: 4.5 },
      { index: 1, type: 'click', startSec: 5, endSec: 10, clickSec: 6, clickX: 10, clickY: 10 },
    ],
  };
  const dead = checkShots({ doc, outDir: '/tmp', id: 'x' }).deadTime;
  // NOT 4.5s. An earlier cut of this test asserted the whole wait was
  // recoverable, which encoded the very overclaim the check exists to stop:
  // HEAD_KEEP protects [0, 1.0], BREATHING_SEC keeps [1.0, 1.35] at 1x, and
  // WAIT_RESULT_KEEP protects [2.9, 4.5]. The compressor speeds [1.35, 2.9].
  assert.ok(Math.abs(dead.recoverable - 1.55) < 0.01,
    `the compressor speeds 1.55s of this wait, not the whole of it — got ${dead.recoverable}`);
  assert.ok(Math.abs(dead.protectedWait - 2.95) < 0.01, `the rest is protected, got ${dead.protectedWait}`);
});

test('a wait straddling the tail is excused only for the part inside it', () => {
  const { checkShots } = require('../src/shot-check.js');
  // 10s clip, wait 6→10: 2s of it (8→10) is the protected beat, 2s is not.
  const doc = {
    durationSec: 10,
    viewport: { width: 1280, height: 800 },
    actions: [
      { index: 0, type: 'click', startSec: 0, endSec: 1, clickSec: 0.5, clickX: 10, clickY: 10 },
      { index: 1, type: 'wait', startSec: 6, endSec: 10 },
    ],
  };
  const dead = checkShots({ doc, outDir: '/tmp', id: 'x' }).deadTime;
  assert.ok(Math.abs(dead.protectedWait - 2.0) < 0.01, `the tail half is protected, got ${dead.protectedWait}`);
  assert.ok(Math.abs(dead.recoverable - 2.0) < 0.01, `the half before the beat is recoverable, got ${dead.recoverable}`);
});

test('the dead-time report renders the protected duration, not a dangling field', () => {
  // CALLS the real formatter. Three earlier guards for this sentence could all
  // pass while the report said something false: one grepped for a literal, one
  // pinned a regex to syntax that had since been deleted, and one hand-built its
  // own copy of the phrase and asserted against the copy — that last one even
  // emitted the exact wording a sibling test asserts must NOT appear.
  const { deadTimePhrase } = require('../src/dead-time-phrase.js');

  // A renamed-away field is what broke this before: `reveal` became
  // `protectedWait` and the clause silently stopped rendering.
  const rendered = deadTimePhrase(
    { seconds: 4.0, protectedWait: 2.5, narrationHeld: 0, share: 0.15 }, 10);
  assert.match(rendered, /40% of the runtime/, 'the total the viewer waits through');
  assert.match(rendered, /15% a speed bump could still remove/, 'and what the remedy would actually return');
  assert.match(rendered, /2\.5s of it beyond any speed fix/, 'and the part no fix can reach');

  // Narration is named when it is material, and never as the reveal beat.
  const narrated = deadTimePhrase(
    { seconds: 16, protectedWait: 16, narrationHeld: 13.9, share: 0 }, 20);
  assert.match(narrated, /13\.9s of that held at 1x by narration/);
  assert.doesNotMatch(narrated, /reveal beat/);

  // Nothing protected: no dangling clause, no stray parenthetical.
  const clean = deadTimePhrase({ seconds: 1, protectedWait: 0, narrationHeld: 0, share: 0.1 }, 10);
  // The LABEL contains the word "protected" now, so assert the absent thing is
  // the clause — "Ns of it protected" — not any occurrence of the word.
  assert.doesNotMatch(clean, /s of it protected/);
});

test('the total and the recoverable share are never swapped', () => {
  // The previous guard was a regex pinned to the exact syntax this PR deleted,
  // so a recurrence spelled through the `pct()` helper could not match it — and
  // swapping the two numbers inside the formatter would have passed. Drive the
  // function with values that make a swap unmistakable instead.
  const { deadTimePhrase } = require('../src/dead-time-phrase.js');
  const rendered = deadTimePhrase(
    { seconds: 9, protectedWait: 8, narrationHeld: 0, share: 0.1 }, 10);
  // 90% waited, 10% recoverable — a swap would read "10% of the runtime is the
  // product thinking (90% recoverable)".
  assert.match(rendered, /90% of the runtime is the product thinking/);
  assert.match(rendered, /10% a speed bump could still remove/);
  assert.doesNotMatch(rendered, /10% of the runtime is the product thinking/);
});

// ENG-6130 round 2: the first two cuts of this check subtracted a CONSTANT
// (TAIL_KEEP) when the compressor keeps SIX kinds of span at 1x — the opening
// HEAD_KEEP, the closing TAIL_KEEP, the final WAIT_RESULT_KEEP of every wait,
// the BREATHING_SEC lead-in on every gap, POST_CLICK_KEEP after every click,
// and any residual gap under MIN_GAP_SEC that buildSegments leaves alone.
// (BREATHING_SEC and POST_CLICK_KEEP are exactly the two an earlier count
// omitted, which is why the guard below reads the list off compress.js.) A
// take made of short waits is therefore entirely incompressible, and calling
// that time "recoverable by pacing" is the same unactionable finding the whole
// ticket exists to close.
test('waits the compressor speeds none of are not called recoverable', () => {
  const { checkShots } = require('../src/shot-check.js');
  // 12s, four 1.5s waits between clicks, none touching the final 2s. Each wait
  // is shorter than WAIT_RESULT_KEEP + MIN_GAP_SEC, so there is nothing to speed
  // at any compress speed.
  const doc = {
    durationSec: 12,
    viewport: { width: 1280, height: 800 },
    actions: [
      { index: 0, type: 'click', startSec: 0, endSec: 1, clickSec: 0.5, clickX: 10, clickY: 10 },
      { index: 1, type: 'wait', startSec: 1, endSec: 2.5 },
      { index: 2, type: 'click', startSec: 2.5, endSec: 3, clickSec: 2.7, clickX: 10, clickY: 10 },
      { index: 3, type: 'wait', startSec: 3, endSec: 4.5 },
      { index: 4, type: 'click', startSec: 4.5, endSec: 5, clickSec: 4.7, clickX: 10, clickY: 10 },
      { index: 5, type: 'wait', startSec: 5, endSec: 6.5 },
      { index: 6, type: 'click', startSec: 6.5, endSec: 7, clickSec: 6.7, clickX: 10, clickY: 10 },
      { index: 7, type: 'wait', startSec: 7, endSec: 8.5 },
    ],
  };
  const dead = checkShots({ doc, outDir: '/tmp', id: 'x' }).deadTime;
  assert.ok(Math.abs(dead.seconds - 6) < 0.01, 'the viewer really does wait 6s — that is still reported');
  assert.strictEqual(dead.recoverable, 0, 'the compressor speeds none of it, so none of it is recoverable');
  assert.strictEqual(dead.bad, false,
    'raising a pacing finding here sends the loop at a lever that cannot move anything');
});

test('the recoverable measure comes from the compressor, not from its constants', () => {
  // Importing one constant and subtracting it described a different function
  // from the one that runs — twice. shot-check must ask the planner.
  const src = readFileSync(path.join(HERE, 'src', 'shot-check.js'), 'utf8');
  assert.match(src, /planCompression\(/, 'shot-check must ask the compressor what it would speed up');
  // DERIVED, not hand-listed. The first version of this guard named four
  // constants when the compressor tunes six — BREATHING_SEC keeps 0.35s at the
  // start of every gap and POST_CLICK_KEEP extends every action's span — so an
  // edit subtracting either would have shipped green under a message saying it
  // could not. A list that has to be kept in step with another file is the
  // thing this whole ticket is about, so read the names off compress.js.
  const compressSrc = readFileSync(path.join(HERE, 'src', 'compress.js'), 'utf8');
  const tunables = [...compressSrc.matchAll(/^const ([A-Z][A-Z_]*) = [0-9]/gm)].map((m) => m[1]);
  assert.ok(tunables.length >= 6, `expected compress.js's tuning constants, found ${tunables.join(', ')}`);

  // CODE only. The comment above the call names the protected regions on
  // purpose — that is the explanation, not a re-derivation.
  const code = src.split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'));
  const usesConstants = code.filter((l) => tunables.some((c) => new RegExp(`\\b${c}\\b`).test(l)));
  assert.deepStrictEqual(usesConstants, [],
    `shot-check must not re-derive any of compress.js's tuning constants (${tunables.join(', ')}):\n${usesConstants.join('\n')}`);
});

test('planCompression is the same planning the compressor itself uses', () => {
  // One seam: if compressIdleGaps stopped routing through it, the two could
  // disagree and this check would grade a plan nothing executes.
  const src = readFileSync(path.join(HERE, 'src', 'compress.js'), 'utf8');
  assert.match(src, /function compressIdleGaps[\s\S]{0,400}planCompression\(/,
    'compressIdleGaps must build its segments through planCompression');
});

// ENG-6130 round 3: the compressor that actually runs is called WITH narration
// spans, and keeps each at 1x — a line spoken over a sped-up gap would be
// talking about something the viewer has already flashed past. The checker was
// calling the same planner without them, so speech-protected wait time still
// counted as recoverable: the same unactionable plateau, arriving through the
// one protected region round 2 did not account for.
test('narration-protected waiting is not called recoverable', () => {
  const { checkShots } = require('../src/shot-check.js');
  const doc = {
    durationSec: 20,
    viewport: { width: 1280, height: 800 },
    actions: [
      { index: 0, type: 'click', startSec: 0, endSec: 1, clickSec: 0.5, clickX: 10, clickY: 10 },
      { index: 1, type: 'wait', startSec: 1, endSec: 17 },
    ],
  };
  const bare = checkShots({ doc, outDir: '/tmp', id: 'x' }).deadTime;
  assert.strictEqual(bare.bad, true, 'unnarrated, 16s of waiting really is compressible');

  // The same take with a line spoken across the whole wait: the compressor
  // protects it, so no pacing fix can shorten it.
  const narrated = checkShots({
    doc, outDir: '/tmp', id: 'x',
    narrationSpans: [{ startSec: 0.5, durationSec: 17 }],
  }).deadTime;
  assert.strictEqual(narrated.recoverable, 0,
    'the compressor speeds none of a narrated span, so none of it is recoverable');
  assert.strictEqual(narrated.bad, false,
    'raising a pacing finding over speech sends the loop at a lever that cannot move it');
});

test('finish.mjs persists the narration spans the compressor was given', () => {
  // The critique runs in another process and cannot see `planned`. Without the
  // record it asks the planner a differently-parameterised question than the
  // one that ran — and nothing fails loudly when that happens.
  const src = readFileSync(path.join(HERE, 'finish.mjs'), 'utf8');
  const critique = readFileSync(path.join(HERE, 'critique-take.mjs'), 'utf8');
  assert.match(src, /narrationPath\(/, 'finish.mjs must persist the spans it passed to the compressor');
  assert.match(critique, /narrationPath\(/, 'and critique-take.mjs must read them back');
  assert.match(critique, /narrationSpans/, 'and thread them into checkShots');
  // ONE definition of the filename. Two literals is the shape ENG-6128 was
  // fixed for on the sibling artifact, and this file had it too until review.
  for (const [name, text] of [['finish.mjs', src], ['critique-take.mjs', critique]]) {
    assert.doesNotMatch(text, /narration\.json/,
      `${name} spells the narration filename itself instead of using narrationPath`);
  }
});

// ENG-6130 round 4: the report named a closed list of three causes — the reveal
// beat, each wait's result hold, the opening — while `protectedWait` is
// everything the compressor keeps at 1x, narration included. On the narrated
// case above that printed "16.0s of it protected (the reveal beat, …)",
// attributing 16s to a 2.0s beat plus a 1.6s hold plus a 1.0s opening. False in
// the operator's report, and it points away from the one lever that works:
// `shorten_narration`, which iterate.mjs already routes to the pacing stage.
test('a narration-held wait is reported as narration, not as the reveal beat', () => {
  const { checkShots } = require('../src/shot-check.js');
  const doc = {
    durationSec: 20,
    viewport: { width: 1280, height: 800 },
    actions: [
      { index: 0, type: 'click', startSec: 0, endSec: 1, clickSec: 0.5, clickX: 10, clickY: 10 },
      { index: 1, type: 'wait', startSec: 1, endSec: 17 },
    ],
  };
  const d = checkShots({ doc, outDir: '/tmp', id: 'x', narrationSpans: [{ startSec: 0.5, durationSec: 17 }] }).deadTime;
  // 13.9, NOT the full 16: about 2.1s of that wait is protected anyway by the
  // result hold and the breathing lead-in, and crediting narration for it would
  // promise back time that shortening the line cannot return. The figure is the
  // difference between planning the clip with the spans and without them.
  const unnarrated = checkShots({ doc, outDir: '/tmp', id: 'x' }).deadTime;
  assert.ok(Math.abs(d.narrationHeld - 13.9) < 0.05, `expected ~13.9s held by the line, got ${d.narrationHeld}`);
  assert.ok(Math.abs(d.narrationHeld - unnarrated.recoverable) < 0.01,
    'what narration holds must equal what the same clip recovers without it');
  assert.ok(d.narrationHeld <= d.protectedWait + 1e-9, 'it is a subset of the protected total');

  // Rendered by the REAL formatter. A hand-built copy here would assert against
  // itself, which is the pattern src/dead-time-phrase.js exists to end.
  const { deadTimePhrase } = require('../src/dead-time-phrase.js');
  const held = deadTimePhrase(d, doc.durationSec);
  assert.match(held, /13\.9s of that held at 1x by narration/);
  assert.doesNotMatch(held, /reveal beat/,
    'attributing a narration hold to the reveal beat sends the operator at the wrong lever');

  // And with no narration, it must not claim any single cause either.
  const bare = checkShots({ doc, outDir: '/tmp', id: 'x' }).deadTime;
  assert.strictEqual(bare.narrationHeld, 0);
});

test('the report never names a closed list of protected causes', () => {
  // `protectedWait` absorbs the beat, the result holds, the opening, the
  // breathing lead-in, post-click keeps, sub-MIN_GAP residue and narration. Any
  // enumeration of it will be wrong for some take.
  //
  // RUNS the sentence. This grepped critique-take.mjs, and the sentence has
  // since moved into the formatter — so the enumeration could be reintroduced
  // where it now lives and this would still pass. A guard pointed at the wrong
  // file is the failure this module was created to stop.
  const { deadTimePhrase } = require('../src/dead-time-phrase.js');
  for (const d of [
    { seconds: 16, protectedWait: 16, narrationHeld: 13.9, share: 0 },
    { seconds: 4, protectedWait: 2.5, narrationHeld: 0, share: 0.15 },
  ]) {
    const rendered = deadTimePhrase(d, 20);
    assert.doesNotMatch(rendered, /reveal beat|result hold|the opening/,
      `the report must describe what the number IS, not list causes it does not match: ${rendered}`);
  }
});

// ENG-6130 round 5: narrationHeld was a raw overlap of the waits with the
// spans, so two spans over the same second counted twice and the figure could
// exceed the protected total it is a subset of. Derived as a plan difference it
// cannot: removing a protection only ever grows the sped set.
test('overlapping narration spans cannot inflate the held figure', () => {
  const { checkShots } = require('../src/shot-check.js');
  const doc = {
    durationSec: 20,
    viewport: { width: 1280, height: 800 },
    actions: [
      { index: 0, type: 'click', startSec: 0, endSec: 1, clickSec: 0.5, clickX: 10, clickY: 10 },
      { index: 1, type: 'wait', startSec: 1, endSec: 17 },
    ],
  };
  const one = checkShots({ doc, outDir: '/tmp', id: 'x', narrationSpans: [{ startSec: 0.5, durationSec: 17 }] }).deadTime;
  const two = checkShots({
    doc, outDir: '/tmp', id: 'x',
    narrationSpans: [{ startSec: 0.5, durationSec: 17 }, { startSec: 1, durationSec: 16 }],
  }).deadTime;
  assert.ok(Math.abs(one.narrationHeld - two.narrationHeld) < 0.01,
    'a second span over the same seconds holds no additional time');
  assert.ok(two.narrationHeld <= two.protectedWait + 1e-9,
    'the held figure must never exceed the protected total it is part of');
});

// ENG-6130 / ENG-6137: `narrationHeld` is REPORTED and nothing acts on it.
//
// A `narration_held` finding was added and then removed: `ownerOf` routes
// `fix: 'shorten_narration'` to the pacing stage, whose only action is a
// compress-speed bump, and a narration span is protected at any speed. The
// finding therefore moved nothing while `acted.push('pacing')` kept the loop
// alive, paying a full finish.mjs re-cut per round — narration TTS plus a
// metered music render — until the plateau detector stopped it.
//
// The guard shipped alongside it asserted that the string 'shorten_narration'
// appeared in ownerOf's condition and in run.mjs's exclusion array. Both were
// true. Neither says anything about code that shortens a line, and it passed
// vacuously against exactly this defect. This test pins the honest state
// instead, and fails when a lever is added so the finding can come back with it.
test('the narration fix is routed to a stage that can act on it', () => {
  // DRIVES the router. The guard this replaces read `iterate.mjs` as text and
  // asserted `'shorten_narration'` appeared in a condition — true throughout the
  // entire period the fix was handed to the pacing stage, whose one action is a
  // compress-speed bump that a 1x-protected span ignores at every speed.
  const { ownerOf } = require('../src/stages.js');
  assert.strictEqual(ownerOf({ fix: 'shorten_narration' }), 'narration',
    'the speed bump cannot move a protected span — this must not go to pacing');
  assert.strictEqual(ownerOf({ fix: 'speed_up' }), 'pacing');
  assert.strictEqual(ownerOf({ stage: 'flow', fix: 'shorten_narration' }), 'flow',
    'a declared stage still wins over inference');
});

test('dropping a line keeps every other pre-voiced line', () => {
  // DRIVES the drop. Re-synthesis is the thing to avoid: the take was paced to
  // this audio, and passing `lines` instead would bill TTS again and pace the
  // recording to sentences nobody hears.
  const { keepLines } = require('../src/narrate.js');
  const spoken = [{ index: 0, text: 'a' }, { index: 3, text: 'b' }, { index: 7, text: 'c' }];
  const { kept, dropped } = keepLines(spoken, '3');
  assert.deepStrictEqual(kept.map((l) => l.index), [0, 7], 'the others keep their recorded audio');
  assert.deepStrictEqual(dropped, [3]);
});

test('an empty drop spec drops nothing, not action zero', () => {
  // `Number('') === 0`, so the obvious parse turns "drop nothing" into "drop the
  // first line" — and iterate sends an empty spec on EVERY ordinary re-cut, so
  // this would delete the opening line of every take on the first pacing bump.
  const { keepLines } = require('../src/narrate.js');
  const spoken = [{ index: 0, text: 'a' }, { index: 3, text: 'b' }];
  for (const spec of ['', undefined, null, 'x,,']) {
    assert.deepStrictEqual(keepLines(spoken, spec).dropped, [],
      `spec ${JSON.stringify(spec)} must drop nothing`);
    assert.strictEqual(keepLines(spoken, spec).kept.length, 2);
  }
});

test('the finding names the line that holds the most wait', () => {
  // A remedy that cannot say WHICH line is unactionable in exactly the way the
  // old `shorten_narration` was.
  const { checkShots } = require('../src/shot-check.js');
  const doc = {
    durationSec: 30,
    viewport: { width: 1280, height: 800 },
    actions: [{ type: 'wait', index: 0, startSec: 2, endSec: 28 }],
  };
  // Two lines: a short one, and one spoken across most of the wait.
  const spans = [
    { startSec: 2, durationSec: 1.0, actionIndex: 0 },
    { startSec: 4, durationSec: 18.0, actionIndex: 4 },
  ];
  const dead = checkShots({ doc, outDir: '/tmp', id: 'x', narrationSpans: spans }).deadTime;
  assert.ok(dead.narrationWorst, 'a take with speech over a long wait must name a line');
  assert.strictEqual(dead.narrationWorst.actionIndex, 4, 'the long line is the one holding the wait');
  assert.ok(dead.narrationWorst.heldSec > 4,
    `and it must be worth a round, got ${dead.narrationWorst.heldSec}`);
});

test('a span that predates the action index yields no finding', () => {
  // Unnameable is not actionable. Emitting here would recreate the loop that
  // re-cuts for a remedy nothing can apply.
  const { checkShots } = require('../src/shot-check.js');
  const doc = {
    durationSec: 30,
    viewport: { width: 1280, height: 800 },
    actions: [{ type: 'wait', index: 0, startSec: 2, endSec: 28 }],
  };
  const dead = checkShots({
    doc, outDir: '/tmp', id: 'x',
    narrationSpans: [{ startSec: 4, durationSec: 18.0 }],
  }).deadTime;
  assert.strictEqual(dead.narrationWorst, null,
    'no index means no line can be named, so no finding may be raised');
});

// ENG-6130: `bad` compares DEAD_TIME_SHARE against the RECOVERABLE share, and
// the constant's own declaration used to describe the quantity the gate read
// BEFORE this ticket — "the share of the runtime spent waiting". A threshold
// whose stated meaning is not the one it gates is how the next reader retunes
// it against the wrong number.
test('the dead-time threshold describes the quantity it actually gates', () => {
  const src = readFileSync(path.join(HERE, 'src', 'shot-check.js'), 'utf8');
  const decl = /((?:\/\/:[^\n]*\n)+)const DEAD_TIME_SHARE = /.exec(src);
  assert.ok(decl, 'could not find the DEAD_TIME_SHARE declaration comment');
  assert.match(decl[1], /NOT STRUCTURALLY PROTECT/i,
    'the comment must say the threshold gates unprotected wait, not total wait');
  // ...and must say the lever does not return all of it: the share is measured
  // on the already-compressed cut, so a speed bump gives back part (ENG-6149).
  assert.match(decl[1], /Not the same as .*pacing fix will return/i,
    'the comment must disclaim the stronger reading, not leave it open');
  assert.match(decl[1], /ENG-6149/, 'and point at the ticket that closes the gap');

  // And the gate really does compare the recoverable share, so the two agree.
  const gate = /bad: share > DEAD_TIME_SHARE/.exec(src);
  assert.ok(gate, 'the gate must key on `share`');
  assert.match(src, /const share = duration > 0 \? recoverable \/ duration : 0;/,
    '`share` must be the recoverable share for that comment to be true');
});

// ENG-6130: a missing narration record is NOT "no narration". finish.mjs writes
// the file on every run — including `[]` for the marketing genre — so absence
// means nobody recorded what the compressor was given, which happens when
// critique-take.mjs is run standalone (references/capture.md documents that).
// Measured as `[]`, the checker acts as though no speech protects anything and
// overclaims the recoverable share: the exact defect this ticket removes,
// returning as a silent default.
test('a missing narration record is unknown, not "nothing was spoken"', () => {
  const { checkShots } = require('../src/shot-check.js');
  const { deadTimePhrase } = require('../src/dead-time-phrase.js');
  const doc = {
    durationSec: 20,
    viewport: { width: 1280, height: 800 },
    actions: [
      { index: 0, type: 'click', startSec: 0, endSec: 1, clickSec: 0.5, clickX: 10, clickY: 10 },
      { index: 1, type: 'wait', startSec: 1, endSec: 17 },
    ],
  };
  const told = checkShots({ doc, outDir: '/tmp', id: 'x', narrationSpans: [] }).deadTime;
  const notTold = checkShots({ doc, outDir: '/tmp', id: 'x', narrationSpans: null }).deadTime;

  assert.strictEqual(told.narrationKnown, true, 'an explicit empty list IS a record: this take has no lines');
  assert.strictEqual(notTold.narrationKnown, false, 'no record is a third state, not an empty one');

  // The numbers are necessarily the same — that is precisely why the state has
  // to be carried rather than inferred from them.
  assert.strictEqual(told.recoverable, notTold.recoverable);

  // ...and the report must not present the figure as if it were backed.
  assert.doesNotMatch(deadTimePhrase(told, 20), /no narration record/);
  assert.match(deadTimePhrase(notTold, 20), /no narration record/,
    'a share measured without the record must say so, or it is an overclaim by default');
});


// ── ENG-6149: the recoverable figure is the achievable delta ────────────────
// `recoverable` was re-planned over the FINISHED cut, so it was the gap that
// survived this round's compression and every second of it was reported as
// reachable. The remedy is a re-cut from source at a higher speed, which
// returns only the difference between the two speeds. Measured on the fixture
// below: the surviving gap is 9.1s and the whole bump to the cap returns 5.2s.

//: The source timeline these tests compress, and the record finish.mjs writes.
function sourceFixture() {
  return {
    durationSec: 60,
    viewport: { width: 1280, height: 800 },
    actions: [{ type: 'wait', index: 0, startSec: 5, endSec: 50 }],
  };
}
//: Built by the SAME function finish.mjs writes with, so a renamed field fails
//: these tests instead of silently reading as "no record" in production.
function compressionRecord(speed) {
  const { planCompression, compressionFacts } = require('../src/compress.js');
  const plan = planCompression({ clip: sourceFixture(), narrationSpans: [], speed });
  return compressionFacts({ plan, compressed: { newDuration: plan.newDuration }, speed, clip: sourceFixture() });
}
//: The compressed cut the checker grades, with its wait rebased into final time.
function compressedDoc() {
  return {
    durationSec: 14.417,
    viewport: { width: 1280, height: 800 },
    actions: [{ type: 'wait', index: 0, startSec: 1.96, endSec: 10.79 }],
  };
}

test('recoverable is what a speed bump returns, not the gap that survived the cut', () => {
  const { checkShots } = require('../src/shot-check.js');
  const { planCompression, planFromKept } = require('../src/compress.js');

  // THE FIXTURE IS THE WORST CASE, asserted before it is measured. If the
  // surviving gap and the achievable delta were close, this test would pass
  // just as well against the bug it exists to catch.
  const at6 = planCompression({ clip: sourceFixture(), narrationSpans: [], speed: 6 });
  const at14 = planFromKept({ D: at6.D, kept: at6.kept, speed: 14 });
  const survived = at6.segments.filter((s) => s.speed !== 1).reduce((n, s) => n + s.newDur, 0);
  // Over the WAITS only, which is what the finding is about — the head gap and
  // the space between clicks are idle but are not the product thinking.
  const waits = sourceFixture().actions.filter((a) => a.type === 'wait').map((a) => [a.startSec, a.endSec]);
  const lap = (aS, aE, bS, bE) => Math.max(0, Math.min(aE, bE) - Math.max(aS, bS));
  const achievable = at6.segments.filter((x) => x.speed !== 1).reduce((n, seg) =>
    n + waits.reduce((m, [ws, we]) => m + lap(seg.oldStart, seg.oldEnd, ws, we), 0) * (1 / seg.speed - 1 / 14), 0);
  assert.ok(at14.newDuration < at6.newDuration, 'the cap must actually shorten this fixture');
  assert.ok(survived > achievable * 1.5,
    `fixture must make the two answers far apart, got survived=${survived} achievable=${achievable}`);

  const dead = checkShots({ doc: compressedDoc(), outDir: '/tmp', id: 'x', compression: compressionRecord(6) }).deadTime;
  assert.strictEqual(dead.compressionKnown, true);
  assert.ok(Math.abs(dead.recoverable - achievable) < 0.05,
    `recoverable must be the ${achievable.toFixed(2)}s a bump to the cap returns, got ${dead.recoverable}`);
  assert.ok(dead.recoverable < survived - 1,
    `and must NOT be the ${survived.toFixed(2)}s that merely survived this cut, got ${dead.recoverable}`);
});

test('at the speed cap nothing is recoverable, so dead time cannot fire', () => {
  const { checkShots } = require('../src/shot-check.js');
  // The loop has already bumped to 14x. There is no lever left, and a finding
  // whose remedy cannot move is the flat loop ENG-6130 closed — arriving here
  // through a figure measured against a speed the loop can no longer reach.
  const dead = checkShots({ doc: compressedDoc(), outDir: '/tmp', id: 'x', compression: compressionRecord(14) }).deadTime;
  assert.strictEqual(dead.compressionKnown, true);
  assert.ok(dead.recoverable < 0.01, `nothing is left at the cap, got ${dead.recoverable}`);
  assert.strictEqual(dead.bad, false, 'a finding with no reachable remedy must not fire');
});

test('a compression record without a cap is unknown, not a guessed ceiling', () => {
  const { checkShots } = require('../src/shot-check.js');
  // A `?? MAX_SPEED` default here would assert a ceiling this cut may never
  // have had, and would read as a measured answer.
  const record = compressionRecord(6);
  delete record.maxSpeed;
  const dead = checkShots({ doc: compressedDoc(), outDir: '/tmp', id: 'x', compression: record }).deadTime;
  assert.strictEqual(dead.compressionKnown, false,
    'without the cap the delta is unanswerable, and saying so beats defaulting');
});

test('a record with a malformed speed is unknown, not NaN', () => {
  // `Math.max(1.5, undefined)` is NaN, and NaN propagates through every segment
  // into `newDuration`, then into `recoverable` and `share`. The object is still
  // truthy, so `compressionKnown` read true, `bad` silently evaluated false, and
  // the report printed "NaN%" — a measured-looking answer to a question the
  // record could not support.
  const { checkShots } = require('../src/shot-check.js');
  for (const bad of [undefined, null, 'six', NaN]) {
    const record = { ...compressionRecord(6), speed: bad };
    const dead = checkShots({ doc: compressedDoc(), outDir: '/tmp', id: 'x', compression: record }).deadTime;
    assert.strictEqual(dead.compressionKnown, false, `speed ${String(bad)} must read as unknown`);
    assert.ok(Number.isFinite(dead.recoverable), `and never NaN, got ${dead.recoverable}`);
    assert.ok(Number.isFinite(dead.share), `nor a NaN share, got ${dead.share}`);
  }
});

test('a record with malformed waits is unknown, not NaN', () => {
  // `overlap` on a non-numeric pair yields NaN, which propagates into
  // `recoverable` and `share` while `compressionKnown` still reads true — the
  // report prints "NaN%" and `bad` silently evaluates false. Same failure the
  // speed guard closes, one field over.
  const { checkShots } = require('../src/shot-check.js');
  for (const waits of [[[0, 'x']], [[1]], [{ start: 0, end: 5 }], [null], [[0, NaN]]]) {
    const record = { ...compressionRecord(6), waits };
    const dead = checkShots({ doc: compressedDoc(), outDir: '/tmp', id: 'x', compression: record }).deadTime;
    assert.strictEqual(dead.compressionKnown, false, `waits ${JSON.stringify(waits)} must read as unknown`);
    assert.ok(Number.isFinite(dead.recoverable), `and never NaN, got ${dead.recoverable}`);
    assert.ok(Number.isFinite(dead.share), `nor a NaN share, got ${dead.share}`);
  }
});

test('the dead_time detail does not claim a full return on the fallback path', () => {
  // CALLS the builder. The first cut of this test grepped critique-take.mjs for
  // the condition — the vacuous shape this whole seam keeps being bitten by, and
  // one that would pass with the two branches' wording swapped.
  const { deadTimeDetail } = require('../src/dead-time-phrase.js');
  const known = deadTimeDetail({ share: 0.2, compressionKnown: true }, 14);
  assert.match(known, /the whole of it, up to the 14x cap/);
  assert.doesNotMatch(known, /survived this cut/);

  const unknown = deadTimeDetail({ share: 0.2, compressionKnown: false }, 14);
  assert.match(unknown, /survived this cut/,
    'without a record this is the surviving gap, not what a bump returns');
  assert.doesNotMatch(unknown, /the whole of it/,
    'and it must not claim the full amount is recoverable');
});

test('a record without the source waits is unknown, not measured over every gap', () => {
  // The delta over ALL idle gaps counts the head load gap and the space between
  // clicks — time no wait ever occupied. A 60s source whose only wait is fully
  // narration-protected reported 4.7s "recoverable" from gaps the wait never
  // touched, which is a dead_time finding about nothing.
  const { checkShots } = require('../src/shot-check.js');
  const record = compressionRecord(6);
  delete record.waits;
  const dead = checkShots({ doc: compressedDoc(), outDir: '/tmp', id: 'x', compression: record }).deadTime;
  assert.strictEqual(dead.compressionKnown, false);
});

test('a wait held entirely at 1x is not called recoverable', () => {
  // The case codex built: speeding returns none of this wait, because narration
  // protects all of it — but idle gaps elsewhere in the source made the
  // whole-timeline delta non-zero.
  const { checkShots } = require('../src/shot-check.js');
  const { planCompression, compressionFacts } = require('../src/compress.js');
  const src = {
    durationSec: 60,
    viewport: { width: 1280, height: 800 },
    actions: [
      { type: 'click', index: 0, startSec: 1, clickSec: 1.2, endSec: 1.5 },
      { type: 'wait', index: 1, startSec: 20, endSec: 25 },
      { type: 'click', index: 2, startSec: 55, clickSec: 55.2, endSec: 55.5 },
    ],
  };
  const spans = [{ startSec: 20, durationSec: 5, actionIndex: 1 }];
  const plan = planCompression({ clip: src, narrationSpans: spans, speed: 6 });
  // The fixture must really have compressible gaps OUTSIDE the wait, or it
  // cannot catch the bug.
  const spedOutside = plan.segments.filter((x) => x.speed !== 1)
    .reduce((n, x) => n + Math.max(0, Math.min(x.oldEnd, 20) - x.oldStart) + Math.max(0, x.oldEnd - Math.max(x.oldStart, 25)), 0);
  assert.ok(spedOutside > 10, `fixture needs sped gaps outside the wait, got ${spedOutside}`);

  const rec = compressionFacts({ plan, compressed: { newDuration: plan.newDuration }, speed: 6, clip: src });
  const doc = {
    durationSec: plan.newDuration,
    viewport: { width: 1280, height: 800 },
    actions: [{ type: 'wait', index: 1, startSec: 2, endSec: 7 }],
  };
  const dead = checkShots({ doc, outDir: '/tmp', id: 'x', narrationSpans: spans, compression: rec }).deadTime;
  assert.ok(dead.recoverable < 0.01,
    `a fully protected wait returns nothing to a speed bump, got ${dead.recoverable}`);
  assert.strictEqual(dead.bad, false);
});

test('a missing compression record is said out loud, not silently assumed', () => {
  const { checkShots } = require('../src/shot-check.js');
  const { deadTimePhrase } = require('../src/dead-time-phrase.js');
  const dead = checkShots({ doc: compressedDoc(), outDir: '/tmp', id: 'x' }).deadTime;
  assert.strictEqual(dead.compressionKnown, false);
  assert.match(deadTimePhrase(dead, 14.417), /no compression record/,
    'a share on the old basis must carry the caveat, or it is the overclaim by default');
  assert.doesNotMatch(deadTimePhrase({ ...dead, compressionKnown: true }, 14.417), /no compression record/);
});

test('the record finish.mjs writes is the record the checker can read', () => {
  // A ROUND TRIP, not a description of one. The writer and reader are separate
  // processes, so nothing else in the suite would notice a renamed field — the
  // reader's catch would swallow it and the checker would fall back to the old
  // basis while still printing a number.
  const { checkShots } = require('../src/shot-check.js');
  const { planCompression, compressionFacts } = require('../src/compress.js');
  const plan = planCompression({ clip: sourceFixture(), narrationSpans: [], speed: 6 });
  const onDisk = JSON.parse(JSON.stringify(
    compressionFacts({ plan, compressed: { newDuration: plan.newDuration }, speed: 6, clip: sourceFixture() })));

  const dead = checkShots({ doc: compressedDoc(), outDir: '/tmp', id: 'x', compression: onDisk }).deadTime;
  assert.strictEqual(dead.compressionKnown, true,
    'every field the checker needs must survive the JSON the writer emits');
});

test('a take with no lines never reports time held by narration', () => {
  // A CROSS-BASIS SUBTRACTION, caught on real output. `narrationHeld` is a plan
  // difference; when `recoverable` moved to the source-timeline delta and the
  // other term stayed on the finished-cut basis, the remainder stopped
  // measuring narration and started measuring the gap between the two bases —
  // 4.5s "held by narration" on a marketing take that speaks not one word.
  const { checkShots } = require('../src/shot-check.js');
  const dead = checkShots({
    doc: compressedDoc(), outDir: '/tmp', id: 'x',
    narrationSpans: [], compression: compressionRecord(6),
  }).deadTime;
  assert.strictEqual(dead.compressionKnown, true, 'the new basis must actually be in play');
  assert.strictEqual(dead.narrationHeld, 0,
    'nothing was spoken, so nothing can be held by speech');

  // And the sentence must not grow the clause either.
  const { deadTimePhrase } = require('../src/dead-time-phrase.js');
  assert.doesNotMatch(deadTimePhrase(dead, 14.417), /held by narration/);
});

test('a narration drop that wins is kept on disk', () => {
  // DRIVES THE REAL LOOP. The drop must survive to the end when the round that
  // dropped is the round that wins — otherwise the loop reports a cut it threw
  // away.
  const dir = tmp();
  const id = 'take';
  writeFileSync(path.join(dir, 'finish.mjs'), [
    "import { appendFileSync, writeFileSync } from 'node:fs';",
    "const [outDir, id] = process.argv.slice(2);",
    "writeFileSync(`${outDir}/${id}.moda.json`, JSON.stringify({ actions: [",
    "  { index: 0, type: 'click', clickX: 100, clickY: 100, clickSec: 1 } ] }));",
    "appendFileSync(`${outDir}/drops.log`, (process.env.DEMO_DROP_LINES ?? '') + '|' + process.env.DEMO_COMPRESS_SPEED + '\\n');",
  ].join('\n'));
  // Round 1 scores 5 with a narration finding; every later round scores 8 and is
  // clean, so the dropped cut wins outright.
  writeFileSync(path.join(dir, 'critique-take.mjs'), [
    "import { existsSync, readFileSync, writeFileSync } from 'node:fs';",
    "const [outDir] = process.argv.slice(2);",
    "const n = existsSync(`${outDir}/n.txt`) ? Number(readFileSync(`${outDir}/n.txt`,'utf8')) : 0;",
    "writeFileSync(`${outDir}/n.txt`, String(n + 1));",
    "const first = { score: 5, shots: [], issues: [{ stage: 'narration', severity: 'high',",
    "  type: 'narration_held', fix: 'shorten_narration', actionIndex: 4 }] };",
    "writeFileSync(`${outDir}/critique.json`, JSON.stringify(n === 0 ? first : { score: 8, shots: [], issues: [] }));",
  ].join('\n'));
  writeFileSync(path.join(dir, 'moda'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  writeFileSync(path.join(dir, 'compile.py'), 'import sys\nsys.exit(1)\n');
  writeFileSync(path.join(dir, `${id}.moda.json`), JSON.stringify({ actions: [] }));

  const res = spawnSync('node', [path.join(HERE, 'iterate.mjs'), dir, id, '--rounds', '3', '--target', '9'], {
    cwd: dir, encoding: 'utf8',
  });
  assert.strictEqual(res.status, 0, res.stderr);
  const drops = readFileSync(path.join(dir, 'drops.log'), 'utf8').trim().split('\n');
  assert.ok(drops[0].startsWith('4|'), `the re-cut must carry the named drop, got ${JSON.stringify(drops[0])}`);
  // NOT a speed bump: narration is not pacing.
  assert.ok(drops.every((d) => d.endsWith('|6')),
    `the compress speed must not move, got ${JSON.stringify(drops)}`);
  // The winning round HAD the drop, so the last word on disk must still have it.
  assert.ok(drops[drops.length - 1].split('|')[0].split(',').includes('4'),
    `the kept cut must retain the drop, got ${JSON.stringify(drops)}`);
  const kept = JSON.parse(readFileSync(path.join(dir, 'iterate.json'), 'utf8'));
  assert.strictEqual(kept.reconciled, true);
});

test('a narration drop that does not win is reverted on disk', () => {
  // THE ENG-6104 INVARIANT, over the new state. `droppedLines` changes the audio
  // on disk, so a snapshot that omits it lets the loop write
  // `keptRound: 1, reconciled: true` over a cut carrying a drop round 1 never
  // had — and because `refinish` re-sends the current set, even a speed-driven
  // restore could not have reconstructed it.
  const dir = tmp();
  const id = 'take';
  writeFileSync(path.join(dir, 'finish.mjs'), [
    "import { appendFileSync, writeFileSync } from 'node:fs';",
    "const [outDir, id] = process.argv.slice(2);",
    "writeFileSync(`${outDir}/${id}.moda.json`, JSON.stringify({ actions: [",
    "  { index: 0, type: 'click', clickX: 100, clickY: 100, clickSec: 1 } ] }));",
    // BRACKETED so an empty drop set is still a visible line — `.trim()` on the
    // log would otherwise swallow the reverted cut's entry entirely and the
    // revert would look like it never happened.
    "appendFileSync(`${outDir}/drops.log`, '[' + (process.env.DEMO_DROP_LINES ?? '') + ']' + '\\n');",
  ].join('\n'));
  // Round 1 scores 6 and is best. The drop makes round 2 score 4.
  writeFileSync(path.join(dir, 'critique-take.mjs'), [
    "import { existsSync, readFileSync, writeFileSync } from 'node:fs';",
    "const [outDir] = process.argv.slice(2);",
    "const n = existsSync(`${outDir}/n.txt`) ? Number(readFileSync(`${outDir}/n.txt`,'utf8')) : 0;",
    "writeFileSync(`${outDir}/n.txt`, String(n + 1));",
    "writeFileSync(`${outDir}/critique.json`, JSON.stringify({ score: n === 0 ? 6 : 4, shots: [],",
    "  issues: [{ stage: 'narration', severity: 'high', type: 'narration_held',",
    "             fix: 'shorten_narration', actionIndex: 4 }] }));",
  ].join('\n'));
  writeFileSync(path.join(dir, 'moda'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  writeFileSync(path.join(dir, 'compile.py'), 'import sys\nsys.exit(1)\n');
  writeFileSync(path.join(dir, `${id}.moda.json`), JSON.stringify({ actions: [] }));

  const res = spawnSync('node', [path.join(HERE, 'iterate.mjs'), dir, id, '--rounds', '3', '--target', '9'], {
    cwd: dir, encoding: 'utf8',
  });
  assert.strictEqual(res.status, 0, res.stderr);
  const kept = JSON.parse(readFileSync(path.join(dir, 'iterate.json'), 'utf8'));
  assert.strictEqual(kept.keptRound, 1, 'round 1 scored highest');
  assert.strictEqual(kept.reconciled, true);
  const drops = readFileSync(path.join(dir, 'drops.log'), 'utf8').trim().split('\n');
  assert.ok(drops.some((d) => d === '[4]'), 'the drop must actually have been applied first');
  assert.strictEqual(drops[drops.length - 1], '[]',
    `the reverted cut must carry no drops, got ${JSON.stringify(drops)}`);
});

test('dropping every line returns silence, and keeps the audio on disk', () => {
  // THE LAST DROP. `preVoiced?.length` treated "the narration stage dropped them
  // all" the same as "this take has no pre-voiced record", so the final drop
  // fell through to the synthesis path: fresh speak() calls for every action (a
  // second, metered TTS bill), sentences the recording was never paced to, and
  // an rmSync that deletes the cached mp3s the take WAS paced to. The requested
  // removal undid itself and destroyed the originals doing it.
  const { planNarration } = require('../src/narrate.js');
  const dir = tmp();
  // The cache the capture recorded, which must survive.
  mkdirSync(path.join(dir, 'vo'), { recursive: true });
  writeFileSync(path.join(dir, 'vo', '0.mp3'), 'recorded during capture');

  const clip = { durationSec: 10, actions: [{ type: 'click', startSec: 1, clickSec: 1, endSec: 2 }] };
  const planned = planNarration({ clip, outDir: dir, preVoiced: [], preVoicedConclusion: null });

  assert.ok(Array.isArray(planned), 'finish.mjs uses this as planned.length / planned.map');
  assert.strictEqual(planned.length, 0, 'every line was dropped, so nothing is spoken');
  assert.ok(existsSync(path.join(dir, 'vo', '0.mp3')),
    'the cached audio the take was paced to must not be deleted');
});

test('declining to compress leaves the source footage in the output', () => {
  // THROUGH THE REAL COMPRESSION PATH, with real files. `compressIdleGaps`
  // returns null when there is nothing worth speeding — correct on a first run,
  // where the output IS the recording. On a re-run the output still holds the
  // PREVIOUS cut, so every stage below would mux this run's timings onto footage
  // cut for a different plan. Reverting a narration drop reaches exactly that:
  // putting the line back protects more, so the re-cut declines, and the
  // rollback shipped a cut whose audio and video disagreed.
  const { ffmpeg: FFMPEG, ffprobe: FFPROBE } = require('../src/bin.js');
  const { compressIdleGaps } = require('../src/compress.js');
  const dir = tmp();
  const mp4 = path.join(dir, 'take.mp4');
  const source = path.join(dir, 'take.source.mp4');
  const mk = (out, secs) => execFileSync(FFMPEG, ['-v', 'error', '-y',
    '-f', 'lavfi', '-i', `testsrc=duration=${secs}:size=160x120:rate=10`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', out]);
  mk(source, 12);
  mk(mp4, 4);            // the previous run's shorter cut
  const dur = (f) => Number(execFileSync(FFPROBE, ['-v', 'error', '-show_entries',
    'format=duration', '-of', 'default=nw=1:nk=1', f]).toString().trim());
  assert.ok(Math.abs(dur(mp4) - 4) < 0.5, 'the fixture must start with the shorter cut in place');

  // A clip whose whole span is protected by narration: nothing to speed.
  const clip = { durationSec: 12, actions: [{ type: 'wait', index: 0, startSec: 0, endSec: 12 }] };
  const out = compressIdleGaps({
    mp4Path: mp4, sourcePath: source, clip,
    narrationSpans: [{ startSec: 0, durationSec: 12 }], speed: 6,
  });
  assert.strictEqual(out, null, 'the fixture must actually decline to compress');
  assert.ok(Math.abs(dur(mp4) - 12) < 0.5,
    `the output must hold the 12s source, not the 4s previous cut — got ${dur(mp4)}s`);
});

test('a scriptless take names no line, because the drop cannot reach it', () => {
  // The synthesis branch stamps an `actionIndex` too, but `DEMO_DROP_LINES`
  // filters `pacing.spoken` — which this take does not have — so the drop is
  // inert and the whole script is re-synthesized regardless. Naming a line
  // anyway buys a metered re-cut for a remedy that cannot move.
  const { narrationRecord } = require('../src/narrate.js');
  const planned = [{ startSec: 1, durationSec: 2, actionIndex: 0 },
                   { startSec: 4, durationSec: 3, actionIndex: 1 }];

  const scriptless = narrationRecord(planned, null);
  assert.deepStrictEqual(scriptless.map((l) => l.actionIndex), [null, null],
    'no pre-voiced record means no nameable line');
  // The spans themselves must still be recorded — the compressor was told about
  // them, and dropping that would overclaim the recoverable wait.
  assert.deepStrictEqual(scriptless.map((l) => l.durationSec), [2, 3]);

  const preVoiced = narrationRecord(planned, [{ index: 0 }, { index: 1 }]);
  assert.deepStrictEqual(preVoiced.map((l) => l.actionIndex), [0, 1],
    'a pre-voiced take is where the lever works, so there the line is named');
});

test('per-line narration attribution is unmoved by the compression basis', () => {
  // THE SEAM BETWEEN THE TWO TICKETS. ENG-6149 made `recoverable` a
  // source-timeline delta while `narrationHeld` stayed a finished-cut plan
  // difference; subtracting one from the other made the remainder measure the
  // basis gap instead of the narration, and reported seconds "held by
  // narration" on a take with no lines. The per-line figures are the same
  // subtraction done once per span, so they inherit the bug unless they are
  // also on `residual` — and neither ticket's own tests exercise the two
  // together.
  const { checkShots } = require('../src/shot-check.js');
  const { planCompression, compressionFacts } = require('../src/compress.js');
  const src = {
    durationSec: 60, viewport: { width: 1280, height: 800 },
    actions: [{ type: 'wait', index: 0, startSec: 2, endSec: 55 }],
  };
  const spans = [
    { startSec: 4, durationSec: 1.0, actionIndex: 0 },
    { startSec: 8, durationSec: 20.0, actionIndex: 4 },
  ];
  const plan = planCompression({ clip: src, narrationSpans: spans, speed: 6 });
  const rec = compressionFacts({ plan, compressed: { newDuration: plan.newDuration }, speed: 6, clip: src });
  const doc = {
    durationSec: 30, viewport: { width: 1280, height: 800 },
    actions: [{ type: 'wait', index: 0, startSec: 2, endSec: 28 }],
  };

  const without = checkShots({ doc, outDir: '/tmp', id: 'x', narrationSpans: spans }).deadTime;
  const with_ = checkShots({ doc, outDir: '/tmp', id: 'x', narrationSpans: spans, compression: rec }).deadTime;
  // The record must actually be in play, or this compares two identical runs.
  assert.strictEqual(without.compressionKnown, false);
  assert.strictEqual(with_.compressionKnown, true);
  assert.ok(with_.recoverable !== without.recoverable, 'the basis must really have changed');

  assert.strictEqual(with_.narrationWorst.actionIndex, without.narrationWorst.actionIndex,
    'which line holds the wait is a property of the cut, not of the compression record');
  assert.ok(Math.abs(with_.narrationWorst.heldSec - without.narrationWorst.heldSec) < 0.01,
    `and so is how much it holds — got ${with_.narrationWorst.heldSec} vs ${without.narrationWorst.heldSec}`);
});
