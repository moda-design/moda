# Video on Moda — generation, motion, and delivery

Two lanes make video, and this skill owns both — **moda-video owns anything
that renders to mp4/gif**:

1. **Generated video** — the metered `moda media` lane: text-to-video,
   image-to-video from a start frame, reference-guided video, upscaling.
   The deliverable is a video file; there is no canvas link.
2. **Vector-native motion** — an animation canvas (or animated shader fills)
   exported with `moda export --format mp4|gif`. Deterministic, free to
   author, precise; the live canvas link is the handoff and the file is
   format-implied.

Route by what the ask needs: cinematic/photographic motion, a logo brought
to life, "make a video" → generated. Crisp type, exact brand geometry,
UI/diagram motion, looping background texture → vector-native. A video ask
IS format words — the motion file is the deliverable, so exporting or
downloading it is compliant, never a ceremony violation.

Canvases DO take video (see references/markup.md and references/gotchas.md):
`<video src="file_…"/>` places a clip as a video fill, and on an animation
canvas `t.video` sequences clips on the page timeline — so compositing type
over a clip and cutting two shots together are real moves. The catch is
delivery: static exports (png/pdf/pptx) of a video-filled node render BLANK
today (no poster frame yet; placement warns `video_poster_unavailable`), so
deliver canvas-video work as an mp4/gif export or as the standalone clip,
never as a still. Route by the deliverable: a raw clip with no design over
it stays in the media lane; type, brand geometry, or a cut belongs on an
animation canvas exported to mp4/gif.

There is no video-to-video edit. Source video/audio inputs for GENERATION exist
only as declared references; `moda media upscale-video` is the only video-input verb.

## Model choice — registry-driven

`moda media models` prints one capability card per video model — its modes
(text→video / image→video / reference→video) with duration, resolution, and
aspect envelopes, reference caps, billing basis in plain words, and the
`--model-params` controls. An older server prints bare ids instead
(`video models: …`). That registry output is the only roster — never
hardcode it, and read capabilities from the cards, not world knowledge. The
same envelopes are enforced server-side: your knobs SNAP to the nearest
supported value and the result's `applied` + `adjustments` fields report
what actually ran; an unsupported mode fails typed, naming the models that
can do it. Read those instead of guessing.

Strengths of the current roster, one line each, to route the choice (defer
to the registry when it disagrees):

- **MiniMax Hailuo H3** — up to 4K, intrinsic audio, end-frame control, and image/video/audio references.
- **Gemini Omni Flash** — the default: strong quality/cost for ordinary
  text- and image-to-video, coherent motion, 3–10 s. **720p is its only
  resolution on all three modes** (a 1080p ask snaps down and is reported),
  and its audio is INTRINSIC — nothing can silence it, so steer the
  soundtrack through the prompt. No seed.
- **Seedance 2.0** — the control pick: end frames, square/portrait/cinema
  aspect ratios beyond 16:9/9:16, seeds, reference-heavy product work,
  including reference VIDEO (up to 3 clips, 2–15 s each, 15 s combined, and
  they discount the call to 0.6× — though the input clips' own running time
  bills on top).
- **Seedance 2.0 Fast** — 2.0's iteration lane: the same controls,
  envelope and reference paths — including the same 3 reference clips — at
  80% of the price, capped at 720p and taking no seed. Explore here, then
  re-run the keeper on 2.0 for the taller frame.
- **Seedance 2.5** — the long-form pick: up to ~30 s in ONE native shot and
  large reference boards (address them in the prompt as `@Image1`,
  `@Image2`, …). Costs meaningfully more per second than 2.0 — use 2.0 when
  the clip fits in 15 s.
- **Veo 3.1** — the quality pick: cinematic realism and camera language,
  4K, a true first-to-last-frame morph; fixed short clip lengths (an
  off-menu duration snaps).
