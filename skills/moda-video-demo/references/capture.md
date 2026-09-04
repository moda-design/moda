# The capture and publish recipe

Everything here is verified end to end against a live app. Follow the shapes
exactly — several of the traps below fail **silently**.

## The clip timeline

What capture writes, and what the compile reads. Times are clip-relative
seconds; coordinates are viewport pixels.

```json
{
  "name": "create-a-canvas",
  "goal": "show creating a blank canvas",
  "durationSec": 16.8,
  "viewport": { "width": 1280, "height": 800 },
  "integrity": { "actionsIssued": 3, "unresolved": [] },
  "actions": [
    {
      "index": 0,
      "type": "click",
      "label": "Click \"Create\"",
      "startSec": 3.0,
      "endSec": 6.0,
      "clickX": 137,
      "clickY": 104,
      "box": { "x": 0.006, "y": 0.111, "width": 0.202, "height": 0.038 },
      "moveStartSec": 3.79,
      "arrivalSec": 3.99,
      "clickSec": 5.29,
      "selectorType": "role",
      "selector": "role=button[name=\"Create\"i]",
      "provenance": "observed"
    }
  ]
}
```

**`integrity` is not optional.** `actionsIssued` is how many actions you tried;
the compile refuses a timeline that cannot prove it is the whole record, because
a log with holes produces a shorter video that looks entirely correct. List any
action you performed but could not identify in `unresolved`.

**`box` is normalized 0..1** against the viewport. The recorder gives you pixels
— divide. A box outside 0..1 is refused rather than clamped.

**`provenance: observed`** means the mechanism that performed the click emitted
the record, in the same call. If you wrote the log afterwards from memory, it is
not observed — that is narration, and the camera must not trust it.

**`label`** is the on-screen caption. Write it from the element you resolved, not
from your own reasoning about the step. `Click "Create"` — never
`The page did not navigate, let me scroll up to find it`.

## Capture rules

- **Glide over real time, never teleport and never `steps` alone.**
  `page.mouse.move(x, y, { steps })` has NO delay between steps — it dispatches
  all of them at once, measured at 0.18s, which the camera tracks as a snap. Do
  the waiting yourself (`GLIDE_MS = 500`). The cursor's travel IS the zoom's
  rise, so this number and the rise are the same number.
- **The three cursor dwells are ONE setting, and one of them is not free.**
  The wide beat between two punch-ins is arithmetic:

      beat = HOLD_AFTER + click overhead - hold_sec - release_sec

  `HOLD_BEFORE` is not in it. When the beat goes small the two punch-ins are not
  dropped — `_chain_punch_ins` keeps the camera in and PANS between them, which
  is why a tight cadence now produces one continuous shot rather than no camera.
  (It replaced `_drop_pumping_punch_ins`, which did discard the whole run.)

  Current values are `HOLD_AFTER = 1100` in capture.mjs and `DEFAULT_HOLD_SEC =
  0.6` / `DEFAULT_RELEASE_SEC = 0.67` in studio's `zoom.py`. Read them there
  rather than from this line: every number written here has been wrong at least
  once, and a stale constant in a model-facing doc is worse than no constant.

  Chaining changes what to check rather than removing the need to. A chained
  shot is still a shot: `src/shot-check.js` counts a pan at sustained full scale
  as its own shot and checks its framing, because counting only scale rises saw
  the first of a chain and none of the rest.
- **`HOLD_BEFORE` is a settle, not a stare.** It was 1100ms "so the zoom has
  something to ease into", and at the time it never did: the rise ended at
  ARRIVAL, so a dwell after arrival landed entirely on the flat top — the camera
  snapped in over 0.18s and then held for 1.7s, the inverse of the intent. 300ms.

  The rise now ends at the CLICK, not at arrival, so that dwell is part of the
  rise rather than after it. The setting stays small for a different reason:
  it is the gap between the camera settling and the button going down, and a
  long one is a stare at a finished shot.
- Record with Playwright's `recordVideo` at the same viewport as the timeline.
- Take `box` from `locator.boundingBox()` at the moment you click.
- Video only flushes on `context.close()`.
- Draw a cursor: page JS has none, and footage with no pointer reads as jump cuts.

## Compile — do NOT improvise this

Turning a timeline into canvas markup and a camera program is not prose work. The
caption windows, the zoom plan, the centre-pivot compensation, the easing names
and the millisecond rounding are all real logic that lives in the backend package
`app/services/demo_video/`, and each one has a silent failure mode. Improvising it
produces a canvas that reports success and plays nothing.

The runnable wrapper is ``moda-cli/skills/moda-video-demo/demo-capture/compile.py``. It reads `.studio` beside
itself for a studio checkout and runs on that checkout's backend venv:

```bash
PY="$(git rev-parse --show-toplevel)/backend/.venv/bin/python"
cd <studio>/moda-cli/skills/moda-video-demo/demo-capture

# 1. markup — before the canvas exists
"$PY" compile.py markup <timeline.json> <video-url> <out-markup.xml>

# 2. motion — AFTER the markup is applied and the node id read back
"$PY" compile.py motion <timeline.json> <video-url> <page_id> <node_id> <out-motion.js>

# 3. captions — same ordering reason; ids come from the read-back
"$PY" compile.py captions <timeline.json> <video-url> <page_id> <ids.json> <out-captions.js>
```

