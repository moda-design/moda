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

const { keptReport, nextStep, canSelect, betterTake, CONTRADICTION_FINDING,
  TRUTH_OVER_POLISH } = require('../src/kept-report.js');

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
  // THROUGH THE RESOLVER, like every other ffmpeg test here. Shelling bare
  // `ffmpeg` made the bundled ffmpeg-static invisible to this test alone, so on
  // a machine set up the way the package intends — plain `npm install`, the
  // bundled binary downloaded, no system ffmpeg on PATH — it skipped while the
  // rest of the suite ran happily against that binary. That is the same "a skip
  // is not a pass" hole this guard exists to close, just moved from CI onto
  // laptops, where nothing ever surfaces it.
  //
  // The hard failure keys on the RESOLVER's verdict rather than a PATH probe:
  // missing means neither bundled nor PATH has one. CI is unchanged — with
  // --ignore-scripts the bundled binary never downloads, so the resolver falls
  // through to the apt-installed PATH copy, and DEMO_CAPTURE_REQUIRE_FFMPEG
  // still turns a removed apt step into a loud failure.
  const { ffmpeg: FFMPEG_BIN, report: BIN_REPORT } = require('../src/bin.js');
  const run = (args) => spawnSync(FFMPEG_BIN, args, { encoding: 'utf8' });
  if (BIN_REPORT.ffmpeg.from === 'missing') {
    if (process.env.DEMO_CAPTURE_REQUIRE_FFMPEG === '1') {
      throw new Error('ffmpeg is required here (DEMO_CAPTURE_REQUIRE_FFMPEG=1) but the resolver found '
        + 'neither a bundled nor a PATH copy — the CI install step was removed or failed, and this '
        + 'test would otherwise skip silently');
    }
    return t.skip('ffmpeg not available (neither bundled nor on PATH)');
  }
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
  assert.match(assignments[0], /betterTake\(/,
    'the selection assignment must go through betterTake, not an inline predicate');

  // AND the refusal must survive inside it. `betterTake` absorbed `canSelect`
  // when the contradiction became a tie-break, so the guard has to follow it
  // there: asserting only the call site would let the predicate quietly stop
  // refusing an unreconciled report while this test still passed.
  const kr = readFileSync(path.join(HERE, 'src', 'kept-report.js'), 'utf8');
  const body = kr.slice(kr.indexOf('function betterTake('));
  assert.match(body.slice(0, body.indexOf('\n}')), /if \(!canSelect\(candidate\)\) return false;/,
    'betterTake must refuse anything canSelect refuses, before any comparison');
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

  // ...and BEFORE every stage that costs anything: the editorial pass is a
  // model call and curation's walk is a headless browser plus up to four
  // restore-and-rewalk passes. Nothing about this check depends on either.
  //
  // Asserted against BOTH markers rather than whichever happens to come first,
  // because the list of expensive stages has grown once already — ENG-5766 put
  // `editing` in front of `curating`, and a check pinned only to the old first
  // stage would have gone on passing while an abandoned walk paid for a model
  // call it never used to.
  for (const stage of ['[2] editing', '[3] curating']) {
    assert.ok(src.includes(stage), `run.mjs should still have a ${stage} stage`);
    assert.ok(src.indexOf('walk_unfinished') < src.indexOf(stage),
      `the walk check must run before ${stage}, or an abandoned walk still pays for it`);
  }
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
// (a wait whose result lands in the closing beat is held by it instead of
// keeping its own — ENG-6210)
// and any residual gap under MIN_GAP_SEC that buildSegments leaves alone —
// with one carve-out since: the middle of a fill longer than
// TYPING_MIN_COMPRESSIBLE is NOT protected (ENG-6195).
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

test('every script in this directory actually parses', () => {
  // A CONFLICT MARKER SHIPPED TO MAIN in critique-take.mjs and nothing noticed:
  // the entry-point .mjs files are spawned as subprocesses, never imported by a
  // test, and nothing in this tree is linted. The suite stayed green while the
  // critique stage was dead on arrival — every run failed with
  // `SyntaxError: Unexpected token '<<'` after the video had already been
  // recorded and scored, which is the most expensive possible place to fail.
  //
  // Parses the WHOLE directory rather than a hand-listed set, because a list
  // that has to be kept in step with the filesystem is the thing that let this
  // through — critique-take.mjs was simply not on anybody's list.
  const { readdirSync } = require('node:fs');
  const dir = HERE;
  const scripts = readdirSync(dir).filter((f) => /\.(mjs|js)$/.test(f));
  const srcDir = path.join(dir, 'src');
  const all = [
    ...scripts.map((f) => path.join(dir, f)),
    ...readdirSync(srcDir).filter((f) => f.endsWith('.js')).map((f) => path.join(srcDir, f)),
  ];
  assert.ok(all.length > 20, `expected the whole tree, found ${all.length} file(s)`);

  const broken = [];
  for (const f of all) {
    const res = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
    if (res.status !== 0) broken.push(`${path.relative(dir, f)}: ${String(res.stderr).split('\n')[0]}`);
  }
  assert.deepStrictEqual(broken, [], `these do not parse:\n${broken.join('\n')}`);
});

// ── ENG-6195: typing is a transport, not a beat ────────────────────────────

test('a long fill has its middle sped, keeping the head and the tail', () => {
  const { planCompression } = require('../src/compress.js');
  // THE SHAPE THE RECORDER EMITS. A real fill carries moveStartSec/arrivalSec/
  // clickSec; omitting them collapses `start` and `click` onto startSec, which
  // is the one case where anchoring the head at `start` happens to be correct —
  // so a fixture without them cannot see the anchor at all.
  const clip = {
    durationSec: 30,
    actions: [{
      type: 'fill', index: 0,
      startSec: 2, moveStartSec: 2, arrivalSec: 3.3, clickSec: 3.6,
      clickX: 778, clickY: 204, endSec: 18,
    }],
  };
  const plan = planCompression({ clip, narrationSpans: [], speed: 6 });
  const sped = plan.segments.filter((s) => s.speed !== 1);
  assert.ok(sped.length > 0, 'a 16s fill must not be immune to the only lever the loop has');

  // The head is where the viewer sees typing begin; the tail is the finished
  // prompt, which has to stay legible before it is sent. Measured as OVERLAP
  // with each region — a `oldStart <` test also catches the sped gap that sits
  // before the fill begins, and would fail for a reason unrelated to typing.
  const lap = (aS, aE, bS, bE) => Math.max(0, Math.min(aE, bE) - Math.max(aS, bS));
  // The first second AFTER THE CLICK — where typing actually begins. Anchoring
  // on startSec instead spends the whole budget on the cursor glide and expires
  // just as the first characters appear.
  const inHead = sped.reduce((n, s) => n + lap(s.oldStart, s.oldEnd, 3.6, 4.6), 0);
  const inGlide = sped.reduce((n, s) => n + lap(s.oldStart, s.oldEnd, 2, 3.6), 0);
  const inTail = sped.reduce((n, s) => n + lap(s.oldStart, s.oldEnd, 17, 18), 0);
  assert.strictEqual(inHead, 0, 'the first second of TYPING must stay at 1x');
  assert.strictEqual(inGlide, 0, 'and the cursor glide with it — the pointer is visible while it moves');
  assert.strictEqual(inTail, 0, 'the completed prompt must stay at 1x');

  // And the middle really is the part that moved.
  const spedInside = sped.reduce((n, s) =>
    n + Math.max(0, Math.min(s.oldEnd, 18) - Math.max(s.oldStart, 2)), 0);
  assert.ok(spedInside > 10, `most of the 16s fill should be sped, got ${spedInside.toFixed(1)}s`);
});

test('a short fill is left alone, because it is already a beat', () => {
  // Splitting a brief fill just stutters — the same reason MIN_GAP_SEC exists.
  const { planCompression } = require('../src/compress.js');
  // Measured on the TYPING span, not the whole action: a 1.2s fill behind a
  // 1.6s glide is 2.8s end-to-end and would cross a threshold measured from
  // `start`, splitting exactly the beat the threshold exists to protect.
  const clip = {
    durationSec: 30,
    actions: [{
      type: 'fill', index: 0,
      startSec: 2, moveStartSec: 2, arrivalSec: 3.3, clickSec: 3.6, endSec: 4.8,
    }],
  };
  const plan = planCompression({ clip, narrationSpans: [], speed: 6 });
  const spedInside = plan.segments.filter((s) => s.speed !== 1).reduce((n, s) =>
    n + Math.max(0, Math.min(s.oldEnd, 4.8) - Math.max(s.oldStart, 2)), 0);
  assert.strictEqual(spedInside, 0, 'a 1.2s typing span must be untouched');
});

test('a click is still protected for its whole span', () => {
  // The change is scoped to typing. A click is a discrete beat — speeding
  // through one loses the moment the viewer is meant to register.
  const { planCompression } = require('../src/compress.js');
  const clip = {
    durationSec: 30,
    actions: [{ type: 'click', index: 0, startSec: 2, clickSec: 2.5, endSec: 18 }],
  };
  const plan = planCompression({ clip, narrationSpans: [], speed: 6 });
  const spedInside = plan.segments.filter((s) => s.speed !== 1).reduce((n, s) =>
    n + Math.max(0, Math.min(s.oldEnd, 18) - Math.max(s.oldStart, 2)), 0);
  assert.strictEqual(spedInside, 0, 'only fills were opened up, not every action');
});

test('the real take that motivated this gets materially shorter', () => {
  // THE ARTIFACT'S OWN NUMBERS, copied from sample-browserless-a1's
  // timeline.source.json — including moveStartSec/arrivalSec/clickSec, which
  // the recorder stamps on every fill and which the first cut of this test
  // omitted. That omission collapsed `click` onto `startSec` and let the test
  // claim ~11.7s of saving where the code delivers 10.1s: it asserted a number
  // the artifact never gets, under a comment saying it was measured on one.
  const { planCompression } = require('../src/compress.js');
  const clip = {
    durationSec: 104.334,
    actions: [
      { type: 'click', index: 0, moveStartSec: 0.9, arrivalSec: 1.638, clickSec: 1.939, startSec: 0.87, endSec: 3.654 },
      { type: 'fill', index: 1, moveStartSec: 4.253, arrivalSec: 4.981, clickSec: 5.282, startSec: 3.654, endSec: 17.75 },
      { type: 'click', index: 2, moveStartSec: 17.789, arrivalSec: 18.506, clickSec: 18.808, startSec: 17.75, endSec: 20.03 },
      { type: 'wait', index: 3, startSec: 20.03, endSec: 25.652 },
      { type: 'wait', index: 4, startSec: 25.652, endSec: 29.801 },
      { type: 'wait', index: 5, startSec: 29.801, endSec: 94.718 },
      { type: 'wait', index: 6, startSec: 94.718, endSec: 98.876 },
      { type: 'wait', index: 7, startSec: 98.876, endSec: 102.612 },
    ],
  };
  const fill = clip.actions[1];
  // The fill ACTION is 14.1s, but only 12.5s of it is typing — the rest is the
  // cursor glide. Sizing the win against the action span overstates it.
  const typing = fill.endSec - fill.clickSec;
  assert.ok(typing > 12 && typing < 13, `fixture must carry the real typing span, got ${typing.toFixed(2)}s`);
  assert.ok(fill.clickSec - fill.moveStartSec > 1, 'and the real ~1s glide, which is what broke the first anchor');

  const plan = planCompression({ clip, narrationSpans: [], speed: 6 });
  const lap = (aS, aE, bS, bE) => Math.max(0, Math.min(aE, bE) - Math.max(aS, bS));
  const sped = plan.segments.filter((s) => s.speed !== 1);
  const spedTyping = sped.reduce((n, s) => n + lap(s.oldStart, s.oldEnd, fill.clickSec, fill.endSec), 0);
  assert.ok(spedTyping > 10,
    `the bulk of the ${typing.toFixed(1)}s typing span must be reachable, got ${spedTyping.toFixed(2)}s`);

  // And the readable first second survives, on the take whose 1.03s glide is
  // exactly what the old anchor spent its whole budget on.
  const firstSecond = sped.reduce((n, s) => n + lap(s.oldStart, s.oldEnd, fill.clickSec, fill.clickSec + 1), 0);
  assert.strictEqual(firstSecond, 0, 'the first second of typing must survive on the real shape too');
});

test('a wait whose result lands in the closing beat is held once, not twice', () => {
  // TWO HOLDS ON ONE MOMENT (ENG-6210). The closing TAIL_KEEP beat and the last
  // wait's WAIT_RESULT_KEEP both hold the payoff. When the footage runs on past
  // the last action they only partly overlap, so their union is longer than
  // either — on the take that motivated this, 3.27s, which nobody chose. And a
  // 1x region does not shrink when the loop raises the speed, so its share of
  // the cut GROWS every pacing round: 17% at 6x, 22% at 12x.
  const { planCompression } = require('../src/compress.js');
  // The real shape: the last wait ends 1.67s before the footage does.
  const clip = {
    durationSec: 68,
    actions: [
      { type: 'fill', index: 0, startSec: 0.88, moveStartSec: 0.9, clickSec: 1.92, endSec: 10.45 },
      { type: 'click', index: 1, startSec: 10.45, clickSec: 11.52, endSec: 12.66 },
      { type: 'wait', index: 2, startSec: 12.66, endSec: 66.33 },
    ],
  };
  const plan = planCompression({ clip, narrationSpans: [], speed: 6 });
  const last = plan.kept[plan.kept.length - 1];
  const hold = last[1] - last[0];

  // The fixture must actually carry the overlap, or it proves nothing.
  assert.ok(68 - 66.33 > 1 && 68 - 66.33 < 2.0,
    'the wait must end inside the tail beat but not at the clip end');
  assert.ok(Math.abs(hold - 2.0) < 0.01,
    `the payoff is one 2.0s beat, not the union of two — got ${hold.toFixed(2)}s`);
  assert.ok(Math.abs(last[1] - 68) < 0.01, 'and it ends with the footage');
});

test('a wait that ends well before the footage keeps its own result hold', () => {
  // The collapse is scoped to a wait landing INSIDE the closing beat. A wait
  // that finishes earlier still needs its own hold — that is where its result
  // appears, and the tail beat is nowhere near it.
  const { planCompression } = require('../src/compress.js');
  const clip = {
    durationSec: 60,
    actions: [
      { type: 'wait', index: 0, startSec: 2, endSec: 30 },
      { type: 'click', index: 1, startSec: 45, clickSec: 45.5, endSec: 47 },
    ],
  };
  const plan = planCompression({ clip, narrationSpans: [], speed: 6 });
  const coversWaitEnd = plan.kept.some(([a, b]) => a <= 30 && b >= 29.9);
  assert.ok(coversWaitEnd,
    `a wait ending at 30s on a 60s clip must keep its own result hold, got ${JSON.stringify(plan.kept)}`);
});

test('the closing beat stays one hold on BOTH sides of its edge', () => {
  // THE DEFECT IS CONTINUOUS, THE FIRST GATE WAS NOT. Gating on "does the wait
  // end inside the closing beat" left a MIN_GAP_SEC-wide window just outside
  // it where the result-keep, a sub-MIN_GAP gap that buildSegments leaves at
  // 1x, and the tail beat form ONE contiguous static run — 3.61s at 65.99 and
  // 4.00s at 65.60 on this shape, both worse than the 3.27s that motivated the
  // fix. Swept rather than spot-checked, because a cliff is exactly what a
  // spot-check at a round number misses.
  const { planCompression } = require('../src/compress.js');
  const D = 68;
  const clipEndingAt = (waitEnd) => ({
    durationSec: D,
    actions: [
      { type: 'fill', index: 0, startSec: 0.88, moveStartSec: 0.9, clickSec: 1.92, endSec: 10.45 },
      { type: 'click', index: 1, startSec: 10.45, clickSec: 11.52, endSec: 12.66 },
      { type: 'wait', index: 2, startSec: 12.66, endSec: waitEnd },
    ],
  });
  //: PERCEPTUAL, not strictly contiguous. The first version of this metric
  //: broke the run on ANY fast segment, so a 67ms sped blip between two holds
  //: read as two short runs — it reported 2.00s where the viewer sat through
  //: 4.19s of frozen ending, and the sweep passed while the cliff had only
  //: moved. A cut too brief to register as motion does not separate two holds.
  const PERCEPTIBLE = 0.25;
  const closingRun = (plan) => {
    let t = 0; const runs = [];
    for (const s of plan.segments) {
      const d = (s.oldEnd - s.oldStart) / s.speed;
      if (s.speed === 1 || d < PERCEPTIBLE) {
        const prev = runs[runs.length - 1];
        if (prev && Math.abs(prev[1] - t) < 1e-6) prev[1] = t + d;
        else runs.push([t, t + d]);
      }
      t += d;
    }
    const r = runs[runs.length - 1];
    return r[1] - r[0];
  };

  // THE REGION THE GATE GOVERNS, at every speed the loop uses. A global sweep
  // cannot pin this: the residual window further out measures 4.20s and the
  // edge cliff measured 4.25s, so one bound over the whole range would pass
  // with the bug back. This asserts the claim the fix actually makes — no
  // cliff at the beat's edge — and the second assertion pins the residual so
  // that widening or worsening it shows up as a change rather than as noise.
  const D_MIN = 68 - 2.0 - 0.7;   // D - TAIL_KEEP - MIN_GAP_SEC
  let worst = 0; let worstAt = null;
  for (const speed of [6, 9, 12, 14]) {
    for (let we = D_MIN; we <= 67.9; we += 0.05) {
      const run = closingRun(planCompression({ clip: clipEndingAt(+we.toFixed(2)), narrationSpans: [], speed }));
      if (run > worst) { worst = run; worstAt = `${we.toFixed(2)} @${speed}x`; }
    }
  }
  assert.ok(worst < 2.05,
    `inside the gate's window no wait-end at any speed may leave a hold longer than the beat — `
    + `worst ${worst.toFixed(2)}s at waitEnd=${worstAt}`);

  // KNOWN AND LEFT: further out the hold, its lead-in and a brief sped gap can
  // still read as one block. ~4.2s, worst at the cap. Closing it needs a
  // MAX_SPEED-sized window that swallows a short take's result holds entirely
  // (it broke two ENG-6130 guards when tried), so it is recorded on ENG-6210
  // rather than fixed. Pinned so it cannot quietly get worse.
  let residual = 0;
  for (const speed of [6, 9, 12, 14]) {
    for (let we = 50.0; we < D_MIN; we += 0.05) {
      const run = closingRun(planCompression({ clip: clipEndingAt(+we.toFixed(2)), narrationSpans: [], speed }));
      if (run > residual) residual = run;
    }
  }
  assert.ok(residual < 4.5,
    `the known residual window must not grow — was ~4.2s, got ${residual.toFixed(2)}s`);
});

test('a wait with an action after it keeps its own result hold', () => {
  // SCOPED TO THE LAST ACTION. "The closing beat already holds this result" is
  // only true when nothing after the wait changes the screen. With a click
  // after it, the tail beat holds the POST-CLICK state and the wait's arrival
  // falls inside the sped gap — dropping the hold there speeds past the exact
  // payoff WAIT_RESULT_KEEP exists to protect, which would be a regression
  // rather than a fix.
  const { planCompression } = require('../src/compress.js');
  const clip = {
    durationSec: 68,
    actions: [
      { type: 'fill', index: 0, startSec: 0.88, moveStartSec: 0.9, clickSec: 1.92, endSec: 10.45 },
      { type: 'wait', index: 1, startSec: 12.66, endSec: 65.4 },
      { type: 'click', index: 2, startSec: 65.6, clickSec: 65.9, endSec: 66.2 },
    ],
  };
  const plan = planCompression({ clip, narrationSpans: [], speed: 6 });
  // The fixture must put the wait inside the window, or it proves nothing.
  assert.ok(65.4 >= 68 - 2.0 - 5.45, 'the wait must land where a LAST wait would be collapsed');
  assert.ok(plan.kept.some(([a, b]) => a <= 65.4 && b >= 65.35),
    `the arrival must stay at 1x when something follows it, got ${JSON.stringify(plan.kept)}`);
});

// ── ENG-6295: the grader must be told what the take actually contains ───────

test('a marketing take is not told to expect captions it deliberately has none of', () => {
  // THE BUG WAS THE PROMPT TEXT. It asserted "The video is a screen recording
  // with on-screen step captions … a synthesized voiceover … and no music" on
  // EVERY take. A marketing take is the opposite of all three: music bed, no
  // captions, no voiceover — finish.mjs blanks every label on purpose. So the
  // grader hunted for captions, found none, and reported their absence as a
  // medium finding with `fix: none`, which run.mjs then fed into the next
  // discovery pass as something to fix by re-walking the flow.
  //
  // The prompt already learned this once, for intro/outro cards; its own
  // comment says a model told to expect something absent reports it as a
  // defect. This is that lesson applied to the rest of the sentence.
  const { buildPrompt, sheetPrompt } = require('../src/critique.js');
  const video = buildPrompt('design a launch post', 'marketing', true, false, false);
  const frames = sheetPrompt('design a launch post', 20, '/tmp/sheet.png', 1.6, 'marketing', false);

  assert.match(video, /NO on-screen captions/, 'the video prompt must say captions are absent by design');
  assert.match(video, /a music bed/, 'and name the bed when there is one — the old text denied it');
  assert.doesNotMatch(video, /captions that are unreadable/,
    'and must not ask about caption readability on a take with no captions');
  assert.doesNotMatch(frames, /Are captions readable/,
    'same for the frame-sheet rubric');
});

test('a tutorial take still gets the caption checks', () => {
  // The fix is to make the question match the genre, not to stop asking it. An
  // unreadable or overlapping caption is a real defect on a tutorial take, and
  // caption_unreadable / caption_overlap exist in the vocabulary for it.
  const { buildPrompt, sheetPrompt } = require('../src/critique.js');
  const video = buildPrompt('design a launch post', 'tutorial', true, true, false);
  const frames = sheetPrompt('design a launch post', 20, '/tmp/sheet.png', 1.6, 'tutorial', true);

  assert.match(video, /on-screen step captions/);
  assert.match(video, /captions that are unreadable/);
  assert.match(frames, /Are captions readable/);
});

test('an unknown genre grades as a tutorial rather than guessing', () => {
  // `genre.json` missing means UNKNOWN, not "marketing". Falling back to the
  // marketing wording would tell the grader to ignore captions on a take that
  // has them — the same class of false premise, pointing the other way.
  const { buildPrompt } = require('../src/critique.js');
  const unknown = buildPrompt('design a launch post', null, true, true, false);
  assert.match(unknown, /on-screen step captions/, 'unknown falls back to what the prompt always said');
  assert.match(unknown, /captions that are unreadable/);
});

test('a caller that forgets the genre fails loudly instead of regrading silently', () => {
  // THE WIRING, not the wording. Removing `genre` from critique-take.mjs's call
  // sites left every test green: the builders defaulted to null, produced the
  // tutorial wording, and every marketing take quietly went back to being
  // marked down for absent captions. An omitted argument looked exactly like a
  // valid one.
  //
  // `null` stays meaningful — genre.json absent, grade as a tutorial. Only
  // `undefined` throws.
  const { buildPrompt, sheetPrompt } = require('../src/critique.js');
  assert.throws(() => buildPrompt('goal'), /genre must be passed explicitly/);
  assert.throws(() => sheetPrompt('goal', 20, '/tmp/s.png', 1.6), /genre must be passed explicitly/);
  assert.doesNotThrow(() => buildPrompt('goal', null, true, true, false), 'null is a real answer, not an omission');
});

test('a marketing take is not asked about a voiceover it never has', () => {
  // THE SAME BUG, IN THE BULLET BELOW THE ONE I FIXED. finish.mjs sets
  // `planned = []` for marketing, so nothing is narrated or muxed — yet the
  // rubric still asked "does the voiceover match what is on screen", with
  // narration_mismatch in the vocabulary and shorten_narration in FIXES. The
  // prompt said NO voiceover and then asked the grader to judge it.
  const { buildPrompt } = require('../src/critique.js');
  assert.doesNotMatch(buildPrompt('g', 'marketing', true, false, false), /does the voiceover match/);
  assert.match(buildPrompt('g', 'tutorial', true, true, false), /does the voiceover match/);
});

test('the music claim follows the take, in both directions', () => {
  // THIS TEST PREVIOUSLY ASSERTED THE BUG. It required every prompt to claim a
  // music bed, because the old text denied one on every take and I over-
  // corrected. Both blanket claims are wrong: finish.mjs skips the bed under
  // DEMO_NO_MUSIC=1 and its generateBed call is a metered render inside a
  // try/catch that logs "scored: skipped" on failure. Asserting music that is
  // not there is the same false premise as denying music that is — and worse
  // on a marketing take, where the bed is the only audio at all.
  const { buildPrompt } = require('../src/critique.js');
  for (const genre of ['marketing', 'tutorial', null]) {
    const withMusic = buildPrompt('g', genre, true, genre !== 'marketing', false);
    const without = buildPrompt('g', genre, false, genre !== 'marketing', false);
    assert.match(withMusic, /a music bed/, `${genre ?? 'unknown'}: names the bed when present`);
    assert.doesNotMatch(withMusic, /no music/, `${genre ?? 'unknown'}: does not also deny it`);
    // Absent, it must SUPPRESS rather than stay silent — a bare omission lets
    // the grader notice missing audio and report it.
    assert.match(without, /no music \(do not report its absence\)/,
      `${genre ?? 'unknown'}: says so, and suppresses the finding, when there is none`);
  }
});

test('the genre guard fires at the entry point, not deep inside a try', () => {
  // critiqueFrames calls sheetPrompt INSIDE its try, so a dropped argument
  // became {ok:false, reason:...} and critique-take printed "critique
  // unavailable" and carried on — a silently degraded critique, which is the
  // failure the guard exists to prevent. Asserting through the builders alone
  // could not see that.
  const { critiqueFrames, critiqueVideo } = require('../src/critique.js');
  return Promise.all([
    assert.rejects(() => critiqueFrames({ videoPath: '/tmp/x.mp4', goal: 'g', outDir: '/tmp' }),
      /genre must be passed explicitly/),
    assert.rejects(() => critiqueVideo({ videoPath: '/tmp/x.mp4', goal: 'g' }),
      /genre must be passed explicitly/),
  ]);
});

test('finish.mjs records a genre it chose itself', () => {
  // When genre.json is absent finish picks one via chooseStyle and builds the
  // cut for it. If it does not write that down, critique-take finds no
  // genre.json, grades as a tutorial, and marks the take down for captions
  // finish deliberately blanked — this ticket's bug on the fallback path.
  const src = readFileSync(path.join(HERE, 'finish.mjs'), 'utf8');
  // ABSENT **OR DISAGREEING**. Persisting only when absent left DEMO_STYLE
  // overriding an existing genre: the cut was built for the override while
  // genre.json kept naming the old one, so critique graded a marketing cut as
  // a tutorial — this ticket's bug, recreated by the previous round's fix.
  const block = /if \(!recordedGenre \|\| recordedGenre\.style !== STYLE\) \{[\s\S]*?\n\}/.exec(src);
  assert.ok(block, 'finish.mjs must persist whenever the record disagrees with the cut');
  assert.match(block[0], /genre\.json/, 'and write it where critique-take reads it');
  assert.match(block[0], /style: STYLE/, 'in the shape take.mjs writes');
});

test('a marketing prompt offers no vocabulary for findings it cannot own', () => {
  // The bullets were gated by genre and the ENUMS were not. If the model
  // reaches for one of these anyway, the finding arrives with a remedy the cut
  // cannot apply: fix_caption_overlap is not in run.mjs's cheap-lane exclusion
  // list, so a medium one becomes a flow finding and a re-walk, and
  // shorten_narration routes to a narration stage whose `planned` is empty.
  // Take the token away rather than hoping it goes unused.
  const { buildPrompt, sheetPrompt } = require('../src/critique.js');
  const m = buildPrompt('g', 'marketing', true, false, false);
  const mf = sheetPrompt('g', 20, '/tmp/s.png', 1.6, 'marketing', false);
  const t = buildPrompt('g', 'tutorial', true, true, false);

  for (const tok of ['narration_mismatch', 'caption_overlap', 'caption_unreadable',
                     'shorten_narration', 'fix_caption_overlap']) {
    assert.ok(!m.includes(tok), `marketing video prompt must not offer ${tok}`);
    assert.ok(!mf.includes(tok), `marketing frames prompt must not offer ${tok}`);
    assert.ok(t.includes(tok), `tutorial prompt must still offer ${tok}`);
  }
  // The shared vocabulary survives on both.
  for (const tok of ['visual_glitch', 'blank_screen', 're_record', 'none']) {
    assert.ok(m.includes(tok) && t.includes(tok), `${tok} belongs to both genres`);
  }
});

test('critiqueVideo returns the {ok} contract its caller gates on', () => {
  // PRE-EXISTING, and it nullified the Gemini path entirely: critiqueFrames has
  // always returned {ok:true,via}, critiqueVideo returned {score,summary,issues}
  // with no `ok`, and critique-take gates on `if (!verdict.ok)`. So a SUCCESSFUL
  // Gemini critique printed "critique unavailable (undefined)", exited 0, and
  // never wrote critique.json. Invisible in every run here because the default
  // path has no GEMINI_API_KEY and takes critiqueFrames.
  //
  // Asserted on the SOURCE because exercising it needs a Gemini key and a real
  // upload; what matters is that both success paths speak the same contract.
  const src = readFileSync(path.join(HERE, 'src', 'critique.js'), 'utf8');
  assert.match(src, /ok: true,\s*\n\s*via: 'gemini'/,
    "critiqueVideo's success return must carry ok+via like critiqueFrames does");
  assert.doesNotMatch(src, /return \{ skipped:/,
    'and its early returns must use {ok:false, reason} — `skipped` is not a contract the caller reads');
});

test('the genre vocabulary is enforced, not merely suggested', () => {
  // Narrowing the enums in the prompt is advice. If the model reaches for a
  // token anyway it has to be clamped, or a fix_caption_overlap on a marketing
  // take reaches critique.json, clears run.mjs's cheap-lane filter, and buys a
  // full re-walk. BOTH paths clamp — frames is the default one and was the
  // unclamped one.
  const src = readFileSync(path.join(HERE, 'src', 'critique.js'), 'utf8');
  const clamps = src.match(/fixesFor\(genre, hasVoiceover\)\.includes\(x\.fix\)/g) || [];
  assert.strictEqual(clamps.length, 2,
    `both critiqueVideo and critiqueFrames must clamp the fix, found ${clamps.length}`);
  // COUNTING THE CLAMP IS NOT ENOUGH. Dropping `issues` from the frames return
  // leaves the clamp in the file, unused, and a count-based assertion passes
  // while the default path ships unclamped issues again.
  assert.match(src, /via: 'frames', sheet, \.\.\.out, issues,/,
    'the frames return must ship the CLAMPED issues, not spread the parsed JSON');
  // `contradiction` has the same hazard and further to travel: unnormalised it
  // becomes a false flow finding, pollutes the guidance handed to the next
  // discovery pass, and reaches two `.slice()` calls that a bare string or a
  // `{}` would crash. `...out` would carry the model's raw key, so the
  // normalised value has to be assigned after it — in BOTH paths, frames being
  // the default and the one that spreads. It does NOT refuse a publish: the
  // test ~1,570 lines below pins that, and these two must not disagree.
  const normalised = src.match(/contradiction: admissibleContradiction\(/g) || [];
  assert.strictEqual(normalised.length, 2,
    `both critique paths must normalise the contradiction, found ${normalised.length}`);
  // PRESENCE BEFORE ORDER. `indexOf` returns -1 when the needle is absent, and
  // -1 is less than every real index — so comparing the two directly passes
  // whenever the normaliser call is MISSING, which is the arrangement this
  // assertion exists to reject. Both reviewers caught it; the message was a
  // claim about a check rather than a check.
  const framesReturn = src.slice(src.indexOf("via: 'frames'"));
  const atNormalise = framesReturn.indexOf('contradiction: admissibleContradiction(');
  const atSpread = framesReturn.indexOf('...out');
  const atEnd = framesReturn.indexOf(';');
  assert.ok(atNormalise > -1, 'the frames return must normalise the contradiction at all');
  assert.ok(atSpread > -1, 'and must still spread the parsed reply');
  assert.ok(atSpread < atNormalise && atNormalise < atEnd,
    'the normalised value must be assigned AFTER the spread and inside the same return, '
    + `got spread@${atSpread} normalise@${atNormalise} end@${atEnd}`);
});

test('the voiceover claim follows the take, and marketing never has one', () => {
  // Same shape as the music fact. A tutorial cut can lose every line through
  // the loop's own shorten_narration remedy (keepLines + DEMO_DROP_LINES →
  // planNarration returns []), after which asserting a voiceover hands the
  // grader narration_mismatch over silence, whose remedy routes to a narration
  // stage with nothing left to drop.
  const { buildPrompt } = require('../src/critique.js');
  const cases = [
    ['marketing', true, false], ['marketing', false, false],
    ['tutorial', true, true], ['tutorial', false, false],
  ];
  for (const [genre, hasVoice, expectVoice] of cases) {
    const p = buildPrompt('g', genre, true, hasVoice, false);
    assert.strictEqual(/a synthesized voiceover/.test(p), expectVoice,
      `${genre}/${hasVoice}: names a voiceover only when there is one`);
    assert.strictEqual(/does the voiceover match/.test(p), expectVoice,
      `${genre}/${hasVoice}: asks about it only when there is one`);
    assert.strictEqual(p.includes('narration_mismatch'), expectVoice,
      `${genre}/${hasVoice}: offers the token only when there is one`);
    // Suppression is asserted semantically: the marketing branch says "Do not
    // report the absence of captions, narration, or title cards", the tutorial
    // branch says "no voiceover (do not report its absence)". Different
    // wording, same job — pinning one phrasing would fail on the other.
    if (!expectVoice) {
      assert.match(p, /do not report (the absence of captions, narration|its absence)/i,
        `${genre}/${hasVoice}: suppresses rather than staying silent`);
    }
  }
});

test('an explicit DEMO_STYLE is not shadowed by a genre finish recorded itself', () => {
  // Persisting a fallback genre made the override sticky on a standalone
  // outDir: the first run wrote {why: 'DEMO_STYLE was set'}, every later run
  // took the recorded branch and ignored the env var — building for the old
  // genre and logging "(decided at capture)" about a genre nothing captured.
  const src = readFileSync(path.join(HERE, 'finish.mjs'), 'utf8');
  assert.match(src, /const styleOverride = process\.env\.DEMO_STYLE \|\| null;/,
    'the env override must be read');
  assert.match(src, /styleOverride\s*\n?\s*\?/,
    'and must be checked BEFORE the recorded genre');
  assert.match(src, /decided at finish/,
    'a genre finish picked itself must not claim capture decided it');
});

test('a prohibited issue type is dropped, not merely stripped of its fix', () => {
  // CODEX, round 4: both paths clamped `issue.fix` and neither validated
  // `issue.type`. A marketing take that got `caption_unreadable` back anyway
  // kept a medium, actionable finding — it clears run.mjs's cheap-lane filter
  // and buys a re-walk, which is the same harm the token removal exists to
  // stop, arriving through the other field.
  //
  // Driven with the exact output the prompt forbids.
  const { admissibleIssue, typesFor, FRAME_TYPES, VIDEO_TYPES } = require('../src/critique.js');

  const prohibited = { type: 'caption_unreadable', severity: 'medium', description: 'x', fix: 'fix_caption_overlap' };
  const allowedMarketing = typesFor(FRAME_TYPES, 'marketing', false);
  assert.strictEqual(admissibleIssue(prohibited, allowedMarketing, 'marketing', false), null,
    'a caption finding on a captionless take must be dropped entirely');

  // DROPPED, not remapped: coercing type to `other` would keep it actionable
  // and just hide where it came from.
  const kept = admissibleIssue(prohibited, typesFor(FRAME_TYPES, 'tutorial', true), 'tutorial', true);
  assert.ok(kept, 'the same finding is legitimate on a tutorial take');
  assert.strictEqual(kept.type, 'caption_unreadable');
  assert.strictEqual(kept.fix, 'fix_caption_overlap', 'and keeps its remedy there');

  // A narration finding follows the voiceover fact, not just the genre.
  const narr = { type: 'narration_mismatch', severity: 'medium', description: 'x', fix: 'shorten_narration' };
  assert.strictEqual(admissibleIssue(narr, typesFor(VIDEO_TYPES, 'tutorial', false), 'tutorial', false), null,
    'a tutorial that lost every line has no narration to mismatch');
  assert.ok(admissibleIssue(narr, typesFor(VIDEO_TYPES, 'tutorial', true), 'tutorial', true),
    'but a voiced tutorial does');

  // A shared type survives everywhere, with an out-of-vocabulary fix clamped.
  const shared = { type: 'visual_glitch', severity: 'low', description: 'x', fix: 'shorten_narration' };
  const m = admissibleIssue(shared, allowedMarketing, 'marketing', false);
  assert.ok(m, 'visual_glitch belongs to every genre');
  assert.strictEqual(m.fix, 'none', 'but a fix the genre cannot run is clamped away');
});

//: ENG-6295 — the enumeration pass. Four review rounds each found the same bug:
//: the prompt asserted a fact the pipeline did not guarantee, so the grader was told
//: not to report a defect that was really on screen. These tests walk EVERY
//: combination of the facts the prompt asserts, rather than sampling one more.
test('critique prompt: the camera claim follows the cut, in every combination', () => {
  const { buildPrompt } = require('../src/critique.js');
  for (const genre of ['marketing', 'tutorial', null]) {
    for (const hasMusic of [true, false]) {
      for (const hasVoiceover of [true, false]) {
        const loop = buildPrompt('g', genre, hasMusic, hasVoiceover, false);
        const pub = buildPrompt('g', genre, hasMusic, hasVoiceover, true);
        const where = `genre=${genre} music=${hasMusic} voice=${hasVoiceover}`;
        // A loop cut is graded BEFORE publish: it has no camera and no card.
        assert.ok(/NO camera movement/.test(loop), `loop cut must not claim punch-ins (${where})`);
        assert.ok(!/and camera punch-ins on some clicks/.test(loop), `loop claims punch-ins (${where})`);
        assert.ok(/no intro or outro card/.test(loop), `loop cut has no card, say so (${where})`);
        // The .final cut carries both.
        assert.ok(/and camera punch-ins on some clicks/.test(pub), `final cut has punch-ins (${where})`);
        assert.ok(!/no intro or outro card/.test(pub), `final cut HAS a card (${where})`);
      }
    }
  }
});

test('critique prompt: a defaulted fact is a crash, not a false sentence', () => {
  const { buildPrompt, sheetPrompt } = require('../src/critique.js');
  // The bug class in one assertion: every fact the prompt asserts must be passed.
  assert.throws(() => buildPrompt('g', 'marketing', true, true, undefined), /composited must be passed/);
  assert.throws(() => buildPrompt('g', 'marketing', undefined, true, false), /hasMusic must be passed/);
  assert.throws(() => buildPrompt('g', 'marketing', true, undefined, false), /hasVoiceover must be passed/);
  assert.throws(() => buildPrompt('g', undefined, true, true, false), /genre must be passed/);
  // ...but a guard must not demand a fact its own prompt never claims. sheetPrompt
  // makes no camera or card claim, so requiring `composited` there would crash a
  // valid caller — the opposite failure, and just as real.
  assert.doesNotThrow(() => sheetPrompt('g', 10, 's', 1, 'marketing', true));
});

// ── ENG-5766: the editorial pass ──────────────────────────────────────────
//
// The premise the ticket was filed on had gone stale by the time it was picked
// up: a script IS written, and the recording IS paced to it (ENG-5919 landed
// `narration.js` and `pacing.js`). What was genuinely absent is what the ticket
// itself names as the two things the reference does NOT do — an editorial layer
// that can cut and reorder, and a don't-invent discipline.
//
// These pin the DISPOSER. `proposeEdit` is a model call and decides nothing on
// its own; every rule that can be checked lives in `disposeEdit`/`settleBeats`,
// which are pure, and that split is the thing worth keeping true.
const { disposeEdit, settleBeats, describeStep, MIN_EDITABLE } = require('../src/edit.js');
const { checkInventions, sayableNames } = require('../src/invention.js');
const { nameFromSelector, stepName, elementName } = require('../src/element-name.js');
const { paceFloors, HOLD_FLOOR_SEC } = require('../src/pacing.js');

/** A flow long enough to be worth editing — under MIN_EDITABLE nothing is cut. */
const editableFlow = () => ({
  goal: 'show off the designer',
  steps: [
    { action: 'click', locator: 'role=button[name="Open Moda"i]', why: 'get to the app' },
    { action: 'click', locator: 'role=button[name="Workspace"i]', why: 'pick a workspace' },
    { action: 'fill', locator: '#prompt', text: 'a launch deck', why: 'ask for a deck' },
    { action: 'click', locator: 'role=button[name="Generate"i]', why: 'run it' },
  ],
});

const keepAll = (n, over = {}) => ({
  about: 'Moda turns a prompt into a deck',
  decisions: Array.from({ length: n }, (_, index) => ({ index, keep: true, beat: 'build', pace: 'normal', why: '' })),
  ...over,
});

test('the edit cuts a step that works fine and simply is not the story', () => {
  const flow = editableFlow();
  const out = disposeEdit({ flow, proposal: {
    about: 'Moda turns a prompt into a deck',
    decisions: [
      { index: 0, keep: false, why: 'transport — getting to the app is not the point' },
      { index: 1, keep: false, why: 'picking a workspace is setup' },
      { index: 2, keep: true, beat: 'hook', pace: 'normal', why: 'the ask' },
      { index: 3, keep: true, beat: 'payoff', pace: 'hold', why: 'the deck appears' },
    ],
  } });
  assert.equal(out.flow.steps.length, 2);
  assert.deepEqual(out.cuts.map((c) => c.index), [0, 1]);
  // The REASON is kept, not just the index. It is what the log prints and what
  // ENG-5762's review surface has to show a human who disagrees.
  assert.match(out.cuts[0].why, /transport/);
  assert.equal(out.about, 'Moda turns a prompt into a deck');
  assert.equal(out.edited, true);
  // Nothing curate or the no-op check could have done: both remaining steps and
  // both cut ones resolve, execute, and change the page.
  assert.deepEqual(out.flow.steps.map((s) => s.beat), ['hook', 'payoff']);
});

test('a step the editor said nothing about is KEPT, never silently dropped', () => {
  const flow = editableFlow();
  // Three decisions for four steps — the ordinary ragged-output case.
  const out = disposeEdit({ flow, proposal: {
    about: 'x',
    decisions: [
      { index: 0, keep: true, beat: 'hook', pace: 'normal' },
      { index: 1, keep: false, why: 'setup' },
      { index: 2, keep: true, beat: 'build', pace: 'normal' },
    ],
  } });
  assert.equal(out.flow.steps.length, 3, 'step 3 had no decision and must survive');
  assert.ok(out.flow.steps.some((s) => s.locator.includes('Generate')));
  assert.match(out.corrections.join(' '), /no decision for step\(s\) 3/);
});

test('a wait is never cut — it is how the flow waits for the product, not a beat', () => {
  const flow = {
    goal: 'g',
    steps: [
      { action: 'click', locator: 'role=button[name="A"i]' },
      { action: 'fill', locator: '#p', text: 'hi' },
      { action: 'wait', quietMs: 3000, maxMs: 120000, why: 'generating' },
      { action: 'click', locator: 'role=button[name="Save"i]' },
    ],
  };
  const out = disposeEdit({ flow, proposal: {
    about: 'x',
    decisions: [
      { index: 0, keep: true, beat: 'hook', pace: 'normal' },
      { index: 1, keep: true, beat: 'build', pace: 'normal' },
      { index: 2, keep: false, why: 'dead air' },
      { index: 3, keep: true, beat: 'payoff', pace: 'hold' },
    ],
  } });
  assert.ok(out.flow.steps.some((s) => s.action === 'wait'), 'the wait must survive the edit');
  assert.equal(out.cuts.length, 0);
  assert.match(out.corrections.join(' '), /synchronisation step/);
});

test('an edit that would empty the demo is refused outright, not applied partly', () => {
  const flow = editableFlow();
  const out = disposeEdit({ flow, proposal: {
    about: 'x',
    decisions: [
      { index: 0, keep: false, why: 'no' },
      { index: 1, keep: false, why: 'no' },
      { index: 2, keep: false, why: 'no' },
      { index: 3, keep: true, beat: 'payoff', pace: 'hold', why: 'yes' },
    ],
  } });
  // One surviving action is below the floor the rest of the pipeline already
  // calls "a thin demo", and `run.mjs` refuses the same shape for inert drops.
  assert.equal(out.flow.steps.length, 4, 'no cuts are applied when the edit goes too far');
  assert.equal(out.cuts.length, 0);
  assert.equal(out.edited, false);
  assert.match(out.corrections.join(' '), /below the floor/);

  // ...and the steps it put back do not record the argument for cutting them
  // as their reason for being kept. Same defect as the wait guard's, reached
  // through the other restore path — both go through one helper now.
  for (const p of out.plan.filter((x) => x.sourceIndex !== 3)) {
    assert.match(p.why, /kept because the edit cut too much/, `step ${p.sourceIndex}`);
    assert.match(p.why, /the edit wanted it cut: no/);
  }
  // A step the edit wanted to KEEP is untouched by the override.
  assert.equal(out.plan.find((x) => x.sourceIndex === 3).why, 'yes');
});

test('a flow too short to edit is left exactly as discovered', () => {
  const flow = { goal: 'g', steps: [
    { action: 'fill', locator: '#p', text: 'hi' },
    { action: 'click', locator: 'role=button[name="Go"i]' },
  ] };
  assert.ok(flow.steps.length < MIN_EDITABLE);
  const out = disposeEdit({ flow, proposal: {
    about: 'still useful',
    decisions: [{ index: 0, keep: false, why: 'cut it' }, { index: 1, keep: true, beat: 'payoff', pace: 'hold' }],
  } });
  assert.equal(out.flow, flow, 'the very flow object, untouched');
  assert.equal(out.plan, null);
  // The one-line spine is still worth having — it costs nothing and the script
  // reads it. Only the CUTS are refused.
  assert.equal(out.about, 'still useful');
});

test('the film gets exactly one payoff, and it is the last thing that plays', () => {
  const flow = editableFlow();
  const out = disposeEdit({ flow, proposal: keepAll(4, { decisions: [
    { index: 0, keep: true, beat: 'payoff', pace: 'hold' },
    { index: 1, keep: true, beat: 'payoff', pace: 'hold' },
    { index: 2, keep: true, beat: 'build', pace: 'normal' },
    { index: 3, keep: true, beat: 'build', pace: 'normal' },
  ] }) });
  const beats = out.flow.steps.map((s) => s.beat);
  assert.equal(beats.filter((b) => b === 'payoff').length, 1);
  assert.equal(beats[beats.length - 1], 'payoff', 'the payoff plays last');
  assert.match(out.corrections.join(' '), /marked at position 1 but 3 plays last/);
});

test('a step that plays after the payoff is a close, so the demo does not end twice', () => {
  const flow = editableFlow();
  const out = disposeEdit({ flow, proposal: keepAll(4, { decisions: [
    { index: 0, keep: true, beat: 'hook', pace: 'normal' },
    { index: 1, keep: true, beat: 'build', pace: 'normal' },
    { index: 2, keep: true, beat: 'payoff', pace: 'hold' },
    { index: 3, keep: true, beat: 'build', pace: 'normal' },
  ] }) });
  // The payoff MOVES to the end rather than everything after it being
  // relabelled a close. Relabelling was the first implementation and it broke
  // the invariant it was meant to serve: the last beat came out `close`, so the
  // payoff was not last, and the hold no longer coincided with the tail
  // `compress.js` protects at 1x.
  assert.deepEqual(out.flow.steps.map((s) => s.beat), ['hook', 'build', 'build', 'payoff']);
  assert.match(out.corrections.join(' '), /moved, and the earlier one is a build/);
});

test('the editor cannot label a step `close` — that beat belongs to the trailing hold', () => {
  const flow = editableFlow();
  const out = disposeEdit({ flow, proposal: keepAll(4, { decisions: [
    { index: 0, keep: true, beat: 'hook', pace: 'normal' },
    { index: 1, keep: true, beat: 'close', pace: 'normal' },
    { index: 2, keep: true, beat: 'build', pace: 'normal' },
    { index: 3, keep: true, beat: 'payoff', pace: 'hold' },
  ] }) });
  // Nothing the editor can see is a close: the closing beat is the hold
  // `ensureTrailingHold` appends after this pass, plus the closing card that
  // arrives at publish as the film's last page (ENG-6306).
  assert.deepEqual(out.flow.steps.map((s) => s.beat), ['hook', 'build', 'build', 'payoff']);
  assert.match(out.corrections.join(' '), /the closing beat is the appended hold/);
});

test('a `close` on the LAST real action does not displace the payoff', () => {
  // Rejecting `close` only when it was not final left this one standing, and
  // `settleBeats` then skipped it when looking for the last substantive step —
  // so the payoff settled onto the step BEFORE it, breaking the one invariant
  // the hold depends on. The beat is refused at the door instead.
  const flow = editableFlow();
  const out = disposeEdit({ flow, proposal: keepAll(4, { decisions: [
    { index: 0, keep: true, beat: 'hook', pace: 'normal' },
    { index: 1, keep: true, beat: 'build', pace: 'normal' },
    { index: 2, keep: true, beat: 'payoff', pace: 'hold' },
    { index: 3, keep: true, beat: 'close', pace: 'normal' },
  ] }) });
  const beats = out.flow.steps.map((s) => s.beat);
  assert.equal(beats[beats.length - 1], 'payoff', 'the payoff is still last');
  assert.ok(!beats.includes('close'), 'no step the editor chose carries a close');
  assert.equal(out.flow.steps[out.flow.steps.length - 1].pace, 'hold');
});

test('the appended trailing hold becomes the close, so the storyboard has three pages', () => {
  const { ensureTrailingHold } = require('../src/curate.js');
  const flow = editableFlow();
  const edited = disposeEdit({ flow, proposal: keepAll(4) });
  // `curate` appends the hold AFTER the edit, so it arrives here with no beat.
  const withHold = ensureTrailingHold(edited.flow).flow;
  const settled = settleBeats(withHold.steps);
  assert.equal(settled.steps[settled.steps.length - 1].action, 'wait');
  assert.equal(settled.steps[settled.steps.length - 1].beat, 'close');
  // ...and the payoff did NOT walk onto it.
  assert.equal(settled.steps[settled.steps.length - 2].beat, 'payoff');
  // Idempotent across that, which is the call `run.mjs` actually makes.
  const again = settleBeats(settled.steps);
  assert.deepEqual(again.steps.map((s) => s.beat), settled.steps.map((s) => s.beat));
  assert.deepEqual(again.corrections, []);
});

test('a hook that does not open is a mislabel, not a structure', () => {
  const flow = editableFlow();
  const out = disposeEdit({ flow, proposal: keepAll(4, { decisions: [
    { index: 0, keep: true, beat: 'build', pace: 'normal' },
    { index: 1, keep: true, beat: 'hook', pace: 'normal' },
    { index: 2, keep: true, beat: 'build', pace: 'normal' },
    { index: 3, keep: true, beat: 'payoff', pace: 'hold' },
  ] }) });
  assert.deepEqual(out.flow.steps.map((s) => s.beat), ['build', 'build', 'build', 'payoff']);
  assert.match(out.corrections.join(' '), /marked hook but does not open/);
});

test('the payoff is always held, even when the edit asked to hurry it', () => {
  const flow = editableFlow();
  const out = disposeEdit({ flow, proposal: keepAll(4, { decisions: [
    { index: 0, keep: true, beat: 'hook', pace: 'normal' },
    { index: 1, keep: true, beat: 'build', pace: 'hurry' },
    { index: 2, keep: true, beat: 'build', pace: 'hurry' },
    { index: 3, keep: true, beat: 'payoff', pace: 'hurry' },
  ] }) });
  const last = out.flow.steps[out.flow.steps.length - 1];
  assert.equal(last.beat, 'payoff');
  assert.equal(last.pace, 'hold', 'a hurried payoff contradicts the edit\'s own decision');
  // The other hurries are the editor's call and are left alone.
  assert.deepEqual(out.flow.steps.map((s) => s.pace), ['normal', 'hurry', 'hurry', 'hold']);
});

test('an unknown beat or pace is coerced and SAID, not passed through', () => {
  const flow = editableFlow();
  const out = disposeEdit({ flow, proposal: keepAll(4, { decisions: [
    { index: 0, keep: true, beat: 'HOOK', pace: 'normal' },
    { index: 1, keep: true, beat: 'montage', pace: 'slow' },
    { index: 2, keep: true, beat: 'build', pace: 'normal' },
    { index: 3, keep: true, beat: 'payoff', pace: 'hold' },
  ] }) });
  assert.deepEqual(out.flow.steps.map((s) => s.beat), ['build', 'build', 'build', 'payoff']);
  assert.deepEqual(out.flow.steps.map((s) => s.pace), ['normal', 'normal', 'normal', 'hold']);
  const said = out.corrections.join(' ');
  assert.match(said, /unknown beat "montage"/);
  assert.match(said, /unknown pace "slow"/);
  assert.match(said, /unknown beat "HOOK"/, 'the vocabulary is exact, not case-folded');
});

test('a reorder is applied, and a step the order forgot keeps its place', () => {
  const flow = editableFlow();
  const out = disposeEdit({ flow, proposal: keepAll(4, { order: [3, 0] }) });
  // 3 and 0 as asked, then 1 and 2 appended in source order rather than dropped
  // by omission — the same rule as a missing decision.
  assert.deepEqual(out.plan.map((p) => p.sourceIndex), [3, 0, 1, 2]);
  assert.equal(out.reordered, true);
  assert.match(out.corrections.join(' '), /omitted step\(s\) 1, 2/);
  assert.ok(out.flow.steps[0].locator.includes('Generate'), 'the flow itself is reordered');
});

test('the caller can refuse a reorder, and then source order is what plays', () => {
  const flow = editableFlow();
  const out = disposeEdit({ flow, proposal: keepAll(4, { order: [3, 2, 1, 0] }), allowReorder: false });
  assert.deepEqual(out.plan.map((p) => p.sourceIndex), [0, 1, 2, 3]);
  assert.equal(out.reordered, false);
  assert.match(out.corrections.join(' '), /refused by the caller/);
});

test('the beat and pace ride ON the step, so a later drop cannot desync them', () => {
  const { without } = require('../src/curate.js');
  const flow = editableFlow();
  const out = disposeEdit({ flow, proposal: keepAll(4, { decisions: [
    { index: 0, keep: true, beat: 'hook', pace: 'normal' },
    { index: 1, keep: true, beat: 'build', pace: 'hurry' },
    { index: 2, keep: true, beat: 'build', pace: 'normal' },
    { index: 3, keep: true, beat: 'payoff', pace: 'hold' },
  ] }) });

  // `curate.without` and the no-op drop both filter `flow.steps` and know
  // nothing about any sidecar. A plan addressed by index would re-point onto
  // the wrong steps here, and the symptom would be the payoff hold landing on
  // some other moment — a wrong video that every other check passes.
  const trimmed = without(out.flow, [1]);
  assert.equal(trimmed.steps.length, 3);
  assert.deepEqual(trimmed.steps.map((s) => s.beat), ['hook', 'build', 'payoff']);
  assert.equal(trimmed.steps[2].pace, 'hold');
  assert.ok(trimmed.steps[2].locator.includes('Generate'), 'the hold is still on the Generate step');
});

test('settleBeats re-asserts the payoff after a later stage deletes it', () => {
  const { without } = require('../src/curate.js');
  const flow = editableFlow();
  const edited = disposeEdit({ flow, proposal: keepAll(4, { decisions: [
    { index: 0, keep: true, beat: 'hook', pace: 'normal' },
    { index: 1, keep: true, beat: 'build', pace: 'normal' },
    { index: 2, keep: true, beat: 'build', pace: 'normal' },
    { index: 3, keep: true, beat: 'payoff', pace: 'hold' },
  ] }) });

  // The no-op check removes the LAST step: it resolved and executed but moved
  // zero pixels. The edit's payoff is now gone, and without a re-settle the
  // flow reaches the recorder with no payoff and therefore no hold.
  const afterDrop = without(edited.flow, [3]);
  assert.ok(!afterDrop.steps.some((s) => s.beat === 'payoff'), 'the premise: the payoff was dropped');

  const settled = settleBeats(afterDrop.steps);
  assert.equal(settled.steps[settled.steps.length - 1].beat, 'payoff');
  assert.equal(settled.steps[settled.steps.length - 1].pace, 'hold', 'and it is held');
  assert.match(settled.corrections.join(' '), /no step was marked payoff/);
});

test('settleBeats is idempotent, so calling it twice reports nothing the second time', () => {
  const flow = editableFlow();
  const edited = disposeEdit({ flow, proposal: keepAll(4) });
  const once = settleBeats(edited.flow.steps);
  const twice = settleBeats(once.steps);
  assert.deepEqual(twice.steps.map((s) => s.beat), once.steps.map((s) => s.beat));
  assert.deepEqual(twice.corrections, [], 'an already-settled list produces no corrections');
});

test('settleBeats leaves an unedited flow alone rather than inventing a structure', () => {
  // The editor failed, or the flow was hand-authored with `--flow`. It must not
  // acquire a payoff nobody chose — `run.mjs` calls this unconditionally.
  const steps = editableFlow().steps;
  const out = settleBeats(steps);
  assert.deepEqual(out.corrections, []);
  assert.ok(out.steps.every((s) => s.beat === undefined));
});

// ── ENG-5766: say the real names ──────────────────────────────────────────

test('one extractor reads every form of a role selector, including the narrow one', () => {
  assert.equal(nameFromSelector('role=button[name="Create"i]'), 'Create');
  // `curate.js` had the narrowest of the three copies — double quotes only —
  // so a single-quoted recovery button slipped past its filter entirely.
  assert.equal(nameFromSelector("role=button[name='Try again'i]"), 'Try again');
  assert.equal(nameFromSelector('role=button[name=/Retry/i]'), 'Retry');
  // An escaped delimiter must not truncate the name: `[^"]*` stopped at the
  // first `\\"` and returned `Say`, which reads like a real answer.
  assert.equal(nameFromSelector('role=button[name="Say \\"hi\\""i]'), 'Say "hi"');
  assert.equal(nameFromSelector('#prompt'), '', 'a selector with no name has no name');
  assert.equal(nameFromSelector(undefined), '');
});

test('the flow-step name never falls back to the agent\'s reason', () => {
  // `elementName` (a recorded action) may fall back to its label, because a
  // keypress genuinely has no element. `stepName` may not: the flow's `why` is
  // `action.reason` from the discovery model, and admitting it is exactly the
  // bug captions.js was rewritten to fix.
  const step = { action: 'click', locator: '#prompt', why: 'let me scroll up to find the link' };
  assert.equal(stepName(step), '');
  assert.equal(elementName({ selector: '', label: 'Enter' }), 'Enter');
});

test('the editor is shown the element and the reason as DIFFERENT fields', () => {
  const line = describeStep(
    { action: 'click', locator: 'role=button[name="Invite teammate"i]', why: 'trying the sharing path' },
    2
  );
  assert.match(line, /element: "Invite teammate"/);
  assert.match(line, /agent's reason: "trying the sharing path"/);
  // Presenting them as one field is what let the reasoning be read as a name.
  assert.ok(line.indexOf('element:') < line.indexOf("agent's reason:"));
});

/**
 * A fake `claude` on PATH that records the prompts it was given and replies
 * with `script`. Returns the directory it recorded into.
 *
 * The transport is the one thing in this lane that cannot be tested purely —
 * `scriptNarration` shells out — and it is also where "say the real names"
 * either happens or does not, because the whole fix is what goes INTO the
 * prompt. Asserting on `narration.js`'s source instead would have passed just
 * as well before the change.
 */
function fakeClaude(script, conclusion = 'done') {
  const dir = tmp();
  const reply = JSON.stringify({ script, conclusion });
  // Paths QUOTED: a tmpdir with a space in it is ordinary on some CI images,
  // and an unquoted redirect target there is a shell syntax error rather than
  // a test failure anyone can read.
  const q = (f) => JSON.stringify(path.join(dir, f));
  writeFileSync(path.join(dir, 'claude'), [
    '#!/bin/sh',
    'while [ $# -gt 0 ]; do',
    '  case "$1" in',
    `    -p) printf '%s' "$2" > ${q('user.txt')}; shift 2;;`,
    `    --append-system-prompt) printf '%s' "$2" > ${q('system.txt')}; shift 2;;`,
    '    *) shift;;',
    '  esac',
    'done',
    `cat ${q('reply.json')}`,
  ].join('\n'));
  writeFileSync(path.join(dir, 'reply.json'), JSON.stringify({ result: reply }));
  execFileSync('chmod', ['+x', path.join(dir, 'claude')]);
  return dir;
}

/** Run `fn` with `dir` first on PATH and no API key, so the CLI branch is taken. */
async function withFakeClaude(dir, fn) {
  const prevKey = process.env.ANTHROPIC_API_KEY;
  const prevPath = process.env.PATH;
  delete process.env.ANTHROPIC_API_KEY;
  process.env.PATH = `${dir}:${prevPath}`;
  try {
    return await fn();
  } finally {
    process.env.PATH = prevPath;
    if (prevKey !== undefined) process.env.ANTHROPIC_API_KEY = prevKey;
  }
}

test('the script writer is handed the resolved name, not only the reason', async () => {
  const { scriptNarration } = require('../src/narration.js');
  const dir = fakeClaude('one\ntwo');
  const out = await withFakeClaude(dir, () => scriptNarration({
    goal: 'g',
    about: 'Moda turns a prompt into a deck',
    steps: [
      { type: 'click', label: 'get to the app', name: 'Open Moda', beat: 'hook', pace: 'normal' },
      { type: 'click', label: 'run it', name: 'Generate', beat: 'payoff', pace: 'hold' },
    ],
  }));
  assert.deepEqual(out.lines, ['one', 'two']);
  assert.equal(out.conclusion, 'done');

  const system = readFileSync(path.join(dir, 'system.txt'), 'utf8');
  // The reference's prompt survives verbatim, and ours is APPENDED to it —
  // two of its rules have already been "improved" backwards once (ENG-5919).
  assert.match(system, /You write the voiceover script for a short product demo video/);
  assert.match(system, /Vary the\s+openings naturally/);
  assert.match(system, /RESOLVED ELEMENT NAME/);
  assert.match(system, /NEVER NAME SOMETHING YOU WERE NOT GIVEN/);

  const user = readFileSync(path.join(dir, 'user.txt'), 'utf8');
  // THE ACTUAL FIX: the element name is in the prompt, and the agent's reason
  // is still there but labelled as the reason rather than presented as a name.
  assert.match(user, /element: "Open Moda"/);
  assert.match(user, /element: "Generate"/);
  assert.match(user, /reason: "run it"/);
  assert.match(user, /beat: payoff/);
  assert.match(user, /pace: hold/);
  assert.match(user, /What this video is about: Moda turns a prompt into a deck/);
});

test('the script prompt carries no beat or spine when nothing was edited', async () => {
  const { scriptNarration } = require('../src/narration.js');
  const dir = fakeClaude('one');
  await withFakeClaude(dir, () => scriptNarration({
    goal: 'g',
    steps: [{ type: 'click', label: 'run it', name: 'Generate' }],
  }));
  const user = readFileSync(path.join(dir, 'user.txt'), 'utf8');
  assert.match(user, /element: "Generate"/);
  assert.ok(!user.includes('beat:'), 'an unedited step must not claim a beat');
  assert.ok(!user.includes('What this video is about'));
});

// ── ENG-5766: don't invent ────────────────────────────────────────────────

test('a quoted name the demo cannot show is caught', () => {
  const flow = editableFlow();
  const out = checkInventions({
    lines: [
      'Let\'s start by opening Moda from the toolbar.',
      'Now click "Invite teammate" to bring the rest of the team in.',
    ],
    flow,
  });
  assert.equal(out.measured, true);
  assert.equal(out.inventions.length, 1);
  assert.equal(out.inventions[0].index, 1);
  assert.equal(out.inventions[0].quoted, 'Invite teammate');
});

test('a quoted name that IS on screen passes, in either direction', () => {
  const flow = editableFlow();
  // One line per step, in step order — the shape the prompt actually produces.
  // Exactly the name, PART of the name, a name that CONTAINS the quote, and
  // the typed text.
  const out = checkInventions({
    lines: [
      'The "Open" control gets us into the app.',        // part of "Open Moda"
      'Pick a "Workspace" to work in.',                  // exactly the name
      'We type "a launch deck" into the prompt box.',    // the typed text
      'Hit the "Generate" button and watch it go.',      // contains the name
    ],
    flow,
  });
  assert.deepEqual(out.inventions, []);
  assert.equal(out.checked, 4);
  assert.equal(out.measured, true);
});

test('a script that quotes nothing reports UNMEASURED, which is not a pass', () => {
  const out = checkInventions({
    lines: ['Let us begin in the designer.', 'Then the deck appears.'],
    flow: editableFlow(),
  });
  assert.equal(out.measured, false);
  assert.equal(out.checked, 0);
  assert.deepEqual(out.inventions, []);
  // The distinction this package has shipped three checks without: "nothing
  // wrong" and "nothing to look at" must not read the same.
  assert.match(out.reason, /nothing this check can decide/);
});

test('the agent\'s reason is never admitted as something the script may quote', () => {
  const flow = {
    goal: 'g',
    steps: [
      { action: 'click', locator: '#a', why: 'let me scroll up to find the Go to App link' },
      { action: 'click', locator: 'role=button[name="Save"i]', why: 'save it' },
      { action: 'fill', locator: '#p', text: 'hello', why: 'type' },
    ],
  };
  const names = sayableNames(flow);
  assert.ok(names.has('save'));
  assert.ok(names.has('hello'));
  assert.ok(!names.has('let me scroll up to find the go to app link'));
  const out = checkInventions({ lines: ['Click "Go to App" to continue.'], flow });
  assert.equal(out.inventions.length, 1, 'the reason must not license quoting itself back');
});

test('a possessive apostrophe is not read as a claim about a button', () => {
  const out = checkInventions({
    lines: ["Let's open the designer and see what Moda's engine does."],
    flow: editableFlow(),
  });
  assert.deepEqual(out.inventions, [], 'an apostrophe-s fragment is not a name');
});

// ── ENG-5766: hold-or-hurry actually reaches the recorder ─────────────────

test('a hold becomes a recorder floor on a take with no voiceover at all', () => {
  // The marketing genre never reaches planPacing, so without this the hold
  // would be a lever that silently does nothing on the genre all three
  // reference demos use.
  const steps = [
    { action: 'click', beat: 'hook', pace: 'normal' },
    { action: 'fill', beat: 'build', pace: 'hurry' },
    { action: 'click', beat: 'payoff', pace: 'hold' },
  ];
  assert.deepEqual(paceFloors(steps), [0, 0, HOLD_FLOOR_SEC]);
});

test('an unedited flow asks for no floors, rather than an array of zeroes', () => {
  // `stepMinDurations` is passed straight to the recorder, which treats a
  // present array as a decision. An unedited take must keep its own cadence.
  assert.equal(paceFloors(editableFlow().steps), null);
  assert.equal(paceFloors([]), null);
});

test('the hold floor is sized to the beat the compressor already protects', () => {
  const { TAIL_KEEP } = require('../src/compress.js');
  // Two numbers that have to agree: a payoff held for less than the tail that
  // plays at 1x is a hold nobody can see, and the payoff is the last step by
  // invariant, so the two describe the same stretch of footage. Pinned so they
  // cannot be tuned apart.
  assert.equal(HOLD_FLOOR_SEC, TAIL_KEEP);
});

test('run.mjs re-settles the beats AFTER every stage that can drop a step', () => {
  const src = readFileSync(path.join(HERE, 'run.mjs'), 'utf8');
  const settle = src.indexOf('settleBeats(curated.steps)');
  assert.ok(settle > 0, 'run.mjs must re-settle the beats before writing the flow it records');
  // Both droppers run before it, or the payoff can be deleted after the last
  // thing that could notice.
  //
  // EACH MARKER IS ASSERTED TO EXIST before its index is compared. `indexOf`
  // returns -1 for a string that is not there, and `-1 < settle` is true — so
  // rewording either log line would have turned this into a guard that passes
  // by finding nothing, which is the failure it is here to prevent.
  for (const [marker, why] of [
    ["dropping step(s) ${inert.join(', ')}", 'the no-op drop must run before the re-settle'],
    ['putting step ${restore} back', "curate's restore loop must run before the re-settle"],
  ]) {
    const at = src.indexOf(marker);
    assert.ok(at >= 0, `run.mjs should still log ${JSON.stringify(marker)} — this guard reads its position`);
    assert.ok(at < settle, why);
  }
  // ...and the flow that is actually recorded is the settled one.
  assert.match(src.slice(settle, settle + 400), /steps: settled\.steps/);
});

// ── ENG-5766: the whole of planPacing, over a fake transport ──────────────
//
// `paceFloors` covers the no-voiceover path, but the `max()` that composes a
// hold with a measured line lives inside `planPacing`, and so does the
// substitution that an invented line triggers. Both are new arithmetic on the
// number handed straight to the recorder, so neither should be reachable only
// by reading the source.

/** Voice a line without paying for TTS: duration proportional to its length. */
const fakeSpeak = (text, out) => {
  writeFileSync(out, '');
  return +(text.length / 20).toFixed(2);
};

test('a held payoff gets the floor; a line longer than the floor keeps its own length', async () => {
  const { planPacing, HOLD_FLOOR_SEC, NARRATION_GAP_SEC } = require('../src/pacing.js');
  const outDir = tmp();
  const short = 'Now hit Generate.';                                  // ~0.85s + gap
  const long = 'x'.repeat(200);                                       // 10s + gap
  const dir = fakeClaude([short, long].join('\n'));
  const steps = [
    { action: 'click', locator: 'role=button[name="Generate"i]', why: 'run it', beat: 'payoff', pace: 'hold' },
    { action: 'click', locator: 'role=button[name="Share"i]', why: 'share', beat: 'build', pace: 'hold' },
  ];
  const out = await withFakeClaude(dir, () =>
    planPacing({ goal: 'g', steps, outDir, speak: fakeSpeak, voice: 'v', model: 'm' })
  );

  // A SHORT line on a held step is raised to the floor...
  assert.ok(fakeSpeak(short, path.join(outDir, 'probe')) + NARRATION_GAP_SEC < HOLD_FLOOR_SEC,
    'the fixture must actually exercise the floor, or this asserts nothing');
  assert.equal(out.stepMinDurations[0], HOLD_FLOOR_SEC);

  // ...and a LONG one is not truncated to it. `max()`, not a replacement: a
  // floor that overrode the measured line would cut the voiceover off.
  const measured = fakeSpeak(long, path.join(outDir, 'probe')) + NARRATION_GAP_SEC;
  assert.ok(measured > HOLD_FLOOR_SEC, 'the fixture must exceed the floor too');
  assert.equal(out.stepMinDurations[1], measured);
});

test('an unheld step is paced by its line alone, exactly as before the edit existed', async () => {
  const { planPacing, NARRATION_GAP_SEC } = require('../src/pacing.js');
  const outDir = tmp();
  const line = 'Now hit Generate.';
  const dir = fakeClaude(line);
  const out = await withFakeClaude(dir, () =>
    planPacing({
      goal: 'g',
      steps: [{ action: 'click', locator: 'role=button[name="Generate"i]', why: 'run it' }],
      outDir, speak: fakeSpeak, voice: 'v', model: 'm',
    })
  );
  assert.equal(out.stepMinDurations[0], fakeSpeak(line, path.join(outDir, 'probe')) + NARRATION_GAP_SEC);
});

test('an invented line is replaced before it is ever voiced', async () => {
  const { planPacing } = require('../src/pacing.js');
  const outDir = tmp();
  // The second line names a control this flow cannot show.
  const dir = fakeClaude([
    'Let\'s start by hitting "Generate" to build the deck.',
    'Now click "Invite teammate" to bring the rest of the team in.',
  ].join('\n'));
  const steps = [
    { action: 'click', locator: 'role=button[name="Generate"i]', why: 'run it' },
    { action: 'click', locator: 'role=button[name="Share"i]', why: 'share it' },
  ];
  const out = await withFakeClaude(dir, () =>
    planPacing({ goal: 'g', steps, outDir, speak: fakeSpeak, voice: 'v', model: 'm' })
  );

  // The good line survives untouched.
  assert.match(out.spoken[0].text, /hitting "Generate"/);
  // The bad one never reaches TTS — it is the `humanizeAction` sentence built
  // from the resolved element, which is plain rather than confidently wrong.
  assert.ok(!out.spoken[1].text.includes('Invite teammate'));
  assert.match(out.spoken[1].text, /Share/);

  // ...and it is written down, so the take carries what was replaced and why.
  const record = JSON.parse(readFileSync(path.join(outDir, 'pacing.json'), 'utf8'));
  assert.equal(record.inventions.measured, true);
  assert.equal(record.inventions.inventions.length, 1);
  assert.equal(record.inventions.inventions[0].quoted, 'Invite teammate');
});

test('the flow author\'s own narration outranks the invention check', async () => {
  const { planPacing } = require('../src/pacing.js');
  const outDir = tmp();
  const dir = fakeClaude('Now click "Nonexistent control" to continue.');
  const out = await withFakeClaude(dir, () =>
    planPacing({
      goal: 'g',
      // A human wrote this line. It cannot have invented anything, and a
      // machine finding must not discard it.
      steps: [{ action: 'click', locator: '#go', why: 'go', narration: 'Here is the part I care about.' }],
      outDir, speak: fakeSpeak, voice: 'v', model: 'm',
    })
  );
  assert.equal(out.spoken[0].text, 'Here is the part I care about.');
});

test('the runner can describe an edit it was not allowed to make', () => {
  const { describeEdit } = require('../src/edit.js');
  // `plan` is null whenever the flow was too short to edit, and the inline
  // version of this read `edit.plan.map(...)` — so every run on a two-action
  // outcome demo died in the log line, after paying for the model call and
  // before recording anything.
  const flow = { goal: 'g', steps: [
    { action: 'fill', locator: '#p', text: 'hi' },
    { action: 'click', locator: 'role=button[name="Go"i]' },
  ] };
  const edit = disposeEdit({ flow, proposal: {
    about: 'a QR code appears as you type',
    decisions: [{ index: 0, keep: false, why: 'cut it' }],
  } });
  assert.equal(edit.plan, null, 'the premise: a short flow gets no plan');
  const lines = describeEdit(edit, flow.steps.length);
  assert.ok(lines.some((l) => l.includes('a QR code appears as you type')));
  assert.ok(lines.some((l) => /nothing to cut — 2 step\(s\)/.test(l)));
});

test('the runner says so when no edit was proposed at all', () => {
  const { describeEdit } = require('../src/edit.js');
  assert.deepEqual(describeEdit(null, 4), ['no edit proposed — recording the flow as discovered']);
});

// ── ENG-5766 review round 1: three holes Codex found ──────────────────────

test('a reorder may not move a step across a wait, because replaying is not meaning', () => {
  // The walk was doing all the disposing, and a walk establishes that steps
  // still EXECUTE, not that they still mean the same thing. Moving the click
  // that starts a generation to after the wait that guards it replays fine —
  // the thing being waited for is simply not there yet — and the recording
  // then races the result and can end mid-generation.
  const steps = [
    { action: 'click', locator: 'role=button[name="Prompt"i]' },
    { action: 'fill', locator: '#p', text: 'a launch deck' },
    { action: 'wait', quietMs: 3000, maxMs: 120000, why: 'generating' },
    { action: 'click', locator: 'role=button[name="Download"i]' },
  ];
  const all = (order) => ({
    about: 'x',
    decisions: steps.map((_, index) => ({ index, keep: true, beat: 'build', pace: 'normal' })),
    order,
  });

  const across = disposeEdit({ flow: { goal: 'g', steps }, proposal: all([3, 0, 1, 2]) });
  assert.deepEqual(across.plan.map((p) => p.sourceIndex), [0, 1, 2, 3], 'source order is kept');
  assert.equal(across.reordered, false);
  assert.match(across.corrections.join(' '), /moves step\(s\) 3 across a wait/);

  // Within a segment it may still permute freely — which is the whole
  // capability on a flow with no waits at all.
  const within = disposeEdit({ flow: { goal: 'g', steps }, proposal: all([1, 0, 2, 3]) });
  assert.deepEqual(within.plan.map((p) => p.sourceIndex), [1, 0, 2, 3]);
  assert.equal(within.reordered, true);
});

test('a line may not name a control that has not appeared yet', () => {
  const flow = { steps: [
    { action: 'click', locator: 'role=button[name="Generate"i]' },
    { action: 'click', locator: 'role=button[name="Share"i]' },
  ] };
  // Checking against the WHOLE flow let a line spoken over Generate say
  // click "Share" and pass, purely because a later step had a Share control.
  const forward = checkInventions({ lines: ['Now click "Share" to send it.', 'And hit "Generate".'], flow });
  assert.deepEqual(forward.inventions.map((i) => i.quoted), ['Share']);

  // A BACK reference is fine — it is already on screen, and a false positive
  // here replaces a good line.
  const back = checkInventions({ lines: ['Hit "Generate".', 'Now send that "Generate" result with "Share".'], flow });
  assert.deepEqual(back.inventions, []);
});

test('a step with no resolved element gets the bland line, not the agent\'s reason', () => {
  const { humanizeAction } = require('../src/narration.js');
  // `pacing.js` always sets `name`, so `name: ''` means "this step resolved no
  // element identity". Falling through to the label there put the discovery
  // model's reason straight back into the voiceover — through the one path
  // that the don't-invent check FALLS BACK TO, which is the worst place for it.
  assert.equal(
    humanizeAction({ type: 'click', name: '', label: 'go to the thing' }),
    "Let's move on to the next step."
  );
  // A resolved name is still used...
  assert.equal(humanizeAction({ type: 'click', name: 'Share', label: 'share it' }), "Now, let's click on Share.");
  // ...and a RECORDED action, which sets no `name` at all, keeps the
  // selector-then-label fallback: a keypress genuinely has no element.
  assert.equal(
    humanizeAction({ type: 'click', selector: 'role=button[name="Create"i]', label: 'x' }),
    "Now, let's click on Create."
  );
  assert.equal(humanizeAction({ type: 'click', label: 'Enter' }), "Now, let's click on Enter.");
});

test('the invented-line fallback cannot reintroduce the reason it was replacing', async () => {
  const { planPacing } = require('../src/pacing.js');
  const outDir = tmp();
  const dir = fakeClaude('Now click "Nonexistent" to continue.');
  const out = await withFakeClaude(dir, () =>
    planPacing({
      goal: 'g',
      // A CSS locator: no accessible name to fall back to.
      steps: [{ action: 'click', locator: '#go', why: 'let me try the other link' }],
      outDir, speak: fakeSpeak, voice: 'v', model: 'm',
    })
  );
  assert.ok(!out.spoken[0].text.includes('Nonexistent'), 'the invented name is gone');
  assert.ok(!out.spoken[0].text.includes('other link'), 'and the reason did not take its place');
  assert.equal(out.spoken[0].text, "Let's move on to the next step.");
});

// ── ENG-5766 review round 2 ───────────────────────────────────────────────

test('a short control name does not validate every quoted phrase that contains it', () => {
  // The matcher was `n.includes(q) || q.includes(n)` on normalized strings,
  // which FAILS OPEN — worse than not checking, because it returns
  // `measured: true, inventions: []` and reads as a clean pass. And short
  // names are the common case.
  const named = (...names) => ({
    steps: names.map((n) => ({ action: 'click', locator: `role=button[name="${n}"i]` })),
  });
  const flagged = (flow, line) => checkInventions({ lines: [line], flow }).inventions.length === 1;

  assert.ok(flagged(named('Go'), 'Open "Google Drive" and pick a file.'), '"Go" must not validate "Google Drive"');
  assert.ok(flagged(named('Go'), 'Click "Let us get going" first.'), 'nor a sentence that merely contains it');
  assert.ok(flagged(named('OK'), 'Check "look at the results" below.'));
  assert.ok(flagged(named('Share'), 'Send it with "Share to Google Drive".'), 'a real name plus invented text');

  // ...while every legitimate shape still passes.
  const ok = (flow, line) => assert.deepEqual(checkInventions({ lines: [line], flow }).inventions, [], line);
  ok(named('Go'), 'Hit "Go" now.');                                   // exact
  ok(named('Create a new canvas'), 'Just hit "Create".');             // the quote is part of the name
  ok(named('Share'), 'Hit the "Share" button.');                      // the name is the quote
  ok(named('Share'), 'Use "the Share button" up top.');               // wrapped in function words
  ok(named('Invite teammate'), 'Click "Invite teammate" to add them.');
});

test('the caption and the narration resolve the SAME name, in every selector form', () => {
  // The third copy of the extractor lived in `captions.js` and matched
  // `name="..."` alone, so on a single-quoted or regex-form locator the
  // narration spoke the element name while the caption resolved nothing and
  // emitted no caption at all — the divergence between the two writers that
  // the shared extractor exists to end.
  const { deriveCaption } = require('../src/captions.js');
  for (const [selector, expected] of [
    ['role=button[name="Create"i]', 'Create'],
    ["role=button[name='Try again'i]", 'Try again'],
    ['role=button[name=/Retry/i]', 'Retry'],
  ]) {
    assert.equal(nameFromSelector(selector), expected, `narration resolves ${selector}`);
    const caption = deriveCaption({ type: 'click', selector });
    assert.ok(caption && caption.includes(expected), `caption resolves ${selector} — got ${JSON.stringify(caption)}`);
  }
  // The local parts of captions' resolver survive: a `text=` fallback, and
  // null rather than '' for a selector with no identity at all.
  assert.ok(deriveCaption({ type: 'click', selector: 'text=Create' }).includes('Create'));
  assert.equal(deriveCaption({ type: 'click', selector: '#nameless' }), null);
});

test('narrate.js leaves behind no re-export shim for the moved extractor', () => {
  // CLAUDE.md: moving a module means updating callers, not leaving a shim.
  // Nothing in the package consumed `narrate.elementName` — the tests import
  // from `element-name.js` directly.
  const narrate = require('../src/narrate.js');
  assert.equal(narrate.elementName, undefined);
  assert.equal(typeof require('../src/element-name.js').elementName, 'function');
});

test('run.mjs does not edit a flow someone wrote by hand', () => {
  const src = readFileSync(path.join(HERE, 'run.mjs'), 'utf8');
  // `--flow` is an explicit step list. Having a model cut those steps as
  // "transport" overrides a decision already made, with a log line as the only
  // signal — and `take.mjs` already assumed the opposite in its own comment.
  assert.match(src, /const handAuthored = Boolean\(flowPath && flowPath === flag\('--flow', null\)\)/);
  assert.match(src, /handAuthored \? null : proposeEdit\(/);
  // The two paths must agree about what a hand-authored flow means.
  const take = readFileSync(path.join(HERE, 'take.mjs'), 'utf8');
  assert.match(take, /Absent on a hand-authored `--flow`/);
});

test('a secret never reaches a model prompt, the sayable names, or the voiceover', () => {
  const { isSensitive, safeText } = require('../src/sensitive.js');
  const { describeStep } = require('../src/edit.js');
  const { humanizeAction } = require('../src/narration.js');

  const secrets = [
    { action: 'fill', locator: '#password', text: 'hunter2' },
    { action: 'fill', locator: 'role=textbox[name="API key"i]', text: 'whatever' },
    { action: 'fill', locator: 'role=textbox[name="One-time code"i]', text: '123456' },
    // ...and by VALUE, whatever it was typed into.
    { action: 'fill', locator: '#prompt', text: 'sk-abcdefghijklmnopqrstuvwx' },
    { action: 'fill', locator: '#prompt', text: 'ghp_abcdefghijklmnopqrstuvwxyz0123' },
    { action: 'fill', locator: '#prompt', text: 'AKIAIOSFODNN7EXAMPLE' },
  ];
  for (const s of secrets) {
    assert.ok(isSensitive(s), `${s.locator} / ${s.text} should be sensitive`);
    assert.equal(safeText(s), null);
    // 1. the editorial prompt
    const shown = describeStep(s, 0);
    assert.ok(!shown.includes(s.text), `the editor prompt must not carry ${JSON.stringify(s.text)}`);
    assert.match(shown, /a secret — withheld/);
    // 2. what a script is allowed to quote — the VALUE is gone. The field's
    //    own label is not: "API key" is printed on screen, and a line saying
    //    "paste your API key here" is both true and useful. It is the thing
    //    typed into it that must never be spoken.
    const sayable = [...sayableNames({ steps: [s] })];
    assert.ok(!sayable.some((n) => n.includes(s.text.toLowerCase().slice(0, 8))),
      `${JSON.stringify(s.text)} must not be sayable — got ${JSON.stringify(sayable)}`);
    // 3. the spoken fallback
    const spoken = humanizeAction({ type: 'fill', name: '', text: safeText(s) });
    assert.ok(!spoken.includes(s.text));
    assert.equal(spoken, "Next, let's type in our text.");
  }

  // An ordinary prompt is untouched — the guard must not redact the demo.
  const ordinary = { action: 'fill', locator: '#prompt', text: 'a launch deck for Q4' };
  assert.equal(isSensitive(ordinary), false);
  assert.match(describeStep(ordinary, 0), /a launch deck for Q4/);
  assert.ok([...sayableNames({ steps: [ordinary] })].length > 0);
  // ...and a click types nothing, so it can leak nothing.
  assert.equal(isSensitive({ action: 'click', locator: '#password' }), false);
});

test('a fill\'s fallback line says typing, not clicking', () => {
  const { humanizeAction } = require('../src/narration.js');
  // The reference called this action `type`; every flow here calls it `fill`,
  // so the typing sentence was unreachable and a fill fell through to the
  // CLICK branch — "Now, let's click on Prompt." over footage of typing. A
  // confidently wrong sentence from the fallback whose job is to be the safe
  // one, and the line the don't-invent check replaces an invention WITH.
  assert.equal(
    humanizeAction({ type: 'fill', name: 'Prompt', text: 'a launch deck' }),
    'Next, let\'s type in \u201Ca launch deck\u201D.'
  );
  assert.ok(humanizeAction({ type: 'type', name: 'Prompt', text: 'x' }).startsWith("Next, let's type in"));
  assert.equal(humanizeAction({ type: 'click', name: 'Share' }), "Now, let's click on Share.");
});

test('the secret does not reach the narration model\'s prompt either', async () => {
  const { planPacing } = require('../src/pacing.js');
  const outDir = tmp();
  const dir = fakeClaude('Now enter your key.');
  const secret = 'sk-abcdefghijklmnopqrstuvwx';
  await withFakeClaude(dir, () =>
    planPacing({
      goal: 'connect the integration',
      steps: [
        { action: 'fill', locator: 'role=textbox[name="API key"i]', text: secret, why: 'paste the key' },
        { action: 'click', locator: 'role=button[name="Connect"i]', why: 'connect' },
      ],
      outDir, speak: fakeSpeak, voice: 'v', model: 'm',
    })
  );
  // This is the boundary that matters most and the one nothing else covers:
  // `describeStep` guards the EDITOR's prompt, but the script model gets its
  // own, built in `pacing.js`.
  const user = readFileSync(path.join(dir, 'user.txt'), 'utf8');
  assert.ok(!user.includes(secret), 'the script prompt must not carry the typed secret');
  // The field's own label still goes, because it is on screen and the script
  // needs it to say anything specific at all.
  assert.match(user, /element: "API key"/);
});

// ── ENG-5766 review round 3 ───────────────────────────────────────────────

test('a non-Latin name is checked, not waved through', () => {
  // `[^a-z0-9]` stripped every character of a Japanese, Chinese, Cyrillic or
  // Greek name, so a quoted non-Latin control normalized to '', tokenized to
  // nothing, and `supported()` returned true on the spot — `measured: true`
  // with no inventions, for a name matching nothing on screen. The same
  // fail-open the word-run matcher closed, reintroduced for every
  // internationalized app.
  const named = (n) => ({ steps: [{ action: 'click', locator: `role=button[name="${n}"i]` }] });

  const jp = checkInventions({ lines: ['まず “作成する” を押します。'], flow: named('設定') });
  assert.equal(jp.measured, true);
  assert.deepEqual(jp.inventions.map((i) => i.quoted), ['作成する']);
  assert.deepEqual(checkInventions({ lines: ['まず “設定” を押します。'], flow: named('設定') }).inventions, []);

  const ru = checkInventions({ lines: ['Нажмите “Удалить”.'], flow: named('Создать') });
  assert.deepEqual(ru.inventions.map((i) => i.quoted), ['Удалить']);
  assert.deepEqual(checkInventions({ lines: ['Нажмите “Создать”.'], flow: named('Создать') }).inventions, []);

  // A fragment with no letters or digits is not a claim about a control, and
  // is not COUNTED — reporting it as checked would claim coverage this guard
  // does not have.
  const punct = checkInventions({ lines: ['Wait for it “…” then go.'], flow: named('Создать') });
  assert.equal(punct.checked, 0);
  assert.equal(punct.measured, false);
});

test('a password field is redacted even when its selector says nothing', () => {
  const { isSensitive, safeText } = require('../src/sensitive.js');
  // The resolver prefers a test id or a stable id, so `<input id="login"
  // type="password">` reaches the flow as `#login` — and `hunter2` matches no
  // credential shape. No amount of guessing downstream could recover that, so
  // the fact is carried from resolution, where the element was in hand.
  const stamped = { action: 'fill', locator: '#login', text: 'hunter2', sensitive: true };
  assert.equal(isSensitive(stamped), true);
  assert.equal(safeText(stamped), null);
  // The heuristic alone cannot see it — which is exactly why the stamp exists.
  assert.equal(isSensitive({ action: 'fill', locator: '#login', text: 'hunter2' }), false);
});

test('the password fact survives EVERY path that can return a selector', () => {
  // Scoped to the whole module, not to `pageResolve`.
  //
  // Scanning one function was itself the bug: `resolveDurableSelector`'s
  // csspath fallback returned a bare `{type, selector}` and dropped the stamp,
  // and this guard could not see it because it only ever read the other
  // function. A password field whose role selector happened to be ambiguous —
  // two similar inputs in one form, i.e. a sign-in page — silently lost the
  // fact that keeps its value out of two model prompts and the voiceover.
  const src = readFileSync(path.join(HERE, 'src', 'snapshot.js'), 'utf8');

  assert.match(src, /const sensitive =\s*\n?\s*kind === 'password'/);
  assert.match(src, /one-time-code/);

  // Every return of a selector object, wherever it is, carries the fact —
  // either through `pageResolve`'s wrapper or by naming it explicitly.
  const returns = [...src.matchAll(/return (out\()?\{ type: [^}]*\}/g)];
  assert.ok(returns.length >= 7, `expected every selector return, found ${returns.length}`);
  for (const [whole, wrapped] of returns) {
    const stamped = wrapped === 'out(' || /\bsensitive:/.test(whole);
    assert.ok(stamped, `a selector return drops the password stamp: ${whole.slice(0, 90)}`);
  }
});

test('discovery carries the stamp onto the flow step', () => {
  const src = readFileSync(path.join(HERE, 'src', 'discovery.js'), 'utf8');
  assert.match(src, /durable\.sensitive \? \{ sensitive: true \} : \{\}/);
});

// ── ENG-5766: the Claude guideline review (rubric 10.7) ───────────────────

test('an HTML name attribute is not an accessible name', () => {
  // `snapshot.js`'s resolver emits the plain CSS attribute form for any
  // element with an HTML `name` and no test id or stable id (branch 3, ahead
  // of the role= branch). An HTML `name` is a form-field KEY — nothing with
  // that text is necessarily on screen — and matching `name=` anywhere pulled
  // "email" out of it and handed it to three consumers as the resolved
  // element name.
  //
  // Self-confirming, which is what made it worth a rubric item: the
  // don't-invent guard, whose whole job is to catch a name that is not on
  // screen, was reading the same bad source and would have licensed a line
  // saying `click "email"`.
  assert.equal(nameFromSelector('input[name="email"]'), '');
  assert.equal(nameFromSelector('textarea[name="body"]'), '');
  assert.equal(stepName({ action: 'fill', locator: 'input[name="email"]' }), '');
  assert.deepEqual([...sayableNames({ steps: [{ action: 'click', locator: 'input[name="email"]' }] })], []);

  // ...while every shape that DOES carry an accessible name still resolves.
  assert.equal(nameFromSelector('role=button[name="Create"i]'), 'Create');
  assert.equal(nameFromSelector("role=button[name='Try again'i]"), 'Try again');
  assert.equal(nameFromSelector('role=textbox[name=/API key/i]'), 'API key');

  // And the other selector shapes the resolver emits stay empty, as the
  // docstring has always claimed.
  for (const sel of ['[data-testid="go"]', '#login', '[placeholder="Search"]', 'div:has-text("Create")']) {
    assert.equal(nameFromSelector(sel), '', sel);
  }
});

test('the caption writer inherits the same rule, so the two still agree', () => {
  const { deriveCaption } = require('../src/captions.js');
  // `captions.js` had the bug too — its own regex matched `name=` anywhere.
  // Delegating to the shared extractor fixed both at once, and no caption is
  // the honest answer here: `deriveCaption` says so itself.
  assert.equal(deriveCaption({ type: 'click', selector: 'input[name="email"]' }), null);
  assert.ok(deriveCaption({ type: 'click', selector: 'role=button[name="Create"i]' }).includes('Create'));
});

test('the closing line is checked too — it is the last thing the video says', async () => {
  const { planPacing } = require('../src/pacing.js');
  const flow = { steps: [
    { action: 'click', locator: 'role=button[name="Generate"i]', why: 'run it' },
    { action: 'click', locator: 'role=button[name="Share"i]', why: 'share it' },
  ] };

  // `checkInventions` examined `script.lines` only. The conclusion is voiced
  // and muxed as the LAST thing the video says — the most quotable sentence in
  // it — and the run reported full coverage while never having looked.
  const bad = checkInventions({
    lines: ['Hit "Generate".'],
    flow,
    closing: 'Find it all under "Team Settings".',
  });
  assert.equal(bad.closing.quoted, 'Team Settings');
  assert.equal(bad.checked, 2, 'the closing line counts toward coverage as well');

  // Its scope is the WHOLE flow: it summarises a finished demo, so nothing in
  // it is a forward reference. "Share" is step 1 and would be an invention on
  // line 0 — here it is fine.
  assert.equal(checkInventions({ lines: [], flow, closing: 'That is how you "Share" a deck.' }).closing, null);

  // End to end: an inventing conclusion is DROPPED rather than replaced. There
  // is no action to build a fallback sentence from, and the pipeline already
  // handles having no conclusion.
  const outDir = tmp();
  const dir = fakeClaude('Hit "Generate".\nThen hit "Share".', 'Find it all under "Team Settings".');
  const out = await withFakeClaude(dir, () =>
    planPacing({ goal: 'g', steps: flow.steps, outDir, speak: fakeSpeak, voice: 'v', model: 'm' })
  );
  assert.equal(out.conclusion, null, 'an inventing conclusion must not be voiced');
  assert.equal(JSON.parse(readFileSync(path.join(outDir, 'pacing.json'), 'utf8')).inventions.closing.quoted,
    'Team Settings');

  // ...while a truthful one still is.
  const okDir = tmp();
  const good = fakeClaude('Hit "Generate".\nThen hit "Share".', 'That is how you "Share" a deck.');
  const kept = await withFakeClaude(good, () =>
    planPacing({ goal: 'g', steps: flow.steps, outDir: okDir, speak: fakeSpeak, voice: 'v', model: 'm' })
  );
  assert.ok(kept.conclusion && kept.conclusion.text.includes('Share'));
});

test('a wait the guard restores does not keep the reason for cutting it', () => {
  // Measured on a real flow: the editor proposed cutting two generation waits
  // with "Redundant generation wait" and "Renderer retry is an agent
  // reliability hedge, not a product moment". The guard kept both — and the
  // plan then recorded those as the reasons they were KEPT. That text is what
  // the log prints, what `pacing.json` stores, and what a human reviewing the
  // edit reads (ENG-5762); a record that argues against its own decision is
  // worse than a blank one.
  const flow = { goal: 'g', steps: [
    { action: 'click', locator: 'role=textbox[name="prompt"i]' },
    { action: 'fill', locator: '#p', text: 'a post' },
    { action: 'click', locator: 'role=button[name="Send"i]' },
    { action: 'wait', quietMs: 3000, maxMs: 120000 },
  ] };
  const out = disposeEdit({ flow, proposal: { about: 'x', decisions: [
    { index: 0, keep: true, beat: 'hook', pace: 'normal', why: 'the premise' },
    { index: 1, keep: true, beat: 'build', pace: 'normal', why: 'the ask' },
    { index: 2, keep: true, beat: 'payoff', pace: 'hold', why: 'it delivers' },
    { index: 3, keep: false, why: 'Redundant generation wait' },
  ] } });
  const restored = out.plan.find((p) => p.sourceIndex === 3);
  assert.ok(restored, 'the wait must survive');
  assert.match(restored.why, /kept to stay in sync/);
  // The editor's argument is preserved, but framed as what it was — a request
  // that was overruled, not a justification for keeping the step.
  assert.match(restored.why, /the edit wanted it cut: Redundant generation wait/);
  // A wait the editor never argued about gets no editorialising either way.
  const quiet = disposeEdit({ flow, proposal: { about: 'x', decisions: [
    { index: 0, keep: true, beat: 'hook', pace: 'normal' },
    { index: 1, keep: true, beat: 'build', pace: 'normal' },
    { index: 2, keep: true, beat: 'payoff', pace: 'hold' },
    { index: 3, keep: false },
  ] } });
  assert.equal(quiet.plan.find((p) => p.sourceIndex === 3).why, 'kept to stay in sync with the product');
});

// ── the brand card, against the REAL `brand show --json` shape (ENG-6306) ──
//
// This read had NO coverage, and that is how it shipped broken: it took the
// mark from `logo.file_id`, which is the internal structured-data name. The
// public endpoint rebuilds each image as `{name, id, uuid, url}` — `id` being
// the encoded `file_` ref — so every logo resolved to null, the mark vanished
// from every close page, and a kit whose only content is a logo lost its close
// page entirely. Zero exit, no warning. The fixtures below are that wire shape.

const { cardFromKit } = require('../src/outro.js');

/** One group, one wordmark, shaped exactly as `_public_logo_groups` emits it. */
const KIT = {
  default_color_mode: 'light',
  colors: [
    { label: 'bg-primary', color: '#ffffff', mode: 'light' },
    { label: 'text-primary', color: '#0a090a', mode: 'light' },
    { label: 'bg-primary', color: '#111111', mode: 'dark' },
  ],
  logos: [
    {
      group_name: 'Primary',
      images: [{ name: 'Logo (Dark)', id: 'file_01HZX9K2ABCDEFGHJKMNPQRSTV', uuid: 'u', url: 'https://x/y.png' }],
    },
  ],
  tagline: 'Design, delegated',
  company_url: 'https://moda.app',
};

test('the mark is the durable file_ id from the PUBLIC `id` field', () => {
  const card = cardFromKit(KIT);
  assert.strictEqual(card.logoFileId, 'file_01HZX9K2ABCDEFGHJKMNPQRSTV');
  // The shape carries no `file_id` at all — asserting that is what stops a
  // future edit reaching for the internal name again.
  assert.strictEqual(KIT.logos[0].images[0].file_id, undefined);
  assert.match(card.logoFileId, /^file_[0-9A-HJKMNP-TV-Z]{26}$/, 'must satisfy the server FILE_REF pattern');
});

test('an image whose File row did not validate becomes NO mark, not a bad one', () => {
  // `_public_logo_groups` omits `id` and sets `url_unavailable` for these. A
  // close page with no mark is fine; one pointing at nothing is not.
  const card = cardFromKit({
    ...KIT,
    logos: [{ group_name: 'Primary', images: [{ name: 'Logo (Dark)', url: null, url_unavailable: true }] }],
  });
  assert.strictEqual(card.logoFileId, null);
});

test('a kit with no logos at all still yields a usable card', () => {
  const card = cardFromKit({ ...KIT, logos: [] });
  assert.strictEqual(card.logoFileId, null);
  assert.strictEqual(card.tagline, 'Design, delegated');
  assert.strictEqual(card.url, 'moda.app', 'the scheme is stripped');
});

test('the palette is read at the kit default MODE, not flattened', () => {
  // The recorded bug this guards: a flat label lookup kept whichever colour
  // came last and silently returned the dark-mode value, inverting the card.
  assert.strictEqual(cardFromKit(KIT).background, '#ffffff');
  assert.strictEqual(cardFromKit(KIT).ink, '#0a090a');
});

// ── the framing inverse against an INSET clip (ENG-6306) ──
//
// The published camera is in PAGE space: every position keyframe is
// `clip.x + scale * clip.width * (0.5 - focus)`. Inverting it as though the
// clip WERE the page is right only on the full-bleed lane. On a composed page
// the recovered shot centre comes out hundreds of px off, and the framing
// verdict flips BOTH ways — a correctly framed punch-in reports "THE CLICK IS
// OUTSIDE THE SHOT", and a genuinely mis-framed one reads ok.

const { checkShots: checkShotsClip } = require('../src/shot-check.js');

/** The landscape layout's real numbers for a 1280x800 capture. */
const INSET = { x: 380, y: 240, width: 1160, height: 725 };

/** A camera that centres `focus` (normalized) at `scale`, emitted page-space.
 *
 * CLAMPED like the real emitter: `frame_offset` bounds the slide to what keeps
 * the scaled clip covering its own box, so an edge focus stops flush. Without
 * the clamp this fixture would be a program the emitter cannot produce, and
 * the framing it exercises would be unreachable.
 */
function programFor(focus, scale, clip) {
  const off = (extent, f) => {
    const wanted = scale * extent * (0.5 - f);
    const limit = ((scale - 1) * extent) / 2;
    return Math.min(limit, Math.max(wanted, -limit));
  };
  const path = [
    { tMs: 0, value: { x: clip.x, y: clip.y } },
    { tMs: 2000, value: { x: clip.x + off(clip.width, focus.x), y: clip.y + off(clip.height, focus.y) } },
  ];
  return [
    'motion.page("p", (t) => {',
    '  t.clearTarget("n");',
    `  t.keyframes("n", "scale", ${JSON.stringify([{ tMs: 0, value: 1 }, { tMs: 2000, value: scale }])});`,
    `  t.motionPath("n", ${JSON.stringify(path)});`,
    '});',
  ].join('\n');
}

function shotsFor(program, clipBox, click = { x: 320, y: 600 }) {
  const dir = mkdtempSync(path.join(tmpdir(), 'shot-clip-'));
  const motion = path.join(dir, 'p.motion.js');
  writeFileSync(motion, program);
  const doc = {
    durationSec: 6,
    viewport: { width: 1280, height: 800 },
    actions: [
      {
        index: 0, type: 'click', label: 'Generate',
        startSec: 1.6, endSec: 3, clickSec: 2.0,
        // The click the camera is centring on.
        clickX: click.x, clickY: click.y,
        provenance: 'observed',
      },
    ],
  };
  return checkShotsClip({ doc, outDir: dir, id: 'p', motionPath: motion, cameraWasAttempted: true, clipBox });
}

test('an INSET clip: framing is judged against the clip box, not the page', () => {
  // A click NEAR THE EDGE, deliberately. The rule is `slack < 0.15`, i.e. bad
  // once the click sits more than 0.7 of the half-extent from the shot centre
  // — 224px at scale 2. The page-vs-clip inverse error grows toward the right
  // edge (130 + 120·focus px here), so a mid-frame click is misjudged by ~160px
  // and stays INSIDE the shot: the first cut of this test used one and could
  // not tell the two inverses apart. At focus 0.9 the error is ~412px.
  const click = { x: 1152, y: 400 }; // 0.9 / 0.5 of a 1280x800 recording
  const program = programFor({ x: 0.9, y: 0.5 }, 2.0, INSET);
  const right = shotsFor(program, INSET, click);
  const wrong = shotsFor(program, null, click); // the pre-fix behaviour: clip == page

  assert.ok(right.zoomFraming.measured, 'the framing check did not run');
  assert.ok(
    !right.zoomFraming.bad,
    `a correctly framed punch-in was reported bad: ${JSON.stringify(right.zoomFraming.offenders)}`
  );
  // The discriminator: without the clip box the SAME program is misjudged, so
  // this test cannot pass for the wrong reason.
  assert.ok(
    wrong.zoomFraming.bad,
    'inverting against the page judged this program the same — the test proves nothing'
  );
});

test('the FULL-BLEED lane is unchanged by the clip-aware inverse', () => {
  // The control. clipBox omitted must behave exactly as clip == page.
  const full = { x: 0, y: 0, width: 1280, height: 800 };
  const program = programFor({ x: 0.25, y: 0.75 }, 2.0, full);
  const click = { x: 320, y: 600 };
  const omitted = shotsFor(program, null, click);
  const explicit = shotsFor(program, full, click);
  assert.deepEqual(omitted.zoomFraming, explicit.zoomFraming);
  assert.ok(!omitted.zoomFraming.bad, 'a centred punch-in on the full-bleed lane must still be well framed');
});

// ── the contradiction finding (ENG-6375) ─────────────────────────────────────
//
// The critique could always SEE that the film asserted something the screen
// denied; it had no way to say so. The observed run published a film whose 90px
// headline promised an endpoint that "lets Claude Code design in Moda" over a
// screen reading "read-only filesystem over all Moda documentation", and the
// grader's own summary called it a success.

test('a contradiction is carried from the cut it describes, like the score', () => {
  const critique = { score: 4, issues: [], contradiction: { claim: 'c', screen: 's', atSeconds: 1 } };

  // No iterate run: the critique's own finding stands.
  assert.deepStrictEqual(keptReport({ kept: null, critique }).contradiction,
    { claim: 'c', screen: 's', atSeconds: 1 });

  // Iterated: the KEPT round wins, because a later round's finding is about a
  // cut that was reverted.
  const kept = { score: 7, issues: [], contradiction: { claim: 'k', screen: 'ks', atSeconds: 2 } };
  assert.strictEqual(keptReport({ kept, critique }).contradiction.claim, 'k');

  // A kept cut that was CLEAN must not inherit the last critique's finding.
  assert.strictEqual(
    keptReport({ kept: { score: 7, issues: [], contradiction: null }, critique }).contradiction, null,
    'a clean kept cut must not inherit an older critique\'s contradiction');

  // An unreconciled report has no findings at all, this one included.
  assert.strictEqual(keptReport({ kept: { reconciled: false }, critique }).contradiction, null);
});

test('a contradiction does NOT refuse selection — it is a finding, not a gate', () => {
  // Deliberate, and measured: over seven runs against the film it was written
  // for the detector fired 6 times and named the real defect 3, and its
  // false-positive rate against a truthful film is unmeasured. That is enough
  // to spend a walk on and not enough to hold a publish. This test exists so
  // the refusal is not added back without that measurement.
  assert.strictEqual(
    canSelect({ outDir: '/tmp/x', usable: true, contradiction: { claim: 'c', screen: 's' } }), true,
    'a contradiction must not block publication until its false-positive rate is measured');
  assert.strictEqual(canSelect({ outDir: '/tmp/x', usable: false, contradiction: null }), false,
    'the unreconciled refusal must still stand');
});

test('both critique paths ask the truth question, and both normalise the answer', () => {
  // A TWO-SIDED SEAM, and this file has already paid for getting it wrong once:
  // `assertGenrePassed` exists because a fact was guarded on the video path and
  // not the frame path — and frames is the DEFAULT, since no GEMINI_API_KEY
  // means frames. A criterion on one side only is a check that is off for most
  // runs.
  const { buildPrompt, sheetPrompt, admissibleContradiction } = require('../src/critique.js');
  for (const [name, p] of [
    ['video', buildPrompt('g', null, false, true, true)],
    ['frames', sheetPrompt('g', 20, '/tmp/s.png', 2, null, true)],
  ]) {
    assert.match(p, /CONTRADICTS? them/, `${name}: must ask whether the screen contradicts the claims`);
    assert.match(p, /"contradiction":/, `${name}: must offer the slot to answer in`);
    assert.match(p, /return null/, `${name}: must allow "nothing wrong" without inventing one`);
  }

  // The normaliser is what stands between a hallucinated key and the loop.
  // BOTH quotes are required: the design is that the grader shows its evidence,
  // and a finding with no evidence is the waving this exists to replace.
  for (const junk of [null, undefined, {}, 'x', [], { claim: 'a' }, { screen: 'b' }, { claim: '', screen: 'b' }]) {
    assert.strictEqual(admissibleContradiction(junk), null, `must reject ${JSON.stringify(junk)}`);
  }
  assert.deepStrictEqual(admissibleContradiction({ claim: ' a ', screen: 'b', atSeconds: 'x' }),
    { claim: 'a', screen: 'b', atSeconds: null }, 'trims, and refuses a non-numeric timestamp');
});

test('the contradiction survives to the consumer that reads it', () => {
  // THE BUG THIS CLASS KEEPS HAVING. `keptReport` reads the field off
  // `iterate.json`, falling back to `critique.json` — and when this was first
  // wired NEITHER writer persisted it, so the whole feature resolved to null at
  // every call site while every unit test passed.
  const critiqueTake = readFileSync(path.join(HERE, 'critique-take.mjs'), 'utf8');
  assert.match(critiqueTake, /contradiction: verdict\.contradiction \?\? null/,
    'critique-take must persist the contradiction into critique.json');

  const iterate = readFileSync(path.join(HERE, 'iterate.mjs'), 'utf8');
  assert.match(iterate, /contradiction: critique\.contradiction \?\? null/,
    'iterate must capture the KEPT round\'s contradiction');
  assert.match(iterate, /contradiction: best\.contradiction \?\? null/,
    'iterate must persist it into iterate.json');

  // And run.mjs has to fold it into the findings, or it reaches nothing.
  const run = readFileSync(path.join(HERE, 'run.mjs'), 'utf8');
  assert.match(run, /if \(report\.contradiction\)/,
    'run.mjs must turn the contradiction into a flow finding');
  // The SHARED constant, not a literal. `run.mjs` creates the finding and
  // `nextStep` matches on it; spelled out in both, a rename would leave the
  // early exit matching nothing, and the symptom is a contradicted film quietly
  // reported "good enough" — the exact defect this change exists to remove.
  assert.match(run, /type: CONTRADICTION_FINDING/,
    'run.mjs must tag the finding with the shared constant, not a literal');
  assert.match(run, /CONTRADICTION_FINDING \} = require\('\.\/src\/kept-report\.js'\)/,
    'and import it from the module that matches on it');

  // And it has to be SAID. critique-take's own warning is swallowed — iterate
  // captures its stdout — so an operator on the documented entry point would
  // otherwise find a contradicted film reported nowhere.
  assert.match(iterate, /contradicts the screen/, 'iterate must print it per round');
  assert.match(run, /it contradicts the screen/, 'run must print it beside the attempt score');

  // `graded` may be set ONLY where critique.json actually parsed. Inferred from
  // a null contradiction instead, an ungraded take reads as truthful.
  assert.match(run, /let graded = false;/, 'run.mjs must default an attempt to ungraded');
  assert.match(run, /graded = report\.usable;/,
    'and may only mark it graded from a parsed, reconciled report');
  assert.match(run, /usable, graded, contradiction/, 'and must return it for the comparator');
});

test('a contradiction stops the loop calling a take good enough', () => {
  // THE CASE THE FEATURE EXISTS FOR, and it was inert: `nextStep` returned
  // 'reached-target' before it ever looked at the findings. The dangerous film
  // is the WELL-MADE one — ENG-6375 records "layout, camera, captions and
  // pacing were all fine; the film simply demonstrates the wrong feature" — so
  // it scores at or above target, and the loop would append the finding and
  // stop on the line above it with attempts still unspent.
  const contradicted = [{ type: CONTRADICTION_FINDING, severity: 'high', fix: 're_record' }];
  assert.strictEqual(
    nextStep({ usable: true, score: 9, flowFindings: contradicted, target: 8, n: 1, attempts: 3 }),
    're-record', 'a contradicted take is never "good enough", however well made');
  assert.strictEqual(
    nextStep({ usable: true, score: 9, flowFindings: [], target: 8, n: 1, attempts: 3 }),
    'reached-target', 'and a clean one still stops — the control for the line above');

  // It defeats the early exit, NOT the attempt budget: the loop must still end.
  assert.strictEqual(
    nextStep({ usable: true, score: 9, flowFindings: contradicted, target: 8, n: 3, attempts: 3 }),
    'out-of-attempts', 'it must not loop past the budget');

  // Defeating `reached-target` is a different decision from refusing to
  // publish, and only the first is taken: see canSelect.
  assert.strictEqual(canSelect({ outDir: '/tmp/x', usable: true, contradiction: { claim: 'c', screen: 's' } }),
    true, 'stopping the loop must not have become a publish gate');
});

test('a truthful retake displaces a contradicted one that scored higher', () => {
  // The re-walk was DECORATIVE without this. `nextStep` spends another attempt
  // on a contradiction, but selection ranked on score alone — and ENG-6375's
  // premise is that the contradicted film is well made ("layout, camera,
  // captions and pacing were all fine"), so it scores high. A truthful retake
  // would have had to out-score it to displace it, and a clean 7 losing to a
  // contradicted 8 republishes the lie while reporting the re-walk as done.
  const contradicted = { outDir: '/tmp/a', usable: true, graded: true, score: 8,
    contradiction: { claim: 'c', screen: 's' } };
  const cleanerButWorse = { outDir: '/tmp/b', usable: true, graded: true, score: 7,
    contradiction: null };

  assert.strictEqual(betterTake(cleanerButWorse, contradicted), true,
    'a truthful take must win even a point down');
  assert.strictEqual(betterTake(contradicted, cleanerButWorse), false,
    'and the contradicted one must not win it back');

  // Within a class, score still decides — the control for the line above.
  assert.strictEqual(betterTake({ ...cleanerButWorse, score: 9 }, cleanerButWorse), true);
  assert.strictEqual(betterTake({ ...cleanerButWorse, score: 5 }, cleanerButWorse), false);
  assert.strictEqual(betterTake({ ...contradicted, score: 9 }, contradicted), true,
    'two contradicted takes still rank by score — this is a preference, not a refusal');

  // A TIE-BREAK, NOT A GATE: with nothing else on offer the contradicted take
  // is still selected and still publishes. That is the decision the
  // measurement supports; `canSelect` stays open.
  assert.strictEqual(betterTake(contradicted, null), true,
    'a contradicted take must still be publishable when it is all there is');

  // The refusal that IS a gate must survive inside the new predicate.
  assert.strictEqual(betterTake({ outDir: '/tmp/c', usable: false, score: 10 }, cleanerButWorse), false,
    'an unreconciled report must never win, at any score');
});

test('an UNGRADED take is not mistaken for a truthful one', () => {
  // The regression the tie-break introduced, caught by both reviewers. An
  // attempt can record and never be graded — `critiqueFrames` shells out to the
  // `claude` CLI, so a missing binary, a rate limit or a non-JSON reply leaves
  // no critique.json — and `attemptOnce` deliberately keeps it selectable at
  // score 0. Read as "no contradiction" it counts as truthful, displaces a
  // graded 8/10, and the run publishes the ungraded cut reporting `done (0/10)`:
  // strictly worse than the score-only ranking it replaced.
  //
  // "Asked and found nothing" and "never asked" must not look alike — which is
  // what critique-take.mjs says where it writes the field, and what this test
  // exists to keep true here.
  const gradedContradicted = { outDir: '/tmp/a', usable: true, graded: true, score: 8,
    contradiction: { claim: 'c', screen: 's' } };
  const ungraded = { outDir: '/tmp/b', usable: true, graded: false, score: 0, contradiction: null };

  assert.strictEqual(betterTake(ungraded, gradedContradicted), false,
    'an ungraded take must not beat a graded one on a question it was never asked');

  // Still selectable when it is the only artifact — the point is the ordering,
  // not a new refusal.
  assert.strictEqual(betterTake(ungraded, null), true,
    'an ungraded take must still be selectable when nothing else is');

  // And the tie-break must still work between two GRADED takes: the control
  // that stops this being fixed by disabling the preference outright.
  const gradedClean = { outDir: '/tmp/c', usable: true, graded: true, score: 7, contradiction: null };
  assert.strictEqual(betterTake(gradedClean, gradedContradicted), true,
    'the preference must survive between two graded takes');

  // An ungraded take out-scoring a graded one still wins on score, exactly as
  // before this change — nothing here was meant to alter that.
  assert.strictEqual(betterTake({ ...ungraded, score: 9 }, gradedContradicted), true);
});

test('preferring truth over polish is BOUNDED, and the comparator is antisymmetric', () => {
  // Unbounded, this was not the weak intervention its own docstring claimed.
  // Cleanliness deciding outright means a false positive on a 9/10 hands the
  // run to whatever the retake produced — a 2/10 with blank screens, or (since
  // keptReport resolves a missing score to 0) a graded take with no score at
  // all — and publishes the materially worse film while reporting the re-walk
  // as done. That is the same mis-reported success the change exists to remove.
  const dirty = (score) => ({ outDir: '/tmp/a', usable: true, graded: true, score,
    contradiction: { claim: 'c', screen: 's' } });
  const clean = (score) => ({ outDir: '/tmp/b', usable: true, graded: true, score,
    contradiction: null });

  assert.strictEqual(TRUTH_OVER_POLISH, 2, 'the margin is a judgement; changing it is a decision');

  // Inside the margin the truthful take wins, including exactly AT it.
  assert.strictEqual(betterTake(clean(7), dirty(8)), true, 'one point down still wins');
  assert.strictEqual(betterTake(clean(6), dirty(8)), true, 'exactly at the margin still wins');
  // Past it, it does not — this is the row that fails on an unbounded preference.
  assert.strictEqual(betterTake(clean(5), dirty(8)), false, 'past the margin it does not');
  assert.strictEqual(betterTake(clean(0), dirty(9)), false,
    'a materially worse film must not ship on an unmeasured false positive');

  // Symmetric from the other side: a contradicted take displaces a truthful one
  // only by beating it by MORE than the margin.
  assert.strictEqual(betterTake(dirty(8), clean(7)), false);
  assert.strictEqual(betterTake(dirty(9), clean(7)), false, 'exactly the margin is not enough');
  assert.strictEqual(betterTake(dirty(10), clean(7)), true, 'beyond it, craft wins');

  // ANTISYMMETRY across the whole grid. A comparator where both sides can win
  // makes `best` depend on attempt order, which is invisible until it bites.
  for (let a = 0; a <= 10; a++) {
    for (let b = 0; b <= 10; b++) {
      for (const da of [true, false]) {
        for (const db of [true, false]) {
          const A = da ? dirty(a) : clean(a);
          const B = db ? dirty(b) : clean(b);
          assert.ok(!(betterTake(A, B) && betterTake(B, A)),
            `both win: ${a}/${da ? 'dirty' : 'clean'} vs ${b}/${db ? 'dirty' : 'clean'}`);
        }
      }
    }
  }
});

// ── the conclusion is WRITTEN, not spoken (ENG-6354) ─────────────────────────
//
// A spoken conclusion overruns the footage, so `finish.mjs` freezes the final
// frame to let it finish. ENG-6306 made the brand card a PAGE after the
// recording, so that freeze now plays in full and the film's last sentence
// lands on a static screenshot of the app.

test('the conclusion decision is one predicate, at every boundary', () => {
  // Round 1 found the two stages re-deriving it differently — close enough to
  // read as one rule and not one rule. Now there is a single function, tested
  // on BEHAVIOUR rather than on the source text: the old guards matched the
  // literal expressions, which cannot see a semantic divergence and break on a
  // reformat.
  const { chooseConclusion, MAX_WRITTEN_CHARS } = require('../src/conclusion.js');
  const line = 'That is the whole handoff.';

  assert.strictEqual(chooseConclusion({ pacing: { conclusion: { text: line } }, brandId: 'b1' }).written, line);
  assert.strictEqual(chooseConclusion({ pacing: { conclusion: { text: line } }, brandId: null }).written, null,
    'no brand means no close card to write it on, so it stays spoken');
  assert.strictEqual(chooseConclusion({ pacing: {}, brandId: 'b1' }).written, null);
  assert.strictEqual(chooseConclusion({ pacing: { conclusion: { text: '   ' } }, brandId: 'b1' }).written, null,
    'a blank line is not a conclusion');

  // THE 422 THIS EXISTS TO PREVENT. The server caps the card at 140, and a
  // model-authored wrap-up over that is routine. Sent blind it aborts the
  // publish AFTER the upload and AFTER finish dropped the line from the audio
  // — no film and no spoken line. It falls back to spoken instead.
  assert.strictEqual(chooseConclusion({ pacing: { conclusion: { text: 'y'.repeat(MAX_WRITTEN_CHARS) } }, brandId: 'b' }).written,
    'y'.repeat(MAX_WRITTEN_CHARS), 'exactly at the cap is still written');
  const over = chooseConclusion({ pacing: { conclusion: { text: 'y'.repeat(MAX_WRITTEN_CHARS + 1) } }, brandId: 'b' });
  assert.strictEqual(over.written, null, 'one character over falls back to spoken, never to a failed publish');
  assert.match(over.reason, /characters/, 'and says why, with the measurement in it');
});

test('a missing conclusion record means SPOKEN, never a guess', () => {
  // The record is the contract between two processes. `capture.md` supports
  // running the stages standalone, so publish cannot assume it saw the same
  // ambient DEMO_BRAND finish did — it reads what finish wrote. An absent
  // record means finish never suppressed the line, so the audio carries it and
  // writing it on the card too would say it twice.
  const { recordConclusion, readConclusion } = require('../src/conclusion.js');
  const dir = mkdtempSync(path.join(tmpdir(), 'conclusion-'));

  assert.strictEqual(readConclusion(dir, 'take').written, null, 'no record reads as spoken');

  recordConclusion(dir, 'take', { written: null, reason: 'no brand' });
  assert.strictEqual(readConclusion(dir, 'take').written, null, 'a recorded SPOKEN decision also reads as spoken');

  recordConclusion(dir, 'take', { written: 'Written line.', reason: 'written' }, 'brand_a');
  assert.strictEqual(readConclusion(dir, 'take').written, 'Written line.');
  // THE BRAND TRAVELS WITH IT. The line was chosen against a particular kit,
  // and a publish run standalone against a different one is putting it on a
  // card nobody picked for it. Without this recorded, that is unnoticeable.
  assert.strictEqual(readConclusion(dir, 'take').brandId, 'brand_a');

  writeFileSync(path.join(dir, 'take.conclusion.json'), 'not json');
  assert.deepStrictEqual(readConclusion(dir, 'take'), { written: null, brandId: null },
    'an unreadable record is not a licence to guess');
});

test('a conclusion alone justifies a close page', () => {
  // THE LOSS CASE. `finish.mjs` stops speaking the line as soon as one is
  // written, so if a kit with no tagline, url or mark produced no close page,
  // the film's last sentence would be neither heard nor read — worse than the
  // frozen frame this replaces. The server's validator counts a headline as
  // sign-off content for the same reason; this is the CLI half of that pair.
  const publish = readFileSync(path.join(HERE, 'publish-take.mjs'), 'utf8');
  // SUFFICIENT ON ITS OWN, on BOTH gates. Round 2 found the record closing only
  // half the skew: the decision was read from it, but whether a close page
  // existed at all was still re-derived from the ambient DEMO_BRAND — so a
  // publish run standalone without it dropped the page and lost a line finish
  // had already removed from the audio.
  assert.match(publish, /if \(about \|\| card \|\| conclusion\) \{/,
    'a conclusion alone must be enough to build a composition');
  assert.match(publish, /\.\.\.\(conclusion \|\| \(card && \(card\.tagline \|\| card\.url \|\| card\.logoFileId\)\)/,
    'and enough to justify the close page');
  assert.match(publish, /\.\.\.\(conclusion \? \{ headline: conclusion \} : \{\}\)/,
    'and must be sent as the card headline');
  // ONE PROSE FIELD, not both. The server drops the tagline when a headline is
  // present and warns `close_tagline_dropped` — so sending both made that
  // advisory fire on every correct branded publish, which is how a warning
  // teaches its reader to ignore warnings.
  assert.match(publish, /card\?\.tagline && !conclusion \? \{ tagline: card\.tagline \} : \{\}/,
    'the tagline must not be sent alongside a headline the card will render instead');
  // AND THE DROP MUST STILL BE SAID. Withholding the tagline stops the
  // server's `close_tagline_dropped` firing on every correct run — and also
  // removes the only statement of the fact, so the kit's tagline silently
  // stops appearing on the card. The CLI is the one making the choice, so it
  // is the one that has to say so.
  assert.match(publish, /is not on the card/,
    'the CLI must report the tagline it withheld, since the server can no longer see it');

  // And publish must READ the record rather than re-deriving the decision.
  assert.match(publish, /readConclusion\(outDir, id\)/,
    'publish must consume what finish recorded, not decide again');
  // A brandless close page must not crash on a `card` that is now null.
  //
  // DERIVED, NOT LISTED. The first version of this named three properties and
  // claimed "every card read" — `card?.url` and `card?.ink` went unchecked,
  // and they are on the very path round 2 made reachable: a recorded
  // conclusion with no DEMO_BRAND leaves `card === null` while the conclusion
  // alone builds the page. Dropping a `?.` from either throws at the
  // composition step, after the upload and after finish cut the line from the
  // audio, with this guard still green. A covered subset that reads as full
  // coverage is the shape the rubric names.
  //
  // So the list comes out of the file: every property read off `card`, and
  // every line that reads one must also guard it on the same line.
  const props = [...new Set([...publish.matchAll(/card\??\.([A-Za-z_$][\w$]*)/g)].map((m) => m[1]))];
  assert.ok(props.length >= 5, `expected several card reads, found ${props.length}: ${props}`);
  // TWO guard forms are real, and both are used: `card?.prop`, and a `card &&`
  // that dominates the reads after it. A rule that only knew the first called
  // the (correct) page gate a bug, which is the wrong direction for a guard.
  for (const prop of props) {
    for (const line of publish.split('\n')) {
      const read = new RegExp(`(?<!\\?\\.)\\bcard\\.${prop}\\b`);
      if (!read.test(line)) continue;
      const guardedHere = new RegExp(`card\\?\\.${prop}\\b`).test(line);
      const dominated = /\bcard &&/.test(line) && line.indexOf('card &&') < line.search(read);
      assert.ok(guardedHere || dominated,
        `a null card would throw on card.${prop} here: ${line.trim()}`);
    }
  }
  const finish = readFileSync(path.join(HERE, 'finish.mjs'), 'utf8');
  assert.match(finish, /recordConclusion\(outDir, id, conclusionChoice, process\.env\.DEMO_BRAND \|\| null\)/,
    'finish must record what it actually did, AND the brand it decided against');
});

test('a rejected close page is not a successful publish when it carried the line', () => {
  // THE FIFTH ROUTE TO THE SAME LOSS. `publish_demo` turns a rejected
  // chrome-page markup write into a SUCCESSFUL publish — it hides the page and
  // reports `chrome_page_not_written`, which is right for a decorative card
  // and wrong for this one. finish has already left the conclusion out of the
  // audio by then, so a hidden close page ships a film carrying it neither
  // spoken nor written, and the command would exit 0 with the mp4 in hand.
  const publish = readFileSync(path.join(HERE, 'publish-take.mjs'), 'utf8');
  // MATCHED ON THE CARD, not the bare prefix. The warning is emitted per
  // rejected chrome page, so a rejected HOOK produced an identical prefix and
  // aborted a publish whose conclusion had written fine — a false diagnosis
  // about the wrong card, with the camera grading skipped after it.
  assert.match(publish, /startsWith\('chrome_page_not_written: close'\)/,
    'publish must distinguish a rejected CLOSE from a rejected hook');
  assert.match(publish, /^\s*conclusion &&$/m,
    'and must only treat it as fatal when the page was carrying the written line');
  // The matched warning carries the rejection REASON, and this check now runs
  // before the only place warnings are printed — so exiting without it would
  // tell an operator to fix markup while eating the explanation.
  assert.match(publish, /\.find\(\(w\) => w\.startsWith\('chrome_page_not_written: close'\)\)/,
    'the warning must be captured, not merely detected');
  assert.match(publish, /console\.error\(`\\n {2}\$\{closeRejected\}`\)/,
    'and printed, so the rejection reason survives the exit');
  assert.match(publish, /process\.exit\(1\)/, 'and must fail rather than report success');

  // BEFORE the artifact is handed over. The verb has already exported by the
  // time it returns, so the check cannot prevent the file existing — but it
  // must not follow the Desktop copy and the success lines.
  assert.ok(
    publish.indexOf("chrome_page_not_written: close") < publish.indexOf('copyFileSync(finalMp4'),
    'the fatal check must run before the mp4 is copied and announced'
  );

  // The remedy has to be performable. Re-running THIS stage does nothing: it
  // reads the decision finish recorded, so the line stays written and the
  // audio stays cut. Only finish re-decides.
  assert.match(publish, /Re-run `finish\.mjs` without DEMO_BRAND/,
    'the remedy must name the stage that can actually carry it out');
});

test('the brandless skew is announced, not only the two-brand one', () => {
  // The likelier skew, and the one round 2 made reachable: the record names a
  // brand and this publish has none, so the close page is built from the line
  // alone and keeps the words while losing the ground, ink and mark. The only
  // other hint is a missing clause in a summary line.
  const publish = readFileSync(path.join(HERE, 'publish-take.mjs'), 'utf8');
  assert.match(publish, /recorded\.brandId && recorded\.brandId !== brandId/,
    'the skew check must fire when this publish has no brand at all');
  assert.match(publish, /no mark, ground or ink/, 'and must say what the page lost');
});

test('a marketing cut has no spoken line to move, so nothing is written', () => {
  // The remedy is "written INSTEAD OF spoken", and on a marketing cut the
  // status quo is SILENCE, not a frozen frame: `finish.mjs` sets `planned =
  // []`, so planNarration never runs, nothing overruns and no tail is held.
  // Writing it anyway applied the fix where the defect cannot occur — and cost
  // the brand its tagline on the one genre defined as having no narration.
  //
  // Reachable and supported: DEMO_STYLE=marketing over a take pacing.js
  // recorded as a tutorial leaves pacing.conclusion.text populated while
  // finish builds a marketing cut.
  const { chooseConclusion } = require('../src/conclusion.js');
  const pacing = { conclusion: { text: 'That is the whole handoff.' } };

  const marketing = chooseConclusion({ pacing, brandId: 'b1', style: 'marketing' });
  assert.strictEqual(marketing.written, null, 'a marketing cut must not displace the tagline');
  assert.match(marketing.reason, /no voiceover/);

  // The control: every other genre still writes it, or the gate is just an off
  // switch.
  for (const style of ['tutorial', null, undefined]) {
    assert.strictEqual(chooseConclusion({ pacing, brandId: 'b1', style }).written,
      'That is the whole handoff.', `style ${String(style)} must still write it`);
  }

  // And finish must actually PASS the genre — the predicate cannot read it
  // otherwise, and the omission looked exactly like the working code.
  const finish = readFileSync(path.join(HERE, 'finish.mjs'), 'utf8');
  assert.match(finish, /chooseConclusion\(\{ pacing, brandId: process\.env\.DEMO_BRAND \|\| null, style: STYLE \}\)/,
    'finish must hand the genre to the choice');
});

test('the finish log never claims a spoken line the cut does not contain', () => {
  // On a marketing cut `planned` is `[]`, so the conclusion is in neither the
  // audio nor the card. The else-arm said "the closing line stays spoken",
  // which contradicted its own reason — and compounded the earlier line
  // announcing the conclusion's duration out of pacing.json, so a reader saw
  // two messages implying it was in the film.
  const finish = readFileSync(path.join(HERE, 'finish.mjs'), 'utf8');
  assert.ok(!/the closing line stays spoken/.test(finish),
    'the log must not assert a spoken line on a cut that has no narration');
  assert.match(finish, /dropped with the rest of the voiceover/,
    'a marketing cut must say the line went with the voiceover');
  assert.match(finish, /is not written on the close card/,
    'and every other spoken path must be phrased around the decision');

  // THE SIBLING MESSAGE, which the first pass of this fix did not re-ask.
  // `tailSec` comes from the last SPOKEN span, and once the conclusion is
  // written it is not in `planned` — so an ordinary step line overrunning
  // (normal here; `DEMO_DROP_LINES` exists for it) made the same run print
  // "WRITTEN on the close card" and then a NOTE swearing the conclusion landed
  // on a frozen app frame, citing a ticket already fixed.
  const note = finish.slice(finish.indexOf('s of frozen final frame') - 400);
  assert.match(note, /writeConclusion\s*\?/,
    'the frozen-tail NOTE must say WHICH line is holding the tail');
  assert.match(note, /the last STEP line can finish/,
    'and must not blame the conclusion when the conclusion is on the card');
});