- **Veo 3.1 Fast** — the iteration pick: the same envelope at roughly half
  the price and latency; try a direction here before committing a pricier
  model.
- **Veo 3.1 Lite** — the cheapest second on the roster: the same Veo
  envelope again, a third of Fast's rate, with 1080p as its ceiling.
  Unlike the other two tiers, 1080p costs more here than 720p, and its
  first-and-last-frame morph takes 8 s only (4/6/8 without an end frame).
- **Grok Imagine Video 1.5** — the framing pick for short social clips:
  seven aspect ratios including square, portrait and 3:2. Fixed 5–8 s,
  audio always on and not disableable. **Reach for it when the frame shape
  is the point** — no other model offers that many ratios; per second it is
  dearer than Veo 3.1 Lite at every resolution both offer, and its 1080p is
  the dearest on the roster, so let the framing be the reason you pick it.
  Its three modes disagree more than any other
  model's — reference stops at 720p and defaults to 480p and 8 s, the other
  two reach 1080p and default to 720p and 6 s — and animating a start frame
  has NO aspect control (the framing follows your image), so pick something
  else when a ratio is non-negotiable. Only model that charges per
  reference image ($0.01 each, 1–7) on top of the clip; address them in the
  prompt as `<IMAGE_0>`, `<IMAGE_1>`, …
- **Kling 3 Standard / Pro / 4K** — a quality lane of its own, and the one
  family where the TIER IS THE RESOLUTION: 4K is a separate model, not a
  setting, so the output size is the entry you pick. Asking `kling-3-4k`
  for `4k` is honoured; asking either other tier for any size is dropped
  and reported, because their pages state no output resolution. Shared
  envelope: any whole 3–15 s, landscape/square/portrait, an optional end
  frame on the same call as the start frame, native audio you can actually
  turn off, no seed, prompts capped at 2500 characters. Audio is a price
  axis on Standard and Pro (silent is a third cheaper) and free on 4K, so
  leave it on there. Standard is the entry point, Pro the same envelope
  rendered sharper for a third more, 4K five times a silent Standard second
  — final take, not exploration. The family ships a non-empty negative
  prompt by default and we clear it, so what you write is what the model
  gets: put anything to avoid in the prompt itself, there is no
  negative-prompt knob. `shot_type` picks one continuous take
  (`customize`, default) or model-chosen shot division (`intelligent`).
- **Kling 3 Turbo Standard / Kling 3 Turbo Pro** — rapid iteration: fixed 720p at $0.112/s or 1080p at $0.14/s,
  with native audio. Text has three aspect ratios; image takes one frame. No seed, silence, or end frame.
- **Kling O3 Standard / Pro / 4K** — cheaper native audio, off by default. Standard has no declared output size;
  Pro is 1080p and 4K is native 4k. All make whole 3–15 s clips with an optional end frame. Text supports
  landscape/square/portrait; image follows the source frame (≤10MB, ≥300×300, aspect ratio 0.4:1–2.5:1).
  O3 exposes `shot_type`, but not Kling 3's guidance/negative prompt; describe multi-shot sequences in one prompt.
- **Wan 2.7** — reaches shorter than anything else here: a 2 s clip no
  other model will render (Kling and Gemini stop at 3 s, Seedance at
  4 s), whole-second control from 2–15 s, flat $0.10/s (720p) or $0.15/s
  (1080p) with the frame not entering the price. **Reach for it when you
  need a clip shorter than anything else will render** — at ordinary 5–15 s
  lengths Seedance 2.0 and Veo 3.1 Lite cost less per second and are the
  better picks. Audio always on and not disableable. Its
  **default is 1080p**, so an unspecified request costs half again what the
  same clip costs at 720p — pin the resolution. First-and-last-frame morphs
  need no special mode; supply both frames and the same endpoint takes
  them, at the same lengths. Animating a start frame has NO aspect control,
  the same caveat Grok and Seedance 2.5 carry. Its reference mode is the
  odd one: it stops at 10 s (2 clips, 2–10 s each) and charges the SAME
  $0.10/s at 1080p as at 720p, so the taller frame costs nothing there — as
  on Veo 3.1 and Veo 3.1 Fast, which likewise fold 720p and 1080p into one
  rate and step only at 4K. fal bills each input clip's own running time on
  top of the output's, so an 8 s clip driving a 3 s render bills 11 s.