The split is forced by the ordering: the motion API resolves targets by **scene
id only**, and no node has an id until the markup has been applied. That is why
`markup` runs first, the caller applies it and reads the ids back, and only then
do `motion` and `captions` run. Concatenate the motion and caption programs into
**one** `canvas edit` — two calls race the canvas revision.

## The runner — use this, do not rewrite it

`run.mjs` is the whole pipeline. A goal and a URL is the entire input:

```bash
cd <studio>/moda-cli/skills/moda-video-demo/demo-capture
node run.mjs "<goal>" <url> --name <slug> [--no-auth] [--publish "<Title>"]
```

It chains discover → curate → validate → record → finish → iterate → publish,
cheapest stage first, so everything that can be caught before the recording is
caught before the recording. Two stages exist because doing them by hand was the
difference between a usable demo and a bad one:

- **curate** drops what a demo must never show. Discovery drives the app to
  reach a goal, which is a different job from showing it off: on Moda's own flow
  it emitted `Maybe later` (dismissing a troubleshooting dialog) and `Try again`
  (retrying a render error). A demo of the product erroring and being nursed
  through it passes every other gate, because those steps resolve and do change
  the page. Removal is not blind — the flow is re-walked without each step and
  anything load-bearing is put back, since a dialog dismissal is junk when the
  dialog did not appear and essential when it did.
- **iterate** critiques the finished cut and fixes what is cheap. Findings are
  routed to the stage that OWNS them: pacing and camera need no re-record and no
  upload, capture and flow need minutes. It hill-climbs and reverts a regression.

The individual stages still run standalone — `take.mjs`, `finish.mjs`,
`critique-take.mjs`, `publish-take.mjs` — and that is the right thing when you
are iterating on one of them.

A flow is `{goal, steps:[{action:'click'|'fill'|'press', locator, why, text?, key?}]}`.
`why` becomes the caption, so write it as the action, not as your reasoning.

`probe.mjs` prints the subtree of any dialog/menu/tablist that is open at the
failure. That is deliberate: a popup's children are ordinary buttons that no role
filter matches, and head-truncating a long sidebar hides the one thing the next
authoring turn needs.

## Publish — six verbs

```bash
moda file upload take.mp4 --json                    # → file_… AND a url
moda canvas create --name "…" --category animation \
  --size 1280x800 --pages 1 --json                  # → cvs_…, page_ids[0]
moda canvas markup <cvs> --page <page> --file markup.xml --mode append --json
moda canvas read <cvs> --json                       # → find the node id
moda canvas edit <cvs> --file motion.js --json      # camera + caption tracks
moda export <cvs> --format mp4 --page 1 -o demo.mp4 --json
```

### Traps, all of which fail silently

| | |
|---|---|
| **The `src` is the URL, not the `file_` id** | `file upload` returns both. Markup needs the `/api/v2/images/ref/<uuid>?…` one. |
| **Upload returns before the ref resolves** | Markup then drops the `<video>` with `ok: true` — captions, no footage. Poll the URL until a GET is not 404. |
| **`--category animation` is mandatory** | Any other category and the page carries no timeline: the clip never plays and the mp4 exports as a still. |
| **Target the node ID, never its name** | The motion API resolves ids only. A name resolves to nothing and the track is dropped without error. |
| **Easings are camelCase** | `easeInOut`, not `ease-in-out`. An unresolvable easing queues NO track. |
| **`ok: true` also means "silently dropped"** | Verify by reading the canvas back and looking for `animations` / `tracks`. |
| **One edit, not two** | Applying camera then captions separately races the revision. Concatenate both programs into one file. |
| **Identical create params REPLAY** | Two runs of the same goal reuse the first canvas and append duplicate captions. Vary the name. |
| **mp4 export needs `--page 1`** | Without it the CLI refuses. |

A single verb that runs steps 2-6 server-side exists, but it is gated to an
internal cohort: the endpoint behind it is excluded from the public schema and
answers 404 to everyone else, and the CLI hides the command to match. **This
document does not teach it**, because a reader of the mirror cannot run it, and
a skill that names a surface its reader does not have is worse than one that
says nothing.

The sequence below is what `publish-take.mjs` does today, it is what works, and
it is what to follow. When the gate opens, this section is where the one-verb
form replaces it.


## `finish.mjs` — the order is forced

Script, pace and voice happen in one stage because the order between them is not
free, and getting it wrong fails silently:

1. **Plan the narration** — render each line and MEASURE it. Nothing touches the
   video yet.
2. **Compress idle gaps** against those spans. A stretch with no action AND no
   narration plays at 6x; a narrated stretch never does, because a line spoken
   over a sped-up gap describes something the viewer has already flashed past.
3. **Remap the narration through the same time-map**, then mux. Compression moved
   every timestamp; audio placed at the old ones talks over the wrong moment.

Everything downstream is clip-relative, so `rebaseClip` moves the action times,
caption windows and camera keyframes through that same map. A compression that
did not rebase would slide every caption off the thing it describes — and the
result would still look internally consistent, which is why the stage verifies
the encoded duration against the time-map and refuses a mismatch.

**The lead-in and the final beat are protected.** Capture already trims the load
down to a chosen lead-in, and the last two seconds are the reveal. Without those
guards compression treats both as idle: measured, a deliberate 0.9s opening got
squeezed to 0.44s.

On a demo whose steps are back to back there is nothing to compress and the stage
says so. On one with a real wait between actions it is worth a lot — measured on a
20s clip with a page load, **20.0s to 11.2s**.
