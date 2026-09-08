// Three defects that all shipped green, and the assertions that keep them fixed.
//
// Each was found by running the pipeline against Moda's own app rather than by
// reading the code, and each looked like something else from outside: a flow the
// gate "correctly" rejected, a stage that was "slow", a run that "failed".
//
//   node --test test/
const { test } = require('node:test');
const assert = require('node:assert');
const { readFileSync, readdirSync, statSync, mkdtempSync, existsSync, writeFileSync } = require('node:fs');
const { execFileSync } = require('node:child_process');
const { tmpdir } = require('node:os');
const path = require('node:path');

const { ffmpeg: FFMPEG, ffprobe: FFPROBE } = require('../src/bin.js');
const tmp = () => mkdtempSync(path.join(tmpdir(), 'demo-mux-'));

const { PRODUCT_BROWSER_ARGS, productLaunchOptions } = require('../src/browser.js');
const { narratedDurationSec } = require('../src/narrate.js');

const HERE = path.join(__dirname, '..');
const read = (rel) => readFileSync(path.join(HERE, rel), 'utf8');

// ── ENG-6108: every stage that touches the product launches the same browser ──

//: The ONE launch that legitimately skips the flags: outro.js renders a static
//: card from inlined HTML and never navigates to the product. Named as an
//: exemption rather than omitted from a list, so it has to be justified.
const NON_PRODUCT_LAUNCHERS = new Set(['src/outro.js']);

/**
 * Every source file in the tool. ONE walk, because both completeness gates below
 * need the same set: the ffmpeg stages live at the root (`finish.mjs`,
 * `publish-take.mjs`, `capture.mjs`) as well as in `src/`, so a scan scoped to
 * either one alone has a blind half.
 */
function sourceFiles() {
  const found = [];
  const walk = (dir, prefix = '') => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === 'out' || e.name === 'test' || e.name.startsWith('.')) continue;
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(dir, e.name), rel);
      else if (/\.(js|mjs)$/.test(e.name)) found.push(rel);
    }
  };
  walk(HERE);
  return found.sort();
}