**Reference video** rides `--reference-video <ref-or-url>` (repeatable; the
wire field is `reference_videos`), and only models whose card shows "ref
videos" accept any. Clip count, per-clip and combined length caps, price
multiplier, and whether the input's running time bills are all per-model —
read them off the card, and a 422 names the whole envelope back to you.
Each clip also lands as a durable file in the team's library.

**Reference audio** rides repeatable `--reference-audio <ref-or-url>` (`reference_audios` on the wire). Read limits from the model card.
For H3, bind references in the prompt by modality and 1-based list order: `Image 1`, `Video 1`, `Audio 1`.

Native audio: O3 defaults audio OFF; pass `--generate-audio` when sound is wanted. Other audio-capable models
default it on. `--no-generate-audio` buys the SILENT rate where audio is controllable — on Kling 3 Standard
and Pro that is a third off, so use it whenever the clip does not need sound. The model card is the authority:
`moda media models` reports `generate_audio_controllable`. Models where it is false have INTRINSIC audio: they
accept the flag, report it as an adjustment, and produce audio anyway, so it buys nothing there. Read that field;
the receipt is the truth.

## Pin the knobs — before EVERY generation

Video knobs snap server-side, so state them rather than letting the server
choose for you. Before each `moda media generate-video` / `upscale-video`
call:

1. **Pin the duration explicitly** (`--duration N`). Omitting it lets the
   server reserve the model's LONGEST clip, which is rarely the clip you
   meant to make.
2. **Pick the resolution the pass needs** — draft small so the frames come
   back while you can still change your mind, then render or upscale the
   winner large.
3. **Say what you're rendering in one line** — model, duration, resolution
   — and go. No permission-seeking, no quoting the price first (the
   metered-lane rules in the UX block); report the usage receipt after.

Re-runs are safe: media calls carry idempotency keys, so re-running the
same command resumes the existing provider render instead of paying twice
(the CLI says so when it happens). A deliberate retake needs a changed
knob — tweak the prompt or pass `--seed` on models that accept one.

## The draft ladder — see it, fix it, then commit

One-shotting the hero model gets you a beautifully rendered version of the
wrong clip. For anything a user will see, the DEFAULT workflow is three
passes, not one:

1. **Draft.** Shortest legal duration, smallest resolution that shows the
   idea, silent wherever silence is a price axis, on the fast lane:
   `--model veo-3.1-lite --duration 4 --resolution 720p --no-generate-audio`
   comes back in a fraction of a hero render's wait, so you SEE the idea
   while you can still change it. Seedance 2.0 Fast is this same move inside
   the Seedance family (the same controls and reference paths) when the
   draft needs an end frame, a ratio off 16:9, or reference boards.
2. **Verify, then FIX — don't escalate.** Read `applied`, `adjustments` and
   `warnings`; look at the frames (`moda media video-frames`, free). A draft
   that missed is nearly always a PROMPT problem, so change the prompt and
   re-draft on the fast lane. Stepping up a tier to fix a badly-specified
   shot buys a sharper version of the wrong clip.
3. **Commit.** Only the direction that survived, at the length and
   resolution the deliverable actually needs, on the model the ask deserves
   — reach high here; the hero render is where the quality is won.

This is not an optional extra, and it is not thrift: it is how you know what
you made before you hand it over. Drafts are fast, so run several at once
(the `--no-wait` best-of-N pattern in references/omni-and-media.md) and keep
the one that worked. Skip the ladder only when the user named a specific
model and a one-off throwaway clip.

