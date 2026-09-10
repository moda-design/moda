// Idle-gap compression: speed up the stretches where nothing is happening — no
// action in progress AND no narration playing — so the demo does not hang on
// silent dead air.
//
// Ported from kleo's earlier pipeline, which had already solved this. Worth
// saying why it is not blocked, because I had it filed as blocked: proper
// re-pacing INSIDE the Moda canvas needs the `main_edit` export scope, which the
// public export API cannot request (ENG-5833). This never touches the canvas. It
// re-times the RECORDING before upload, so the canvas receives footage that is
// already paced and the export has nothing to decide.
//
// The load-bearing part is `rebaseClip`. Every timestamp downstream — caption
// windows, camera keyframes, narration offsets — is clip-relative, so the same
// piecewise map that re-times the video has to move them too. A compression that
// does not rebase silently slides every caption off the thing it describes.
const { execFileSync } = require('node:child_process');
const { ffmpeg: FFMPEG, ffprobe: FFPROBE } = require('./bin.js');
const { renameSync, copyFileSync, existsSync } = require('node:fs');
const path = require('node:path');

//: How much faster an idle gap plays. A knob because it is the cheapest
//: lever the iteration loop has: re-pacing needs no re-record and no upload.
const SPEED = Number(process.env.DEMO_COMPRESS_SPEED) || 6;
//: The ceiling the iteration loop bumps toward, and the reason a `dead_time`
//: finding can run out of remedy. Exported because the checker has to answer
//: "how much would another bump return?" and a second literal here would let
//: the two drift — the loop chasing a gap the report says is reachable at a
//: speed the loop will never use.
const MAX_SPEED = 14;
const BREATHING_SEC = 0.35;   // kept at 1x at the START of each gap, so it does not jerk
const MIN_GAP_SEC = 0.7;      // shorter gaps are left alone; speeding them just stutters
const POST_CLICK_KEEP = 0.6;  // after a click, for the result to register
const TAIL_KEEP = 2.0;        // the final beat is the reveal — never sped past
//: How much of a long `fill` stays at 1x at each end (ENG-6195). The head lets
//: the viewer see typing start; the tail leaves the finished prompt readable —
//: and the click that follows a prompt is itself protected, so the completed
//: text is on screen for the tail PLUS that action.
const TYPING_HEAD_KEEP = 1.0;
const TYPING_TAIL_KEEP = 1.0;
//: Below this a fill is already a beat and splitting it just stutters — the
//: same reason `MIN_GAP_SEC` exists. Derived, not a fourth tunable: the two
//: keeps plus the shortest gap worth speeding, so the middle is never smaller
//: than the minimum the segment builder would speed anyway.
const TYPING_MIN_COMPRESSIBLE = TYPING_HEAD_KEEP + TYPING_TAIL_KEEP + MIN_GAP_SEC;
//: The opening beat is DELIBERATE, not idle. Capture already trims the load down
//: to a lead-in chosen so the viewer can read the starting state; without this,
//: compression treats that lead-in as a gap and squeezes it — measured, 0.9s
//: became 0.44s, undoing the trim's own decision.
const HEAD_KEEP = 1.0;
const MIN_SAVING_SEC = 0.4;   // below this, a re-encode is not worth the quality cost
//: How much of a completion WAIT to keep at 1x — the tail, where the result
//: actually lands. The rest of a wait is the definition of dead air.
const WAIT_RESULT_KEEP = 1.6;

function mergeIntervals(intervals) {
  const iv = intervals.filter((x) => x && x[1] > x[0]).map((x) => [Math.max(0, x[0]), x[1]])
    .sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const [s, e] of iv) {
    const last = out[out.length - 1];
    if (last && s <= last[1] + 1e-6) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}

/** Contiguous [0, D] segments, each tagged 1x or fast. */
function buildSegments(duration, kept, fast) {
  const segs = [];
  const addGap = (s, e) => {
    if (e - s <= MIN_GAP_SEC) { segs.push({ oldStart: s, oldEnd: e, speed: 1 }); return; }
    const keepEnd = Math.min(e, s + BREATHING_SEC);
    if (keepEnd > s) segs.push({ oldStart: s, oldEnd: keepEnd, speed: 1 });
    segs.push({ oldStart: keepEnd, oldEnd: e, speed: fast });
  };
  let cursor = 0;
  for (const [ks, ke] of kept) {
    if (ks > cursor + 1e-6) addGap(cursor, ks);
    segs.push({ oldStart: Math.max(cursor, ks), oldEnd: ke, speed: 1 });
    cursor = ke;
  }
  if (cursor < duration - 1e-6) addGap(cursor, duration);

  let nt = 0;
  const out = [];
  for (const s of segs) {
    const oldDur = s.oldEnd - s.oldStart;
    if (oldDur <= 1e-3) continue;
    const newDur = oldDur / s.speed;
    out.push({ ...s, newStart: nt, newDur });
    nt += newDur;
  }
  return { segments: out, newDuration: nt };
}

