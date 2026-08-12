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

Hard boundaries (see references/gotchas.md): a canvas never takes video —
no video fills, no compositing text over a generated clip on a canvas.
There is no video-to-video edit and no source-video input; the only verb
that takes a video as input is `moda media upscale-video`.

## Model choice — registry-driven

`moda media models` prints the current video model ids (`video models: …`).
The id list is the only roster — never hardcode it. Video capability
envelopes (durations, resolutions, aspect ratios, modes) are enforced
server-side: your knobs SNAP to the nearest supported value and the result's
`applied` + `adjustments` fields report what actually ran; an unsupported
mode fails typed, naming the models that can do it. Read those instead of
guessing.

Strengths of the current roster, one line each, to route the choice (defer
to the registry when it disagrees):

- **Gemini Omni Flash** — the default: strong quality/cost for ordinary
  text- and image-to-video, coherent motion, native audio.
- **Seedance 2.0** — the control pick: end frames, square/portrait/cinema
  aspect ratios beyond 16:9/9:16, seeds, reference-heavy product work.
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

Native audio: current models generate audio by default where they support
it — describe the soundtrack in the prompt (`--generate-audio` requests it
explicitly). On some models audio is its own price axis; the receipt is the
truth.

## The spend checkpoint — before EVERY generation

Video is the most expensive metered verb on this surface. Before each
`moda media generate-video` / `upscale-video` call:

1. **Pin the duration explicitly** (`--duration N`). Duration is the
   dominant cost driver (a 30 s clip costs ~6× a 5 s clip), and omitting it
   makes the credit precheck reserve for the model's LONGEST clip — which
   can fail outright on a small balance.
2. **Pick the smallest resolution that serves** — cost scales with it.
   Upscale the winner afterward instead of rendering every attempt large.
3. **Check the balance covers it** (Step-0's `moda account status` note; a
   shortfall fails the precheck with exit 6 — surface its hint verbatim).
4. **Say what you're spending, matter-of-fact, in one line** — model,
   duration, resolution — no permission-seeking (the metered-lane rules in
   the UX block), then report the usage receipt after.

Re-runs are safe: media calls carry idempotency keys, so re-running the
same command resumes the existing provider render instead of paying twice
(the CLI says so when it happens). A deliberate retake needs a changed
knob — tweak the prompt or pass `--seed` on models that accept one.

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
3. Spend checkpoint, generate, read `applied`/`adjustments`.
4. Deliver the file path + receipt; offer `moda media upscale-video` for
   the final cut.

**2. Quick text-to-video** — a prompt-only clip: registry pick (default
model unless the ask demands quality/length/control), spend checkpoint,
`moda media generate-video --prompt "…" --model M --duration N -o clip.mp4`,
verify, deliver. Go direct — no concept fan-out on a simple ask.

**3. Canvas frame → motion** — the canvas-native bridge no raw video tool
has: design the EXACT first frame with full brand and typography control,
then animate it.

1. Author (or take) a canvas page — brand tokens, real type, real layout.
2. `moda export CANVAS_REF --format png --page N --pixel-ratio 2 -o frame.png`.
3. `moda media generate-video --prompt "…" --model M --image frame.png
   --duration N -o out.mp4` (a local path uploads itself to a `file_` ref).
4. Deliver BOTH: the live canvas link (still editable) and the motion file.

**4. Vector-native motion** — when precision beats generation:

- Animated shader fills are the cheap premium lever on ANY canvas: author
  per references/design-quality.md (motion is automatic), then
  `moda export CANVAS_REF --format mp4 --page N` — shaders freeze in static
  exports and move in mp4/gif.
- Keyframed motion lives on an animation canvas: `moda canvas create
  --name "…" --size 1920x1080 --category animation`, author the layout via
  markup, then drive motion through `moda canvas edit`
  (`create('animation', …)` / `update` — references/edit-code.md; existing
  tracks read back under `## Animations`, references/reading-and-verifying.md).
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
copy it verbatim from the result. Chain the CHEAP order: iterate small,
upscale once, at the end, on the winner.

## Prompt craft for short brand clips

- The prompt goes to the model VERBATIM. Write one complete instruction:
  subject, motion, camera, style, mood, and (image-to-video) what from the
  start frame must be preserved.
- One idea per clip. A stinger is 4–8 s: one motion arc (reveal, bloom,
  orbit, dissolve-in), not a storyboard. Name the brand palette and mood.
- **Never ask a video model to render precise text**, prices, or CTAs — and
  there is no canvas compositing over video to fix it afterward. Keep
  on-screen text minimal; when crisp type or an exact lockup is the point,
  design it INTO the start frame (workflow 3) or go vector-native
  (workflow 4).
- Loops: ask for a seamless loop explicitly and keep the motion contained;
  end-frame models can morph back to the opening frame (pass the start
  image as `--end-image` on a model that supports end frames).

## Verifying video — the degraded posture

There is NO frame-inspection verb on this surface. Verification degrades —
it never disappears:

- Download the result (`-o`), and read `applied`, `adjustments`, and
  `warnings` before describing the output — snapping may have changed
  duration, resolution, or shape.
- Reviewing the pixels assumes a harness that can view media. If yours can
  (extract stills/frames with local tooling and LOOK), review the first
  frame, one mid frame, and the last. If it cannot, say so once — "I can't
  view the clip in this environment; verified the applied parameters and
  left the visual check to you" — and never claim you watched what you
  could not see (same rule as references/reading-and-verifying.md).
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
