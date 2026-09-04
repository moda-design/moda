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
const { renameSync } = require('node:fs');
const path = require('node:path');

//: How much faster an idle gap plays. A knob because it is the cheapest
//: lever the iteration loop has: re-pacing needs no re-record and no upload.
const SPEED = Number(process.env.DEMO_COMPRESS_SPEED) || 6;
const BREATHING_SEC = 0.35;   // kept at 1x at the START of each gap, so it does not jerk
const MIN_GAP_SEC = 0.7;      // shorter gaps are left alone; speeding them just stutters
const POST_CLICK_KEEP = 0.6;  // after a click, for the result to register
const TAIL_KEEP = 2.0;        // the final beat is the reveal — never sped past
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
function compressIdleGaps({ mp4Path, sourcePath = mp4Path, clip, narrationSpans = [], speed = SPEED }) {
  const D = clip.durationSec;
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
  if (!segments.some((s) => s.speed !== 1) || D - newDuration < MIN_SAVING_SEC) return null;

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

module.exports = { compressIdleGaps };