function makeRemap(segments, oldDuration, newDuration) {
  return (t) => {
    if (t == null) return t;
    if (t <= 0) return 0;
    if (t >= oldDuration - 1e-6) return +newDuration.toFixed(3);
    for (const s of segments) {
      if (t >= s.oldStart - 1e-6 && t <= s.oldEnd + 1e-6) {
        return +(s.newStart + (t - s.oldStart) / s.speed).toFixed(3);
      }
    }
    return +newDuration.toFixed(3);
  };
}

function rebaseClip(clip, remap, newDuration) {
  const actions = clip.actions.map((a) => ({
    ...a,
    startSec: remap(a.startSec),
    endSec: remap(a.endSec),
    ...(a.moveStartSec != null ? { moveStartSec: remap(a.moveStartSec) } : {}),
    ...(a.arrivalSec != null ? { arrivalSec: remap(a.arrivalSec) } : {}),
    ...(a.clickSec != null ? { clickSec: remap(a.clickSec) } : {}),
  }));
  const marks = {};
  for (const [k, v] of Object.entries(clip.marks || {})) marks[k] = remap(v);
  return { ...clip, actions, marks, durationSec: +newDuration.toFixed(3) };
}

/**
 * Re-time `mp4Path` in place; return the rebased clip and the remap.
 *
 * `narrationSpans` are kept at 1x — a line spoken over a sped-up gap would be
 * talking about something the viewer has already flashed past. Returns null when
 * there is nothing worth compressing, so the caller keeps its original file.
 */
/**
 * WHAT THE COMPRESSOR WOULD SPEED UP, without touching a frame.
 *
 * Extracted so nothing has to re-derive it. `compressIdleGaps` keeps SIX kinds
 * of span at 1x — the opening `HEAD_KEEP`, the closing `TAIL_KEEP`, the final
 * `WAIT_RESULT_KEEP` of every wait, the `BREATHING_SEC` lead-in at the start of
 * every gap, `POST_CLICK_KEEP` after every click, and any residual gap under
 * `MIN_GAP_SEC` that `buildSegments` leaves alone — plus every action's own span
 * and any narration. EXCEPT the middle of a `fill` longer than
 * `TYPING_MIN_COMPRESSIBLE`, which keeps only its head (from the click) and its
 * tail: typing is a transport, not a beat (ENG-6195).
 * A caller that imports one of those constants and subtracts it is
 * describing a different function from the one that runs (ENG-6130).
 *
 * Returns the segments in ORIGINAL time. Those with `speed !== 1` are exactly
 * the spans that get faster; everything else the compressor keeps.
 */
