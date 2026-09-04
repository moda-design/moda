// The four defects a person keeps catching that the model does not.
//
// Every one of these came from kleo watching a take and naming something the
// critique had scored around: the cursor sitting on the text as it types, zooms
// out of sync with the clicks, zooms not framing where the click happened, and
// dead time while the product thinks. The frame critique samples about one still
// per second, so a 300ms timing error falls between samples every time, and a
// contact sheet cannot show occlusion that lasts exactly as long as the typing.
//
// All four are COUNTABLE from artifacts the pipeline already writes — the action
// timeline and the emitted camera program — so none of them needs a model, and
// none of them can be scored around.
const { existsSync, readFileSync } = require('node:fs');

//: A zoom whose peak misses its click by more than this reads as unsynced.
//: 0.12s is under half a sampled frame at 4fps and about four frames at 30.
const SYNC_TOLERANCE_SEC = 0.12;
//: How much of a captioned action's RESULT must be in frame while its caption
//: is up. Below this the video is announcing something the viewer cannot see.
const CAPTION_SUBJECT_COVERAGE = 0.5;

//: How far in from the nearest edge the click must sit, as a fraction of the
//: frame. Expressed this way because that is what a viewer sees: the camera
//: frames the RESULT box, so on an action whose result is far from its control
//: the click ends up technically in shot and visibly against the edge —
//: measured, a click at 8% of the frame height while the camera looked 229px
//: below it, which is what "the zoom is not aligned with where the click is
//: happening" describes. A first pass expressed this as a fraction of the
//: half-extent and read 0.163 for that same shot, which sounded fine.
//:
//: MIRRORED IN PYTHON. The planner aims for this same number:
//: backend/app/services/demo_video/zoom.py's ANCHOR_MARGIN, and the `slack`
//: computation below is mirrored there as `_anchor_slack`. Change either and the
//: pipeline argues with itself — every shot the planner considers well framed
//: gets reported as badly framed, or the reverse. The constant (not the formula)
//: is pinned by test_anchor_margin_matches_shot_check in
//: backend/tests/services/demo_video/test_zoom_emitter.py, which reads THIS file.
const FRAMING_MARGIN = 0.15;
//: Above this share of the runtime spent waiting, the demo is a loading screen.
const DEAD_TIME_SHARE = 0.25;
//: How much of an ongoing action may finish outside the shot framed to show it.
//: A punch-in that leaves while text is still appearing takes the viewer away
//: from the one thing the demo is doing.
const RELEASE_SLACK_SEC = 0.25;

/**
 * Is the camera showing what the caption is talking about?
 *
 * A CROSS-SIGNAL defect, and the reason it needs its own check: the caption
 * check says the text is readable, the framing check says the punch-in is on
 * target, both are right, and the pair is still wrong. Caught by a person
 * reading a contact sheet — "caption says 'Try Sunset' but the frame is zoomed
 * into the still-Midnight preview" — where every countable signal was clean.
 *
 * It happens because shots CHAIN. The camera stays in and pans between actions,
 * so during a caption's window it can still be framed on the previous action's
 * subject, and nothing that looks at one action at a time can see that.
 *
 * The camera state at a moment is the most recent keyframe at or before it: a
 * punch-in holds, so the held value is what is on screen.
 */
