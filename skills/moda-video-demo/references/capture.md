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

## Point it at a PRODUCTION build, not a dev server

Every capture against `next dev` has the Next dev overlay burned into **every
frame** — `page-health.js` flags it, and it is not a framing problem you can
shoot around: `nextjs-portal` ships on every dev page. Six takes in a row
carried it. The pipeline can reach a good score and still hand you a video
nobody can publish.

For studio, record against a local production build:

```bash
cd <studio>
# stop the frontend dev server first: distDir is unset, so `next build`
# clobbers the .next that `next dev` is serving
DOPPLER_PROJECT=studio DOPPLER_CONFIG=local_personal doppler run -- npm run build
DOPPLER_PROJECT=studio DOPPLER_CONFIG=local_personal doppler run -- npm start   # :3000
```

Then run the capture against `http://localhost:3000` as normal. To get hot
reload back afterwards, stop `npm start` and run `make server` from `<studio>`
(the root target, which is `next dev`).

**Pin the Doppler config, do not rely on the directory binding.** Doppler binds
a config to a DIRECTORY and binds it to the main checkout, not to worktrees —
`demo-capture/auth.mjs` documents this and pins the same two variables for the
same reason. It also has to be the config `auth.mjs` mints against: every
`NEXT_PUBLIC_*` (the Clerk publishable key included) is inlined at BUILD time,
so a bundle built under a different config records as a signed-out app, and
nothing in the pipeline catches that.

Two more constraints that are easy to trip:

- **The port must stay in 3000-3005.** `auth.mjs` asserts it (the azp trap), so
  a prod build on :3100 cannot mint a local session.
- **The collab stack has to be up**, started from `backend/`:
  `cd backend && BROWSERLESS=1 make server` — API, collab-server and
  collab-worker together. It must be the BACKEND target: at the studio root
  `make server` is `doppler run -- npm run dev`, which ignores `BROWSERLESS`,
  starts no API, and re-clobbers the `.next` you just built. Omni is
  browserless-only and the browserless preflight (backend/Makefile) rejects
  `COLLAB=0`.

Measured against the same flow on a dev server, the production build removed the
overlay, cleared every validation warning, and cut the source recording roughly
in half (78-104s down to 36-68s). The speed-up was not investigated — treat it
as an observation, not a promise.

## The runner — use this, do not rewrite it

`run.mjs` is the whole pipeline. A goal and a URL is the entire input:

```bash
cd <studio>/moda-cli/skills/moda-video-demo/demo-capture
node run.mjs "<goal>" <url> --name <slug> [--no-auth] [--publish "<Title>"]
```

It chains discover → edit → curate → validate → record → finish → iterate →
publish, cheapest stage first, so everything that can be caught before the
recording is caught before the recording. Three stages exist because doing them
by hand was the difference between a usable demo and a bad one:

- **edit** decides what the demo is ABOUT and which steps tell that story. It is
  the only stage that can drop a step which works fine and simply is not the
  point, which is most of the compression a real edit performs — `curate` below
  is a regex junk filter and the no-op drop is a pixel diff, so between them
  they cannot touch a correct, boring step. It also assigns each keeper a beat
  (`hook` / `build` / `payoff`) and a pace (`hold` / `normal` / `hurry`).

  **Generator proposes, code disposes.** The model decides; `disposeEdit`
  enforces what a machine can check — a `wait` is never cut, the flow never
  drops below two visible actions, a step the model said nothing about is kept,
  and there is exactly one payoff which is the last thing that plays. The cuts
  and the order are proposals like curation's: **the validation walk is what
  disposes of them.** A reorder that does not replay falls back to source order,
  and cuts that do not replay are discarded whole, in that order — giving up the
  reorder first, because it is the cheaper half to lose.

  **Replaying is not the same as meaning the same thing**, so the walk is not
  the only guard on a reorder: nothing may move across a `wait`. A wait is the
  flow's only record of "this cannot start until the product has finished", and
  moving the click that starts a generation to after the wait that guards it
  replays perfectly — the thing being waited for is simply not there yet — and
  then the recording races the result and can end mid-generation. Within a
  segment the editor may permute freely, which is the whole capability on a
  flow with no waits at all.

  The beat and the pace ride **on the step object**, not in an array indexed by
  position. Both stages below still remove steps, and a sidecar keyed by index
  would re-point onto the wrong ones the first time either fired — the symptom
  being a payoff hold landing on some other moment, which no other check would
  notice. For the same reason `run.mjs` re-runs `settleBeats` once the step list
  is final: the no-op drop can perfectly well delete the step the edit called the
  payoff.

  `close` is a real beat but the editor never assigns it. Nothing it can see is
  a close — the closing beat is the hold `curate` appends and the brand card
  added at publish as the film's last PAGE (ENG-6306) — so `settleBeats` puts it
  on the trailing hold instead.

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

`critique-take.mjs` reads three records `finish.mjs` writes: the narration spans
the compressor was told to protect, the compression it actually performed (its
speed and the source timeline), and the genre. Run standalone against a take
that predates any of them, it says so and falls back — the dead-time figures
then read high rather than silently pretending to be measured, and the take is
graded as a tutorial. Re-run `finish.mjs` to record them.