function planCompression({ clip, narrationSpans = [], speed = SPEED }) {
  const D = clip?.durationSec;
  if (!D || D <= 0) return null;

  // CONSECUTIVE WAITS ARE ONE WAIT. Three adjacent `wait` actions each kept
  // their own 1.6s tail, so a single generation that the flow happened to
  // express as three steps protected 4.8s of empty canvas instead of 1.6s.
  // Only the last of a run has a result to show; the earlier ones end because
  // the model chose to look again, which is not an event a viewer can see.
  const acts = [];
  for (const a of clip.actions || []) {
    const prev = acts[acts.length - 1];
    if (a.type === 'wait' && prev && prev.type === 'wait') {
      acts[acts.length - 1] = { ...prev, endSec: a.endSec ?? prev.endSec };
    } else {
      acts.push(a);
    }
  }

  const active = [];
  for (const a of acts) {
    const start = a.moveStartSec ?? a.startSec ?? 0;
    const click = a.clickSec ?? a.startSec ?? start;
    const end = Math.max(click + POST_CLICK_KEEP, a.endSec ?? a.startSec ?? start);
    if (a.type === 'wait') {
      // A WAIT IS DEAD TIME BY DEFINITION, and protecting its whole span made
      // this stage a no-op on exactly the demos that need it most. Measured on
      // a Moda take: 15 seconds of an empty canvas and a "Designing. Please
      // wait to edit" badge were marked active, the stage reported "nothing
      // idle enough to compress", and the finished post appeared only in the
      // final frame of a 49-second video.
      //
      // Frame uniqueness cannot rescue this either — the badge animates, so
      // the take measured 1466 unique frames of 1466, "0% holding still",
      // through a wait where nothing whatsoever happened. Only the TAIL is
      // kept, because that is where the result arrives.
      active.push([Math.max(start, end - WAIT_RESULT_KEEP), end]);
    } else if (a.type === 'fill' && end - click >= TYPING_MIN_COMPRESSIBLE) {
      // TYPING IS NOT A BEAT, IT IS A TRANSPORT. Measured on a real take: the
      // fill was 14.1s of a 37.1s cut — 38% of the video — and the critique
      // called it out as "8 of 12 sampled frames on a screen where nothing but
      // text length differs". Every non-wait action used to be protected for
      // its WHOLE span, so no compress speed could reach it: `no_visible_change`
      // fired with `fix: speed_up`, the loop bumped 6x -> 9x -> 12x, and the
      // score sat at 6/10 for three rounds against a video whose largest block
      // was immune. Third instance of one shape — a finding whose remedy cannot
      // touch its cause (ENG-6130, ENG-6137) — and here it was the biggest
      // thing on screen.
      //
      // HEAD AND TAIL, like a wait keeps its tail. The head is where the viewer
      // sees typing begin and starts reading; the tail is the completed prompt,
      // which has to be legible before it is sent. The middle — clause four of
      // seven appearing — carries nothing a viewer needs.
      //
      // ANCHORED AT THE CLICK, not at `start`. For a recorded fill `start` is
      // `moveStartSec` — when the cursor BEGINS gliding toward the field — and
      // the glide plus its pre-click dwell runs ~0.8-1.6s. Anchoring the head
      // there spent the entire budget on pointer movement and expired just as
      // typing began, speeding the click and the first characters: the exact
      // opposite of what the head is for. Keeping [start, click + HEAD] also
      // holds the whole glide at 1x by construction, which is right — the
      // cursor is only visible while it moves. `narrate.js` anchors a fill's
      // spoken line at `clickSec` for the same reason.
      //
      // The threshold is measured on the TYPING span (`end - click`) too, or a
      // brief fill behind a long glide crosses it and gets split — precisely
      // the "already a beat" case the threshold exists to exclude.
      active.push([start, Math.min(end, click + TYPING_HEAD_KEEP)]);
      active.push([end - TYPING_TAIL_KEEP, end]);
    } else {
      active.push([start, end]);
    }
  }
  for (const n of narrationSpans) {
    if (n && n.durationSec > 0) active.push([n.startSec, n.startSec + n.durationSec]);
  }
  active.push([0, Math.min(HEAD_KEEP, D)]);
  if (D > TAIL_KEEP) active.push([D - TAIL_KEEP, D]);

  const kept = mergeIntervals(active).map(([s, e]) => [s, Math.min(e, D)]);
  const { segments, newDuration } = buildSegments(D, kept, Math.max(1.5, speed));
  return { D, kept, segments, newDuration };
}

/**
 * Re-plan an ALREADY-DECIDED protection set at a different speed.
 *
 * `kept` is speed-independent — it is where the waits, clicks, narration, head
 * and tail are, and none of that moves when the gaps play faster. Only
 * `buildSegments` reads the speed. So the question "how much shorter would this
 * cut be at the cap?" is answerable from `{ D, kept }` alone, with no source
 * actions and no source-time narration spans — which matters because the spans
 * on disk are rebased into FINAL time and could not be replanned against the
 * source anyway (ENG-6149).
 */
function planFromKept({ D, kept, speed }) {
  // `speed` GUARDED too: `Math.max(1.5, undefined)` is NaN, which propagates
  // through every segment into `newDuration` and reads as a measured answer —
  // the silent-fallback shape this seam is built to refuse.
  if (!D || D <= 0 || !Array.isArray(kept) || !Number.isFinite(speed)) return null;
  const { segments, newDuration } = buildSegments(D, kept, Math.max(1.5, speed));
  return { D, kept, segments, newDuration };
}