function captionSubjectVisible(camera, actions, w, h) {
  // ANY action with a measured result, captioned or not.
  //
  // This required a caption, and the marketing genre CLEARS every label — so on
  // marketing cuts it never ran at all, and marketing is the genre where the
  // screen has to speak for itself, i.e. where the camera showing the result is
  // the whole job. The gate excluded exactly the case it mattered for.
  //
  // Caught on a real take: two thirds of the runtime punched into the markdown
  // editor with the branded preview — the entire payoff — cropped to a sliver
  // at the frame edge, while this reported "not measured".
  const withCaption = actions.filter((a) => a.resultBox && a.startSec != null && a.endSec != null);
  if (!withCaption.length) {
    return { measured: false, reason: 'no action carries a measured result region' };
  }
  const stateAt = (t) => {
    let best = null;
    for (let i = 0; i < camera.scale.length; i++) {
      if (camera.scale[i].tMs / 1000 > t + 1e-6) break;
      best = i;
    }
    if (best == null) return { scale: 1, x: w / 2, y: h / 2 };
    return focusOf(camera.scale[best], camera.path[best], w, h) ?? { scale: 1, x: w / 2, y: h / 2 };
  };

  const offenders = [];
  for (const a of withCaption) {
    // Sampled across the window rather than at one instant: a chained pan can
    // arrive partway through, and a caption that is wrong for only its first
    // half is still wrong for that half.
    const samples = [0.25, 0.5, 0.75].map((f) => a.startSec + (a.endSec - a.startSec) * f);
    let worst = 1;
    let at = samples[0];
    for (const t of samples) {
      const cam = stateAt(t);
      const halfW = w / 2 / cam.scale;
      const halfH = h / 2 / cam.scale;
      const cx = Math.min(Math.max(cam.x, halfW), w - halfW);
      const cy = Math.min(Math.max(cam.y, halfH), h - halfH);
      const r = a.resultBox;
      const rx = r.x * w, ry = r.y * h, rw = r.width * w, rh = r.height * h;
      const ow = Math.max(0, Math.min(rx + rw, cx + halfW) - Math.max(rx, cx - halfW));
      const oh = Math.max(0, Math.min(ry + rh, cy + halfH) - Math.max(ry, cy - halfH));
      const cov = rw * rh > 0 ? (ow * oh) / (rw * rh) : 1;
      if (cov < worst) { worst = cov; at = t; }
    }
    if (worst < CAPTION_SUBJECT_COVERAGE) {
      offenders.push({ action: a.index, caption: a.label.trim(), atSec: +at.toFixed(2), shows: +(worst * 100).toFixed(0) });
    }
  }
  return { measured: true, captions: withCaption.length, offenders, bad: offenders.length > 0 };
}

/** Scale and translate keyframes from the emitted camera program. */
function readCamera(motionJsPath) {
  if (!existsSync(motionJsPath)) return null;
  const src = readFileSync(motionJsPath, 'utf8');
  const grab = (fn) => {
    const m = new RegExp(`t\\.${fn}\\("[^"]+",\\s*(?:"[^"]+",\\s*)?(\\[[\\s\\S]*?\\])\\);`).exec(src);
    if (!m) return null;
    try { return JSON.parse(m[1]); } catch { return null; }
  };
  const scale = grab('keyframes');
  const path = grab('motionPath');
  if (!scale || !path) return null;
  return { scale, path };
}

/**
 * Where the camera is actually looking, in page pixels, at each keyframe.
 *
 * The emitted transform is `translate = (viewportCentre - focus) * scale`, so
 * the focus is recovered by inverting it. Doing it this way checks what the
 * RENDERER will do rather than what the planner intended — a planner that
 * frames correctly and emits the wrong transform would pass the other way.
 */
function focusOf(scaleKf, pathKf, w, h) {
  if (!scaleKf || !pathKf || scaleKf.value <= 0) return null;
  return {
    atSec: scaleKf.tMs / 1000,
    scale: scaleKf.value,
    x: w / 2 - pathKf.value.x / scaleKf.value,
    y: h / 2 - pathKf.value.y / scaleKf.value,
  };
}

//: Two focus points closer than this are the same shot drifting, not a new one.
const NEW_SHOT_PX = 24;

/**
 * Every SHOT the camera takes, as `{ atSec, scale, x, y, releasedAtSec }`.
 *
 * A shot is not the same thing as a scale rise. The compiler CHAINS punch-ins:
 * when two actions are close together it stays zoomed in and PANS from one to
 * the next rather than bouncing out to rest between them. Counting only
 * keyframes whose scale went up therefore saw the first shot of a chain and
 * none of the others.
 *
 * That is not a miscount, it is a false clean. On a real take the camera zoomed
 * to frame a click, panned at 7.00s to frame the text field, and held there for
 * nine seconds while the prompt was typed 278px above the centre of frame —
 * jammed against the top edge. The report said "1 punch-in, all on target",
 * because the only shot it looked at was the one that happened to be fine.
 */
function shots(camera, w, h) {
  const out = [];
  let lastFocus = null;
  for (let i = 0; i < camera.scale.length; i++) {
    const s = camera.scale[i];
    const f = focusOf(s, camera.path[i], w, h);
    if (!f) continue;
    if (s.value <= 1.001) { lastFocus = null; continue; }
    const rose = !camera.scale[i - 1] || camera.scale[i - 1].value < s.value - 1e-6;
    const panned = lastFocus && Math.hypot(f.x - lastFocus.x, f.y - lastFocus.y) > NEW_SHOT_PX;
    lastFocus = f;
    if (!rose && !panned) continue;
    // When this shot stops showing what it framed: the next pan away, or the
    // return to rest, whichever comes first.
    let endsAt = null;
    for (let j = i + 1; j < camera.scale.length; j++) {
      const k = camera.scale[j];
      const g = focusOf(k, camera.path[j], w, h);
      if (k.value <= 1.001) { endsAt = k.tMs / 1000; break; }
      if (g && Math.hypot(g.x - f.x, g.y - f.y) > NEW_SHOT_PX) { endsAt = k.tMs / 1000; break; }
    }
    f.releasedAtSec = endsAt;
    out.push(f);
  }
  return out;
}