## Workflows

**1. Brand stinger** — "a short video with our logo" (the classic ask):

1. Step-0 found the kit: `moda brand show BRAND_REF --json` → durable
   `file_` refs for the logos; VIEW them first (references/brand.md) and
   pick the variant that fits the concept.
2. Pick the model from the registry; image-to-video with the logo as the
   start frame is the hero move: `moda media generate-video --prompt "…"
   --model M --image file_… --duration 6 --resolution 720p -o stinger.mp4`.
   Reference-guided (`--reference`) fits when the logo should GUIDE style
   rather than be frame one.
3. Pin the knobs, generate, read `applied`/`adjustments`.
4. Frame-check it with `moda media video-frames`, then deliver the file
   path + receipt; offer `moda media upscale-video` for the final cut.

**2. Quick text-to-video** — a prompt-only clip: registry pick (default
model unless the ask demands quality/length/control), pin the knobs,
`moda media generate-video --prompt "…" --model M --duration N -o clip.mp4`,
frame-check, deliver. Go direct — no concept fan-out on a simple ask.

**3. Canvas frame → motion** — the canvas-native bridge no raw video tool
has: design the EXACT first frame with full brand and typography control,
then animate it.

1. Author (or take) a canvas page — brand tokens, real type, real layout.
2. `moda export CANVAS_REF --format png --page N --pixel-ratio 2 -o frame.png`.
3. `moda media generate-video --prompt "…" --model M --image frame.png
   --duration N -o out.mp4` (a local path uploads itself to a `file_` ref).
4. Deliver BOTH: the live canvas link (still editable) and the motion file.

**4. Vector-native motion** — when precision beats generation:

- Animated shader fills are the instant premium lever on ANY canvas: author
  per references/design-quality.md (motion is automatic), then
  `moda export CANVAS_REF --format mp4 --page N` — shaders freeze in static
  exports and move in mp4/gif.
- Keyframed motion lives on an animation canvas: `moda canvas create
  --name "…" --size 1920x1080 --category animation`, author the layout via
  markup, then drive motion through the `motion` timeline API inside
  `moda canvas edit` scripts — full shapes in "The motion timeline API"
  below. Author it from that section; don't discover it by probing.
- Export per page: `moda export CANVAS_REF --format mp4|gif --page N` —
  mp4/gif REQUIRE `--page`, and a page with NO animation rejects typed
  `no_animation` (that is the honest answer: deliver a still + the link).
- Choreography beyond what you can author confidently → escalate to
  `moda task start` (metered) rather than thrashing; the canvas link keeps
  the user in the loop either way.

**5. The enhance chain** — refs are the chain handles: every media result
returns a durable `file_` ref, and every media input takes one. Generate →
`moda media upscale-video file_… --resolution 1080p -o final.mp4` → deliver;
or canvas export → generate → upscale. Never retype or reconstruct a ref;
copy it verbatim from the result. Chain in that order: iterate small,
upscale once, at the end, on the winner.

**6. Clip on a canvas** — the composite lane: real type, brand geometry, or
a cut, over generated footage.

1. Get the clip into the team's files: `moda file upload clip.mp4` (or a
   generated result's `file_` ref, already durable).
2. Animation canvas, then place it:
   `<video src="file_…" width="1920" height="1080" fit="cover"/>` via
   `moda canvas markup` (references/markup.md). Layer text and shapes over
   it like any other element — the clip is a fill on a rectangle.
3. Sequence with `t.video(node, { startMs })` inside `motion.page(...)`;
   trim/speed/loop go on the fill through `update()`
   (references/edit-code.md).
4. Deliver `moda export CANVAS_REF --format mp4 --page N` plus the live
   link. Do NOT deliver a png/pdf of a video-filled page — it renders the
   clip blank today (`video_poster_unavailable`); say so if asked for one.