/** Every file in the tool that launches a browser, found rather than listed. */
const launchSites = () => sourceFiles().filter((rel) => /chromium\.launch\(/.test(read(rel)));

test('every browser launch in the tool is derived, not listed', () => {
  // 3.24: a completeness gate that hand-lists today's files cannot see tomorrow's.
  // A sixth gate added with a bare launch would reintroduce ENG-6108 green.
  const sites = launchSites();
  assert.ok(sites.length >= 6, `expected to find the known launch sites, found ${sites.length}`);
  for (const rel of sites) {
    if (NON_PRODUCT_LAUNCHERS.has(rel)) continue;
    const src = read(rel);
    assert.match(
      src,
      /chromium\.launch\(\s*productLaunchOptions\(/,
      `${rel} must launch through productLaunchOptions() so it sees the product the camera records`
    );
    // The specific regression: a launch that spells its own options. Without
    // WebGPU, Moda's canvas shows a "could not initialize" modal whose overlay
    // eats every click, so a gate on a bare browser fails flows that record fine.
    assert.doesNotMatch(
      src,
      /chromium\.launch\(\s*\{/,
      `${rel} spells its own launch options — that is how the recorder and the gates drifted apart`
    );
  }
});

test('the outro exemption is real — it never navigates to the product', () => {
  // An exemption is a claim, so it gets checked too. outro.js may render its own
  // markup, but it must not visit a URL; the day it does, it needs the flags.
  const src = read('src/outro.js');
  assert.match(src, /setContent\(/, 'outro renders inlined HTML');
  assert.doesNotMatch(src, /page\.goto\(/, 'outro must not navigate — if it does it is a product launch');
});

test('the product launch carries the GPU flags, headless, and any caller extras', () => {
  const opts = productLaunchOptions();
  assert.strictEqual(opts.headless, true);
  for (const flag of ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--enable-gpu']) {
    assert.ok(opts.args.includes(flag), `missing ${flag}`);
  }
  // An override must ADD to the args, never replace them — replacing is the
  // silent way back to a GPU-less gate.
  const withExtra = productLaunchOptions({ args: ['--mute-audio'], timeout: 5000 });
  assert.ok(withExtra.args.includes('--mute-audio'));
  assert.ok(withExtra.args.includes('--enable-unsafe-webgpu'));
  assert.strictEqual(withExtra.timeout, 5000);
  assert.strictEqual(withExtra.headless, true);
});

test('the shared arg list cannot be mutated by one caller', () => {
  assert.throws(() => PRODUCT_BROWSER_ARGS.push('--boom'), TypeError);
  assert.strictEqual(PRODUCT_BROWSER_ARGS.length, 3);
});

// ── ENG-6109: the narrated mux is bounded ────────────────────────────────────

test('narratedDurationSec covers all three tail cases', () => {
  //: a closing line that runs past the footage extends it
  assert.strictEqual(narratedDurationSec({ clipEnd: 24.8, tailNeeded: 7.4, tailExcess: 0 }), 32.2);
  //: dead air after the last word gets trimmed off
  assert.strictEqual(narratedDurationSec({ clipEnd: 24.8, tailNeeded: 0, tailExcess: 4 }), 20.8);
  //: and an exact fit is the footage itself
  assert.strictEqual(narratedDurationSec({ clipEnd: 24.8, tailNeeded: 0, tailExcess: 0 }), 24.8);
});

test('the narration mux bounds its output instead of trusting -shortest', () => {
  const src = read('src/narrate.js');
  // Bare `apad` is an INFINITE audio stream. In a filter_complex graph the muxer
  // keeps pulling it after the video ends and `-shortest` does not stop it:
  // measured, ffmpeg spun at 99.7% CPU for 10+ minutes and wrote 137 MB for a
  // 24.8s take whose source is 430 KB, then died on "Cannot allocate memory".
  assert.doesNotMatch(src, /,apad\[aout\]/, 'apad must be bounded with whole_dur');
  assert.match(src, /apad=whole_dur=\$\{outDurSec\.toFixed\(3\)\}/);
  // ...and a hard stop in case the filter bound ever fails to hold.
  assert.match(src, /'-t',\s*outDurSec\.toFixed\(3\)/);
  // Both must read the SAME computed length, not two copies of the expression.
  assert.match(src, /const outDurSec = narratedDurationSec\(/);
});

test('no stage leaves an apad unbounded', () => {
  // narrate.js was the one that hung, but music.js runs immediately after it on
  // the same path with the same shape, latent only because its video side is
  // `-c:v copy`. Scanning the whole of src/ is the assertion that catches the
  // NEXT one; a check pinned to narrate.js would have passed all along.
  //: Comments discuss `apad` at length — including the ones explaining this very
  //: bug — so the scan is over CODE only.
  const codeOnly = (src) =>
    src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((l) => !/^\s*\/\//.test(l))
      .join('\n');

  // Over the WHOLE tool, not just src/: finish.mjs, publish-take.mjs and
  // capture.mjs all shell ffmpeg from the root, so a bare apad added there would
  // sit outside a src/-only scan.
  const offenders = [];
  for (const rel of sourceFiles()) {
    const src = codeOnly(read(rel));
    //: `apad` not immediately followed by `=` is the unbounded form.
    for (const m of src.matchAll(/apad(?![=\w])/g)) {
      offenders.push(`${rel}: ${src.slice(Math.max(0, m.index - 40), m.index + 20).replace(/\n/g, ' ')}`);
    }
  }
  assert.deepStrictEqual(offenders, [], 'every apad must carry whole_dur — a bare one is an infinite stream');
});

test('the music bed bounds its mux to the video it is copying', () => {
  const src = read('src/music.js');
  assert.match(src, /apad=whole_dur=\$\{videoSec\.toFixed\(3\)\}/);
  assert.match(src, /'-t', videoSec\.toFixed\(3\)/);
  // Both must come from the probe, not from a caller's guess about the length.
  assert.match(src, /const videoSec = durationOf\(mp4\)/);
});

test('the music mux encodes the voiced branch to the picture length', () => {
  // 6.8f: the hasVoice branch is the PRODUCTION-NORMAL one — finish.mjs hands
  // addMusicBed the narrated mp4 whenever narration exists — and it is the
  // branch carrying `apad=whole_dur` and the ducking expression, i.e. the exact
  // ENG-6109 shape. A video-only fixture takes `[bed]anull` instead and pins
  // none of it, which is what both other encode tests here were doing.
  const { addMusicBed } = require('../src/music.js');
  const dir = tmp();
  const withVoice = path.join(dir, 'voiced.mp4');
  const bed = path.join(dir, 'bed.mp3');
  const VID_SEC = 3;
  execFileSync(FFMPEG, ['-v', 'error',
    '-f', 'lavfi', '-i', `testsrc=duration=${VID_SEC}:size=160x120:rate=10`,
    '-f', 'lavfi', '-i', `sine=frequency=440:duration=${VID_SEC}`,
    '-pix_fmt', 'yuv420p', '-t', String(VID_SEC), withVoice, '-y']);
  //: a bed DELIBERATELY longer than the picture, so the bound has work to do
  execFileSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=200:duration=8', bed, '-y']);

  // ASSERT THE FIXTURE REACHES THE BRANCH. `hasAudio` is the predicate the
  // production code branches on; if this input had no audio track the test
  // would silently measure `[bed]anull` again.
  const aStreams = execFileSync(FFPROBE, ['-v', 'error', '-select_streams', 'a',
    '-show_entries', 'stream=index', '-of', 'csv=p=0', withVoice]).toString().trim();
  assert.ok(aStreams.length > 0, 'fixture must carry audio or it never takes the hasVoice branch');

  const out = addMusicBed({
    mp4: withVoice, outDir: dir, id: 'voiced', bed,
    narrationSpans: [{ startSec: 0.5, durationSec: 1 }],
  });
  const probed = +execFileSync(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration',
    '-of', 'default=nw=1:nk=1', out]).toString().trim();
  // The 8s bed must NOT extend the 3s picture, and the pad must not run on.
  assert.ok(Math.abs(probed - VID_SEC) < 0.25, `scored cut is ${probed.toFixed(2)}s, picture is ${VID_SEC}s`);
  assert.ok(statSync(out).size < 20 << 20, 'scored file is implausibly large — the mux is padding without end');
});

test('a rejected scored cut leaves no file behind to be published', () => {
  // Rejecting is not enough: finish.mjs catches the throw and continues, and
  // both its final-cut choice and publish-take prefer `.scored.mp4` because it
  // EXISTS. So the real assertion is about the filesystem after the failure.
  const { addMusicBed } = require('../src/music.js');
  const dir = tmp();
  const mp4 = path.join(dir, 'v.mp4');
  const bed = path.join(dir, 'bed.mp3');
  execFileSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i',
    'testsrc=duration=2:size=160x120:rate=10', '-pix_fmt', 'yuv420p', mp4, '-y']);
  execFileSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=300:duration=2', bed, '-y']);

  // A healthy run first — the rejection below must be the fixture's doing, not
  // a mux that cannot produce anything at all.
  const ok = addMusicBed({ mp4, outDir: dir, id: 'good', bed });
  assert.ok(existsSync(ok), 'the healthy path must produce a scored cut');

  // Now fail INSIDE the encode/verify block. The failure has to land after the
  // input probe, or the cleanup path is never entered and this test passes
  // whether or not it exists — which is exactly what a first version of it did.
  // A corrupt bed gets past `durationOf(mp4)` (proven by the healthy run above,
  // same mp4) and dies in ffmpeg.
  const rotten = path.join(dir, 'rotten.mp3');
  writeFileSync(rotten, 'this is not audio');
  // Stand a staging file up first. ffmpeg may die before writing anything, and
  // then "no file left behind" would be true for the wrong reason — the cleanup
  // would never run and the mutation that skips it would pass. This guarantees
  // there IS something to clean up when the failure lands.
  const stagingPath = path.join(dir, 'bad.scored.mp4.staging.mp4');
  writeFileSync(stagingPath, 'partial bytes from a mux that then failed');
  assert.ok(existsSync(stagingPath), 'fixture must present a staged file to clean up');
  assert.throws(() => addMusicBed({ mp4, outDir: dir, id: 'bad', bed: rotten }));
  assert.strictEqual(existsSync(path.join(dir, 'bad.scored.mp4')), false,
    'a rejected cut must not be left where publish will find it');
  assert.strictEqual(existsSync(stagingPath), false,
    'the staging file must be cleaned up too');
});

test('the music mux cannot shorten the picture', () => {
  const src = read('src/music.js');
  // `-t` caps the output; `-shortest` would additionally let a SHORT BED end the
  // encode early. On the no-voice path (every marketing-style take) the bed is
  // the only audio and its real length is never checked, so that would silently
  // cut the payoff frames — and `.scored.mp4` is what publish prefers.
  const argv = src.match(/execFileSync\(FFMPEG,[\s\S]*?\{ maxBuffer[^}]*\}\);/);
  assert.ok(argv, 'the music argv moved — re-point this test');
  assert.doesNotMatch(argv[0], /'-shortest'/, '-shortest can truncate the picture to a short bed');
  // And the length is verified rather than trusted, as in narrate.js — against
  // the staged file, before it is allowed to take the published name.
  assert.match(src, /const actualSec = durationOf\(staged\)/);
  assert.match(src, /renameSync\(staged, out\)/);
  assert.match(src, /the music mux changed the length/);
});

test('the mux terminates and emits a clip of the length it computed', () => {
  // 6.8f/10.1: the argv is intent. The bug was a mux that never terminated —
  // 10+ minutes of CPU and a 137 MB write — so this runs the REAL narrate() and
  // measures the artifact and the work, not the flags.
  //
  // It runs in a CHILD with a timeout on purpose: a reintroduced unbounded apad
  // hangs rather than fails, and a hung suite is worse in CI than a red one.
  const dir = tmp();
  const mp4 = path.join(dir, 'clip.mp4');
  const wav = path.join(dir, 'line.wav');
  const CLIP_SEC = 3;
  execFileSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i',
    `testsrc=duration=${CLIP_SEC}:size=320x240:rate=10`, '-pix_fmt', 'yuv420p', mp4, '-y']);
  execFileSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', wav, '-y']);

  // ASSERT THE FIXTURE REACHES THE BRANCH THAT HUNG. tpad only runs when the
  // closing line overruns the footage; a fixture that fits exercises `-c:v copy`
  // and would prove nothing about the case that broke.
  const planned = [{ text: 'a line that runs past the end', startSec: 2, durationSec: 2, wav }];
  const wantSec = narratedDurationSec({ clipEnd: CLIP_SEC, tailNeeded: 2 + 2 + 0.6 - CLIP_SEC, tailExcess: 0 });
  assert.ok(wantSec > CLIP_SEC, 'fixture must overrun the footage or it never takes the tpad path');

  const runner = `
    const { narrate } = require(${JSON.stringify(path.join(HERE, 'src', 'narrate.js'))});
    const r = narrate({ clip: { durationSec: ${CLIP_SEC} }, mp4: ${JSON.stringify(mp4)},
      outDir: ${JSON.stringify(dir)}, id: 'fixture',
      planned: ${JSON.stringify(planned)} });
    process.stdout.write(JSON.stringify({ mp4: r.mp4, durationSec: r.durationSec }));
  `;
  const started = Date.now();
  const out = execFileSync(process.execPath, ['-e', runner], {
    encoding: 'utf8', timeout: 120_000, killSignal: 'SIGKILL', maxBuffer: 16 << 20,
  });
  const elapsedSec = (Date.now() - started) / 1000;
  const res = JSON.parse(out);

  // The artifact: the emitted stream is the length the bound computed.
  const probed = +execFileSync(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration',
    '-of', 'default=nw=1:nk=1', res.mp4]).toString().trim();
  assert.ok(Math.abs(probed - wantSec) < 0.25,
    `emitted ${probed.toFixed(2)}s, computed ${wantSec.toFixed(2)}s`);

  // The work: the failure was unbounded CPU and an unbounded write. Both bounds
  // sit far above a healthy run (measured ~1s, well under 1 MB for this fixture)
  // and far below the pathological one (10+ min, 137 MB).
  const bytes = statSync(res.mp4).size;
  assert.ok(bytes < 20 << 20, `narrated file is ${(bytes / 1e6).toFixed(1)} MB — the mux is padding without end`);
  assert.ok(elapsedSec < 90, `mux took ${elapsedSec.toFixed(0)}s`);
});

// ── ENG-6110: a walk failure ends the attempt, not the run ───────────────────

test('a walk failure is a result with findings, not a bare null', () => {
  const src = read('run.mjs');
  // Every OTHER pre-recording failure already returned `{ outDir: null, …,
  // flowFindings }`; the walk was the one that returned `null`, so it was the
  // one failure the loop could neither learn from nor survive.
  assert.doesNotMatch(src, /\n\s*return null;/, 'attemptOnce must always return a result');
  assert.match(src, /type: 'walk_failed'/);
  // The reason has to reach the finding, or the next discovery is guided by a
  // constant and re-finds the same unwalkable flow.
  assert.match(src, /walk_failed', description:\s*\n?\s*`the flow could not be replayed: \$\{why\}/);
});

test('a final attempt that cannot walk still publishes the best earlier attempt', () => {
  const src = read('run.mjs');
  const anchor = src.indexOf('r = await attemptOnce');
  assert.notStrictEqual(anchor, -1, 'the attempt call moved — re-point this test');
  const loop = src.slice(anchor);
  // `process.exit(1)` used to fire here, BEFORE stage 7, discarding a finished
  // and scored cut from an earlier attempt.
  const nullBranch = loop.match(/if \(!r\)[^\n]*\n/);
  assert.strictEqual(nullBranch, null, 'the null-attempt branch is dead now that attemptOnce always returns');
  // The no-recording branch is what handles a failed attempt: guidance for the
  // next one, and on the last one a break INTO stage 7 rather than an exit.
  const noOutDir = loop.match(/if \(!r\.outDir\) \{[\s\S]*?\n  \}/);
  assert.ok(noOutDir, 'the no-recording branch moved — re-point this test');
  assert.doesNotMatch(noOutDir[0], /process\.exit/, 'a failed attempt must not exit before stage 7');
  assert.match(noOutDir[0], /if \(n === attempts\) break;/);
  assert.match(noOutDir[0], /writeFileSync\(guidancePath/);
  // Stage 7 is what legitimately refuses when nothing at all recorded, and it
  // has to stay for the branches above to be safe.
  assert.match(src, /if \(!best\)/);
  assert.match(src, /no attempt produced a recording/);
});

test('an attempt that throws does not take the best take down with it', () => {
  // Same harm as the walk failure by another route: a recorder or finisher that
  // dies mid-attempt would end the run before stage 7, discarding an earlier
  // attempt's finished cut. Only stage 7 decides the run has nothing to show.
  const src = read('run.mjs');
  const guarded = src.match(/try \{\s*\n\s*r = await attemptOnce\([\s\S]*?\n  \} catch \([\s\S]*?\n  \}/);
  assert.ok(guarded, 'the attempt call must be inside a try/catch that survives a throw');
  assert.match(guarded[0], /type: 'attempt_threw'/);
  assert.doesNotMatch(guarded[0], /process\.exit|throw /, 'a thrown attempt must become a failed attempt, not end the run');
});