`finish.mjs` also **writes** `genre.json` when it had to pick the genre itself,
so the genre a cut was built for is the genre the critique reads. An explicit
`DEMO_STYLE` still overrides a recorded one, and says so when it does.

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
| **Upload returns before the clip is MEASURED** | Placement needs the record's `width` and `height`, which are probed in the background seconds after upload; until they land, publish fails with a markup parse error naming missing dimensions. Poll `file show` until it reports both — do NOT poll the byte URL for a non-404, which is true the instant the object exists and so clears immediately. Upload an **MP4** (or QuickTime): those are the only containers probed, so a WebM never gets dimensions and the poll would never finish. |
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

   The script is written from the **resolved element name**, not from the flow's
   `why`. `why` is `action.reason` from the discovery model — what the agent was
   thinking about clicking — and writing the voiceover from it is the same bug
   `captions.js` was rewritten to fix, where a real run burned *"The page didn't
   navigate, let me scroll up to find the Go to App link"* into a video. Both are
   passed, each labelled as what it is; only the selector is a fact about the
   screen. One extractor, `src/element-name.js`, serves every caller.

   Then the script is checked for **inventions**: a quoted name matching nothing
   the flow can show is replaced with the plain `humanizeAction` sentence, on the
   grounds that a confidently wrong voiceover is worse than a plain one. The
   check reports its own coverage — a script that quoted nothing comes back
   `no line quoted a name`, which is not a pass. Only double quotes count; this
   prompt asks for contraction-heavy prose, so admitting the apostrophe made
   every *"Let's … Moda's"* line read as one quoted run.

   The CLOSING line is checked too, against the whole flow — it summarises a
   finished demo, so nothing in it is a forward reference. It is **dropped**
   rather than replaced when it invents: there is no action to build a fallback
   sentence from, and silence on the final beat beats the most quotable
   sentence in the video being false.

   Each step line is checked against what the viewer has seen **by that line**,
   not against the whole flow. Checking the whole flow let a line spoken over
   Generate say *click "Share"* and pass, purely because some later step had a
   Share control. A back reference is still fine; a forward one is the failure.

   Matching is on WORD runs, not substrings. `includes()` in either direction
   fails **open** — a flow with a button named "Go" validated *"Google Drive"*
   and *"Let us get going"* — and a guard that returns `measured: true` while
   deciding nothing is worse than one that says it could not decide. A name may
   be wrapped in function words (*"the Share button"*) but not padded with
   invented ones (*"Share to Google Drive"*).

   Matching is also over **Unicode** letters and digits. `[a-z0-9]` stripped
   every character of a Japanese or Cyrillic name, so a quoted non-Latin
   control tokenized to nothing and passed on the spot — the same fail-open,
   for every internationalized app.

   **A typed secret is never said, and never sent to a model.** The fact comes
   from `snapshot.js`'s resolver, which stamps `sensitive` while the element is
   still in hand: `type="password"`, or an `autocomplete` naming a credential.
   It has to be decided there — the resolver prefers a test id or a stable id,
   so `<input id="login" type="password">` reaches the flow as `#login`, and no
   later inspection of that string could tell. `src/sensitive.js` then
   withholds the value at all three seams (the editorial prompt, the narration
   prompt, the sayable names), falling back to a keyword-and-shape heuristic
   only for a hand-authored flow that never went through resolution. The
   field's own LABEL still goes through: "API key" is printed on screen and a
   line about it is useful; it is the value typed into it that must not be.

   And the fallback matters as much as the check. `humanizeAction` names the
   resolved element, and a step that resolved none — a CSS locator, say — gets
   the bland sentence rather than the step's `why`: replacing a confidently
   wrong line with one built from the same untrustworthy source is not a
   remedy, it just launders the problem into plainer words.

   A step marked `pace: 'hold'` gets a wall-clock floor composed `max()` with
   its line, sized to `compress.js`'s `TAIL_KEEP` — a hold shorter than the tail
   that already plays at 1x is invisible, and a longer one has its overhang sped
   back up. They compose because the payoff is last by invariant. `hurry` does
   not subtract: it already acted by asking the script for a short line, and
   letting it undercut `HOLD_AFTER` would move a term of the camera's beat
   arithmetic. A **marketing** take never reaches this stage at all, so the
   floors are derived from the pace alone (`paceFloors`) — that genre has no
   narrator, which makes the hold the only thing that says a moment matters.
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

### The critique grades a cut, and the cut decides what is in it

`critique-take.mjs` picks the first of `final`/`scored`/`narrated`/`silent` that exists.
The camera punch-ins are composited at *publish* and the brand closing card arrives there
as the film's last **page** (ENG-6306), and
the iterate loop runs before publish — so on a loop cut neither is present, and on a
`.final` cut both are. That single fact (`composited`) is passed to the critique prompt.
Every fact the prompt asserts about the take is passed explicitly and a missing one
throws: a defaulted fact tells the grader the take contains something it may not, which
makes the grader overlook a defect that is really on screen.