**7. Finished cuts** — a logo animation, a product teaser, a social ad: the
composed, branded DELIVERABLE rather than a clip, which is where this
surface beats a bare video model. Those are recipes 1–3 in
references/motion-recipes.md, each running the draft ladder end to end.
Load that file the moment the ask names a deliverable.

## The motion timeline API — author, don't probe

Keyframed motion is authored inside a `moda canvas edit` script through the
`motion` global. It only applies on a canvas whose category is `animation` —
on any other canvas every motion call is dropped with a
`timeline_motion_non_animation` warning, so create the animation canvas
first (workflow 4). The general edit contract (batches, revisions, warnings)
is references/edit-code.md; this section is the motion surface itself.

**Entry point** — page ids are the short `p_` ids from your latest read:

```
motion.page('p_a', { durationMs: 6000 }, (t) => {
  t.tween('n7', 'opacity', [0, 1], { startMs: 0, durationMs: 400, easing: 'easeOut' });
  t.effect('n7', 'scale-in', { startMs: 0, durationMs: 400 });
  t.recipe('n9', 'recipe-rise', { at: 300 });
  t.stagger(['n3', 'n4', 'n5'], { at: 600, each: 120, animate: (m) => m.effect('scale-in') });
});
```

The options object and the callback are each optional:
`motion.page('p_a', { durationMs: 6000 })` sets duration only.

**Track creators** (each returns the new track id — `t.recipe` and
`t.stagger` return an ARRAY of ids; one track drives ONE node — pass node
arrays only to `t.stagger`):

- `t.tween(target, path, [from, to], opts?)` — two-point ramp. Ramp length =
  `durationMs`, else `endMs − startMs`, else it runs from `startMs` to the
  page end.
- `t.keyframes(target, path, [{ tMs, value, easing? }, …], opts?)` — `tMs`
  is RELATIVE to the track's `startMs`; values are finite numbers; a bad
  entry rejects the whole array.
- `t.colorTween(target, path, [fromColor, toColor], opts?)` /
  `t.colorKeyframes(target, path, [{ tMs, value: '#…' }, …], opts?)` —
  colors NEVER ride scalar verbs. Color paths: `fill`, `stroke`,
  `shadowColor`, `innerShadowColor`, `effects[id=…].color` (page
  background: `fill` only).
- `t.motionPath(node, [{ tMs, value: {x,y}|[x,y], inTangent?, outTangent? }],
  opts?)` — curved travel; tangents are spatial-bézier offsets from the
  point. Don't also give that node override scalar x/y tracks.
- `t.distortTilt(node, [{ tMs, value: { rotXDeg, rotYDeg, distance } }], …)` /
  `t.distortSkew(node, [{ tMs, value: { skewXDeg, skewYDeg } }], …)` — 3D
  card twist / shear on box shapes.
- `t.effect(node, presetId, opts?)` — one preset from the roster below.
- `t.recipe(node, recipeId, opts?)` — a grouped entrance/exit; expands into
  several tracks and returns their ids (it ignores `params` and `id`; tune
  the expanded tracks via `t.update`).
- `t.stagger(nodes, { animate: (m) => …, each?, at?, groupId? })` — runs
  `animate` once per node with member-bound `m.tween/keyframes/effect/
  procedural/compute/shaderClock`, offsetting each member by `each` ms.
- `t.procedural(node, 'lfo'|'wiggle'|'spring'|'clock', outputs, params?,
  opts?)` — endless motion; a missing required param fails with its name.
- `t.shaderClock(node, { param?, from?, to?, durationMs? })` — drives a fill
  shader knob in a loop (defaults: `time`, 0→20 over 45 s).
- `t.compute(target, outputs, codeString, opts?)` — a custom code driver for
  what the verbs above can't say.