function compressIdleGaps({ mp4Path, sourcePath = mp4Path, clip, narrationSpans = [], speed = SPEED }) {
  const plan = planCompression({ clip, narrationSpans, speed });
  if (!plan) return null;
  const { D, segments, newDuration } = plan;
  if (!segments.some((s) => s.speed !== 1) || D - newDuration < MIN_SAVING_SEC) {
    // LEAVE `mp4Path` HOLDING THE SOURCE. Declining to compress still has to
    // leave the output correct: on a re-run `mp4Path` holds the PREVIOUS run's
    // compressed video, and every stage downstream would mux this run's timings
    // onto footage cut for a different plan. Reachable the moment a re-cut
    // protects more than the last one did — reverting a narration drop is
    // exactly that, and the rollback produced a cut whose audio and video
    // disagreed. A no-op on a first run, where the two are already identical.
    if (sourcePath !== mp4Path && existsSync(sourcePath)) copyFileSync(sourcePath, mp4Path);
    return null;
  }

  const graph =
    segments.map((s, i) =>
      `[0:v]trim=start=${s.oldStart.toFixed(3)}:end=${s.oldEnd.toFixed(3)},setpts=(PTS-STARTPTS)/${s.speed}[v${i}]`
    ).join(';') +
    `;${segments.map((_, i) => `[v${i}]`).join('')}concat=n=${segments.length}:v=1:a=0[out]`;

  // READ FROM THE PRISTINE SOURCE, write to the output. These were the same
  // file, so the stage overwrote its own input: re-running finish.mjs compressed
  // an already-compressed take again, and a real one went 48.9s -> 26.2s ->
  // 17.8s across three runs with the original gone. Nothing said so, because
  // each pass on its own did exactly what it claimed.
  const tmp = path.join(path.dirname(mp4Path), `.compress-${path.basename(mp4Path)}`);
  execFileSync(FFMPEG, ['-v', 'error', '-y', '-i', sourcePath, '-filter_complex', graph,
    '-map', '[out]', '-an', '-c:v', 'libx264', '-crf', '18', '-preset', 'medium',
    '-pix_fmt', 'yuv420p', tmp], { maxBuffer: 64 << 20 });
  renameSync(tmp, mp4Path);

  // VERIFY rather than trust: a filter graph that silently produces the wrong
  // length would slide every caption, and the rebased clip would still look
  // internally consistent.
  const actual = +execFileSync(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration',
    '-of', 'default=nw=1:nk=1', mp4Path]).toString().trim();
  if (Math.abs(actual - newDuration) > 0.3) {
    throw new Error(`compressed to ${actual.toFixed(2)}s but the time-map says ${newDuration.toFixed(2)}s — ` +
      'every caption and keyframe would be off by the difference');
  }

  const remap = makeRemap(segments, D, newDuration);
  return { clip: rebaseClip(clip, remap, actual), remap, oldDuration: D, newDuration: actual,
           spedSegments: segments.filter((s) => s.speed !== 1).length };
}

/**
 * The compression facts a take is graded against, as one object.
 *
 * A FUNCTION, not an object literal inside `finish.mjs`, for the reason
 * `deadTimePhrase` is one: the writer and the reader live in different
 * processes, and every guard this seam has had for a cross-process record was
 * some description of the shape rather than a round trip through it. A test can
 * call this and hand the result straight to `checkShots`, so a renamed field
 * fails where it happens instead of silently reading as "no record".
 */
function compressionFacts({ plan, compressed, speed, clip }) {
  return {
    ran: Boolean(compressed),
    speed,
    maxSpeed: MAX_SPEED,
    sourceDurationSec: plan?.D ?? null,
    newDurationSec: compressed ? compressed.newDuration : (plan?.D ?? null),
    kept: plan?.kept ?? null,
    // THE WAITS, IN SOURCE TIME. A speed bump shortens every idle gap, but only
    // the part inside a wait is the dead time the finding is about — the head
    // load gap and the space between clicks are not. Without these the delta
    // counted all of it: a 60s source whose only wait is fully narration-
    // protected reported 4.7s "recoverable" from gaps the wait never touched.
    // They must be SOURCE intervals; the document's are rebased.
    waits: (clip?.actions ?? [])
      .filter((a) => a.type === 'wait')
      .map((a) => [a.startSec ?? 0, a.endSec ?? a.startSec ?? 0]),
  };
}

// SPEED is exported as the RESOLVED default, not re-derived by each caller:
// `finish.mjs` has to record the speed the cut actually got, and a second
// `Number(process.env...) || 6` there could disagree with the one that ran.
module.exports = { compressIdleGaps, planCompression, planFromKept, compressionFacts, MAX_SPEED, SPEED };