/**
 * Every countable shot defect in one take.
 *
 * Returns `{ deadTime, zoomSync, zoomFraming, cursorOcclusion }`. Each carries
 * `measured: false` with a reason rather than an empty list when it could not
 * run — an unmeasured check must never read as a clean one.
 */
function checkShots({ doc, outDir, id, motionPath = null, cameraWasAttempted = false }) {
  const w = doc.viewport?.width || 1280;
  const h = doc.viewport?.height || 800;
  const actions = doc.actions || [];
  const duration = doc.durationSec || 0;

  // ── dead time ────────────────────────────────────────────────────────────
  const waited = actions
    .filter((a) => a.type === 'wait')
    .reduce((n, a) => n + Math.max(0, (a.endSec ?? 0) - (a.startSec ?? 0)), 0);
  const share = duration > 0 ? waited / duration : 0;
  const deadTime = duration <= 0
    ? { measured: false, reason: 'the clip has no duration' }
    // Waits cannot outlast the clip that contains them. When they do, the
    // action times and the duration came from different cuts — seen for real
    // after a revert: 30.3s of waits inside a 19.9s clip, reported as "153%".
    // An impossible number is a broken input, not a finding, and saying so is
    // the difference between catching that and quietly reporting 153%.
    : waited > duration * 1.02
      ? { measured: false, reason: `the action times (${waited.toFixed(1)}s of waits) do not belong to this ${duration.toFixed(1)}s cut` }
      : { measured: true, seconds: waited, share, bad: share > DEAD_TIME_SHARE };

  // ── cursor occlusion ─────────────────────────────────────────────────────
  // A fill clicks into the middle of its field and types from the left, so the
  // cursor ends up on top of the sentence unless the capture hides it. The
  // capture records whether it did; absence of the flag is not proof of
  // absence of the problem, so an older take says "not measured".
  const fills = actions.filter((a) => a.type === 'fill');
  const cursorOcclusion = fills.length === 0
    // NOT a pass. "clear of the text while typing" on a take that never typed
    // is the same vacuous green as a test whose subject never ran.
    ? { measured: false, reason: 'nothing was typed in this take' }
    : fills.some((a) => a.cursorHiddenWhileTyping === undefined)
      ? { measured: false, reason: 'this take predates the cursor-visibility flag' }
      : {
          measured: true,
          offenders: fills.filter((a) => !a.cursorHiddenWhileTyping).map((a) => a.index),
          get bad() { return this.offenders.length > 0; },
        };

  // ── zoom sync and framing ────────────────────────────────────────────────
  // `motionPath` is how a caller grades a camera it did not compile locally: the
  // publish response carries the program for users with no studio checkout, and
  // it is written under a DIFFERENT name so `iterate`'s
  // `if (!existsSync(<id>.motion.js)) emitMotion()` still re-emits a fresh local
  // camera after a re-cut instead of grading a stale published one.
  const camera = readCamera(motionPath ?? `${outDir}/${id}.motion.js`);
  if (!camera) {
    // TWO different reasons, and saying the wrong one sends the reader looking
    // in the wrong place. The markup is written at publish; if it exists and the
    // motion program does not, publish DID run and the compiler planned no
    // punch-ins — every action's changed region was too large to frame above
    // the minimum worthwhile scale. Seen on a real take: four actions stayed
    // wide, no camera program, and all three zoom checks reported "emitted at
    // publish" on a take that had just been published.
    // Told by the caller, never inferred. This read `existsSync(<id>.markup.xml)`
    // and nothing has written that file since publishing became one server-side
    // verb — `compile.py markup` is its only writer and no .mjs invokes it — so
    // the predicate was permanently false and the flat-take finding below had
    // never once fired.
    //
    // "Attempted", not "published", so BOTH callers can answer truthfully: the
    // publish report knows a publish just ran, and the critique loop knows
    // whether `compile.py motion` ran and what it said. Naming it for publish
    // left the loop defaulting to false, which moved the deadness rather than
    // removing it.
    const published = cameraWasAttempted;
    const why = published
      ? 'the compiler planned NO punch-ins for this take — every action changed too much of the page to frame'
      : 'no camera program yet — these are emitted at publish';
    return {
      deadTime, cursorOcclusion,
      // A published take with no punch-ins is not an unmeasured camera, it is a
      // flat one: the whole video is a single wide shot with nothing directing
      // the eye. That is a finding, not a gap in instrumentation.
      noCamera: published ? { measured: true, bad: true, reason: why } : { measured: false, reason: why },
      zoomSync: { measured: false, reason: why },
      zoomFraming: { measured: false, reason: why },
      zoomRelease: { measured: false, reason: why },
    };
  }

  const peaks = shots(camera, w, h);
  const clicks = actions.filter((a) => a.clickSec != null && a.clickX != null);
  const syncOff = [];
  const framing = [];
  const releasedEarly = [];
  for (const p of peaks) {
    // Pair each peak with the click it is nearest to. The emitter does not
    // stamp an action index onto the program, and pairing by order breaks as
    // soon as one action is skipped for being unzoomable — which is common.
    let best = null;
    for (const c of clicks) {
      const d = Math.abs(c.clickSec - p.atSec);
      if (!best || d < best.d) best = { c, d };
    }
    if (!best) continue;
    if (best.d > SYNC_TOLERANCE_SEC) {
      syncOff.push({ action: best.c.index, peakSec: +p.atSec.toFixed(3), clickSec: best.c.clickSec, offSec: +(p.atSec - best.c.clickSec).toFixed(3) });
    }
    const halfW = w / 2 / p.scale;
    const halfH = h / 2 / p.scale;
    // Fraction of the half-extent left between the click and the frame edge.
    // Distance from the nearest frame edge, as a fraction of the whole frame.
    const edgeX = (1 - Math.abs(best.c.clickX - p.x) / halfW) / 2;
    const edgeY = (1 - Math.abs(best.c.clickY - p.y) / halfH) / 2;
    // Mirrored as `_anchor_slack` in backend/app/services/demo_video/zoom.py, where
    // the clamp is written out explicitly: here the focus read back off the
    // emitted transform is already clamped, there it is not yet.
    const slack = Math.min(edgeX, edgeY);
    // AN ACTION THAT IS STILL HAPPENING when the camera leaves. Typing is the
    // case that matters: the click only puts the caret in the field, and the
    // sentence takes seconds. Measured on a Moda take, typing ran 8.05s to
    // 14.28s and the camera was fully out at 9.32s — five seconds of the demo's
    // only text appearing outside the shot framed to show it. Every other check
    // was happy: the peak was on the click and the framing was on target.
    const endsAt = best.c.endSec;
    if (best.c.type === 'fill' && p.releasedAtSec != null && endsAt != null
        && p.releasedAtSec < endsAt - RELEASE_SLACK_SEC) {
      releasedEarly.push({
        action: best.c.index,
        releasedAtSec: +p.releasedAtSec.toFixed(3),
        actionEndsSec: +endsAt.toFixed(3),
        earlyBySec: +(endsAt - p.releasedAtSec).toFixed(3),
      });
    }
    if (slack < FRAMING_MARGIN) {
      framing.push({
        action: best.c.index,
        slack: +slack.toFixed(3),
        outOfFrame: slack < 0,
        clickAt: [best.c.clickX, best.c.clickY],
        lookingAt: [Math.round(p.x), Math.round(p.y)],
      });
    }
  }

  return {
    deadTime,
    cursorOcclusion,
    // Reaching here means a camera program parsed, so this IS measured and is
    // fine. Omitting the key made a caller that reports every check print "the
    // check did not run" next to a camera it had just graded — an unmeasured
    // reading on the one path where the answer is known.
    noCamera: { measured: true, bad: false, peaks: peaks.length },
    zoomSync: { measured: true, peaks: peaks.length, offenders: syncOff, bad: syncOff.length > 0 },
    zoomFraming: { measured: true, peaks: peaks.length, offenders: framing, bad: framing.length > 0 },
    captionSubject: captionSubjectVisible(camera, actions, w, h),
    zoomRelease: actions.some((a) => a.type === 'fill')
      ? { measured: true, peaks: peaks.length, offenders: releasedEarly, bad: releasedEarly.length > 0 }
      : { measured: false, reason: 'nothing was typed in this take' },
  };
}

module.exports = { checkShots, readCamera, SYNC_TOLERANCE_SEC, FRAMING_MARGIN, DEAD_TIME_SHARE, RELEASE_SLACK_SEC, CAPTION_SUBJECT_COVERAGE };