- `t.video(node, { startMs, endMs })` — place a video-fill node's clip bar
  (`timeline.video` in full). The bar is the clip's LIFETIME on the page;
  N bars at different `startMs` across N clips IS a cut. `endMs` defaults to
  the trimmed clip's length clamped to the page. One bar per node — calling
  it again REPLACES that node's bar, which is also how you retime one. Trim,
  speed and loop are NOT options here: they live on the fill, and passing
  `offsetMs`/`rate`/`loop` is a hard error naming the fill field instead
  (references/edit-code.md). Set the fill first, then place the bar — the
  bar re-derives from the fill on every call.

**Managing what exists**: `t.update(trackId, changes)` (startMs/endMs/
description/params/blend/driver), `t.clearTrack(trackId)`,
`t.clearTarget(node)`, `t.clear()` (whole page), `t.setDuration(ms)`.
Node lifetimes:
`t.setLifetime(node, { startMs, endMs })` hides the node outside the window
(array of windows for re-appearances; LEAF nodes only — a group/container is
rejected, set lifetimes on its leaves); `t.clearLifetime(node)` undoes it.
Existing tracks read back in the canvas DSL's animations block with short
`anim` ids (references/reading-and-verifying.md) — those ids are what
`t.update('anim7', …)` and `t.clearTrack('anim7')` take.

**The shared options bag** (every track creator): `startMs` (alias `at`),
`endMs`, `loop: 'none'|'loop'|'pingpong'|'hold'`, `periodMs`, `offsetMs`,
`rate`, `pivot: 'center'|'origin'` (center is the default),
`blend: 'add'|'multiply'` (composes top-level SCALAR paths only; presets and
recipes own their own blend), `params`, `description`, `id` (single-track
creators only). Two options are NOT bag-wide: `durationMs` (alias
`duration`) is read by `tween`, `colorTween`, `effect`, `recipe`, and
`shaderClock`; a bag-level `easing` only by `tween` and `colorTween` — every
keyframe verb takes easing PER KEYFRAME instead. Easing values: `linear`,
`easeIn`, `easeOut`, `easeInOut`, `easeInCubic`, `easeOutCubic`,
`easeInOutCubic`, `easeOutQuint`, `easeInOutQuint`, `easeInBack`,
`easeOutBack`, `easeInOutBack`, `easeOutBounce`, or
`'cubic-bezier(x1, y1, x2, y2)'`. The hold contract: a track that ends
before the page does (an explicit `durationMs`, or keyframes that stop
early) HOLDS its final value to the page end — set `endMs` only when you
want a snap-back window. A `tween` with neither `durationMs` nor `endMs`
ramps from `startMs` all the way to the page end.

**Paths** (scalar verbs): top-level node properties — `x`, `y`, `opacity`,
`rotation`, `scale`, `scaleX`, `scaleY`, `width`, `height`, `cornerRadius`,
`strokeWidth`, `shadowBlur`, `shadowOpacity`, `trimPathStart`,
`trimPathEnd`, `dashOffset`, and friends — plus one-level nested
(`layerBlur.radius`, `fillShaderParams.<knob>`) and the list-by-id forms
`effects[id=…].<field>` and `shaderEffects[id=…].params.<knob>`. `position`
is the vec2 channel — use `t.motionPath`. A wrong path fails at authoring
with a precise warning; read it instead of retrying blind.

**Preset and recipe rosters** (an unknown id fails with the full current
roster in the warning — the surface is self-listing; trust that list over
this one if they ever disagree):

- `t.effect`: `position-slide-in`, `position-slide-out`, `position-custom`,
  `scale-in/-out/-custom`, `rotate-in/-out/-custom`, `size-in/-out/-custom`,
  `opacity-fade-in/-out`, `opacity-custom`,
  `pulse`, `float`, `bob`, `breathe`, `shake`, `spin`,
  `text-kinetic`, `scramble`, `count-up`, `draw-on`, `marching-ants`,
  `shadow-pulse`, `gradient-rotate`, `corner-morph`, `wobble`, `heartbeat`.
- `t.recipe` (every id carries the `recipe-` prefix): `recipe-slide-in`,
  `recipe-rise`, `recipe-drop`, `recipe-pop-in`, `recipe-burst-in`,
  `recipe-fly-in`, `recipe-spin-in`, `recipe-typewriter`,
  `recipe-reveal-word`, `recipe-reveal-line`, `recipe-fade-word`,
  `recipe-slide-word`, `recipe-rise-line`, `recipe-scale-word`,
  `recipe-slide-out`, `recipe-pop-out`, `recipe-spin-out`, `recipe-fly-out`.
- The app panel's names are NOT these ids: there is no `fade-in` or
  `rise-in` — fades are `opacity-fade-in`/`opacity-fade-out`, grouped
  entrances/exits are the `recipe-*` ids. Page backgrounds are app-panel
  territory: `t.effect`/`t.recipe` refuse a page-background target (its
  fill still animates via `t.colorTween('page-background', 'fill', …)`).

**Order of work**: author the layout first (markup), then add motion in a
LATER edit call — a preset that bakes against the node's live content
(text presets; any recipe with requirements) refuses a node created in the
same edit batch. Static pass, then motion pass.

## Prompt craft for short brand clips

- The prompt goes to the model VERBATIM. Write one complete instruction:
  subject, motion, camera, style, mood, and (image-to-video) what from the
  start frame must be preserved.
- One idea per clip. A stinger is 4–8 s: one motion arc (reveal, bloom,
  orbit, dissolve-in), not a storyboard. Name the brand palette and mood.
- **Never ask a video model to render precise text**, prices, or CTAs. Keep
  on-screen text minimal; when crisp type or an exact lockup is the point,
  design it INTO the start frame (workflow 3), go vector-native
  (workflow 4), or place the clip on an animation canvas and lay real text
  over it (workflow 6) — the mp4/gif export is the deliverable there.
- Loops: ask for a seamless loop explicitly and keep the motion contained;
  end-frame models can morph back to the opening frame (pass the start
  image as `--end-image` on a model that supports end frames).

## Verifying video — look at the frames

`moda media video-frames FILE_REF -o frames/` samples still frames out of a
clip and writes them where you can LOOK at them. FREE, and the only way to
see what a render actually made — a `file_` ref is not an image. Never tell
a user a generated clip is right without looking first.

- The loop is generate → frames → judge them against the brief →
  regenerate with a revised prompt, or accept. Read `applied`,
  `adjustments`, and `warnings` in the same pass: snapping may have changed
  duration, resolution, or shape.
- `--count N` (1–8, default 4) surveys the clip evenly, first and last
  frame always included; `--timestamps MS…` inspects moments you name, read
  off the `duration_ms` the previous call reported. One or the other.
- An EMPTY frame list (`no_frames_decoded`) means Moda could not DECODE the
  file, NOT that the video is bad — never regenerate on it. A
  `frames_partial` warning means you saw only PART of the clip: judge what
  those frames show, say so, and sample again before calling it right.
- Looking still needs a harness with vision. If yours has none, say so once
  — "I can't view the frames here; verified the applied parameters and left
  the visual check to you" — and never claim you watched what you could not
  see (references/reading-and-verifying.md).
- Several drafts at once, each frame-checked before you commit to one, is
  the `--no-wait` pattern in references/omni-and-media.md.
- Canvas-motion exports: a screenshot shows ONE static frame — check
  layout/brand there, and state that the motion itself needs eyes on the
  mp4/gif or the live canvas.

## Delivery

- Media-lane results: the file path is the deliverable (plus the usage
  receipt as information). Print where it landed; never show raw JSON.
- Canvas-motion results: live link FIRST (it never depends on the export),
  then the mp4/gif; everything stays editable in the app.
- Offer the enhance step (upscale) once, briefly, for hero deliverables;
  no nagging.
