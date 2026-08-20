# The metered lanes — media generation and web research

These are the metered lanes — `moda media *` and `moda web *` — and they are the QUALITY levers on this surface. Generated imagery, footage, and research are how good work gets made: reach for them wherever they serve the deliverable, never ask permission first, and report the usage receipt after each call as information (`usage.class: "metered"` on the response). Cost is a topic only when the USER raises it.

The one fact worth carrying: a metered call can fail the billing precheck — exit 6, the quota lane (`insufficient_credits` and friends) — which means the TEAM is out of credits or has hit a plan cap, not that you did something wrong. Say so plainly, surface the hint verbatim, and stop — never retry it, and never quietly drop the quality lever and deliver the lesser thing instead.

## `moda media` — raw media operations (all metered)

```
moda media generate-image --prompt "..." --model M [--aspect-ratio R] [--resolution T]
                          [--num-images N] [--model-params JSON] [--output PATH]
moda media edit-image --prompt "..." --model M --source FILE_REF|URL|PATH [same knobs]
moda media generate-video --prompt "..." --model M [--duration S] [--aspect-ratio R]
                          [--resolution T] [--generate-audio] [--seed N]
                          [--image REF] [--end-image REF] [--reference REFS...] [--output PATH]
moda media remove-background FILE_REF|URL|PATH
moda media upscale FILE_REF|URL|PATH [--scale 2|4]
moda media upscale-video FILE_REF|URL|PATH [--resolution 720p|1080p|1440p|2160p]
moda media video-frames FILE_REF|PATH [--count N | --timestamps MS...] [-o DIR]   # FREE
```

**`moda media models` is the capability source**: each model's supported aspect ratios, resolution tiers, durations, and extra `--model-params` come from it — read it before passing per-model knobs; never hardcode capabilities from memory.

Results return durable refs that feed markup `image(...)` fills and `src` attributes directly — never a raw URL.

### Choosing an image model

`--model` is **required — there is no "auto"**. The authoritative model list, with each model's aspect ratios, resolutions, and controls, comes from the CLI itself (`moda media models`) — defer to it; never hardcode capabilities from memory. Strengths in one line each, to route the choice:

<!-- generated: image-model roster. Authored in backend/app/services/media/image_registry.py (label + skill_card_line, falling back to description); regenerate with: uv run python -m scripts.render_model_roster -->
- **NanoBanana 2 Lite** — Fastest, lowest-cost baseline; the default when nothing else is demanded.
- **NanoBanana 2** — Balanced speed and quality with flexible output up to 4K.
- **NanoBanana Pro** — Premium tier for the most complex, high-fidelity visual tasks.
- **GPT Image 2.0** — Strong in-image text rendering.
- **Ideogram V4** — Crisp posters, logos and accurate in-image text.
- **FLUX.2 Pro** — High-quality general-purpose generation, and multi-reference image editing.
- **Seedream V5 Lite** — High-resolution output (up to 4K) at the family's lowest price.
- **Seedream V5 Pro** — The family's premium tier: more detail per pixel than Lite, at a smaller maximum size (2K).
- **Recraft V3** — Style-rich design generation and single-image editing; vector styles cost 2x.
- **Seedream 4.5** — The previous Seedream generation, kept for its own look rather than its size.
- **Recraft V4.1** — Design-first generation for production-ready raster artwork.
- **Recraft V4.1 Pro** — High-resolution generation for hero imagery, campaigns, and print.
- **Recraft V4.1 Utility** — A faster, lighter Recraft variant for high-volume raster workflows.
- **Recraft V4.1 Utility Pro** — High-resolution Recraft Pro output with a faster, cost-efficient runtime.
- **Recraft V4.1 Vector** — Editable SVG generation for logos, icons, and illustration systems.
- **Recraft V4.1 Pro Vector** — Large-format editable SVG generation for detailed professional illustration.
- **Grok Imagine** — Generation and multi-image editing with a separate 1K/2K resolution axis.
- **Grok Imagine 2.0** — Generation and multi-image editing with priced quality and 1K/2K resolution axes.
<!-- /generated: image-model roster -->

### Image rules

- Your `prompt` goes to the model VERBATIM — nothing is added or rewritten. Write the complete instruction: subject, style, composition, and (for edits) exactly what to preserve.
- Aspect ratio / resolution / model params are per-model enums — copy values exactly from the model's capability line; an unlisted ratio fails the call rather than snapping.
- There is no separate edit tool: to edit an image generatively, pass it as a source image and describe the complete edit. Source images are modified/preserved content; reference images guide style, palette, or composition.
- Each result returns an image ref — the canonical handle. Place it in markup (`<image src="…"/>`), pass it to later verbs, and never invent, alter, or reconstruct a ref.
- Inspect the returned image with your own vision before claiming visual details the prompt doesn't guarantee. If it misses, retry with a refined prompt or a different model — nothing falls back silently.

### Video rules

- Same verbatim-prompt and required-model rules. Video models (e.g. Veo 3.1 / Veo 3.1 Fast / Veo 3.1 Lite, Seedance 2.0/2.5, Gemini Omni Flash, Kling 3, Wan 2.7 — the registry is the roster, not this list) differ in modes (text / start-image / reference-to-video), durations, resolutions, and native audio. `moda media models` prints the per-model capability cards; the per-model envelope is enforced server-side — knobs snap (read `applied`/`adjustments`), and an unsupported mode fails typed, naming the models that can do it. The moda-video skill owns model routing and the video workflows.
- **Always pass an explicit duration** — omitting it lets the server reserve the model's LONGEST clip, which is rarely the clip you meant to make.
- Requested duration/resolution/shape SNAP to the nearest supported value; the result reports what was `applied` and each `adjustment` — read them before describing the output. Snapping can round upward.
- Never ask a video model to render precise text, prices, or CTA/legal copy. Keep on-screen text minimal, design exact text into the start frame, go vector-native, or composite over the clip on an animation canvas and export mp4/gif (the moda-video skill owns all three moves).
- There is no video-to-video editing, and reference VIDEO input exists only on the models whose cards declare it. A canvas DOES take video via `<video src="file_…"/>` markup, but its static exports render blank (see gotchas.md).
- **Look at what you generated.** `moda media video-frames FILE_REF -o frames/` samples still frames out of a clip and writes them where you can see them — FREE, uncharged, nothing added to the library. A `file_` ref is not an image: this is the only way to know a render matches the brief, so run it before describing or delivering a generated clip. `--count N` (1–8) surveys evenly, `--timestamps MS...` inspects named moments (one or the other, never both), and it reads team files only — a local path uploads itself first, a remote URL does not. An empty frame list means Moda could not DECODE the file, not that the video is bad; a `frames_partial` warning means you saw only part of the clip. The moda-video skill owns the full loop.
- **Several drafts at once — the best-of-N pattern.** `moda media generate-video --no-wait` submits the render and returns a `task_id` immediately instead of holding the call open for minutes, so N drafts can run in parallel instead of one after another. Collect each with `moda task status TASK_REF --wait`, frame-check them, pick the direction that worked, and render only that one at final length/resolution on the model the ask deserves. Nothing is charged until a poll collects a finished video — an abandoned task costs nothing — and a background render takes durable inputs only (`file_` refs or local paths, never an http(s) URL), because collection re-resolves them minutes later. A failed or canceled render still exits 0: read the `status`.

## Imagery is a default quality lever

Generated imagery is a DEFAULT quality lever, not a last resort. Covers, heroes, section breaks, and full-bleed closers get generated imagery wherever it elevates the design — styled to the brand's palette and mood. Reuse brand-kit assets and the user's own uploads (`moda file search` / `moda file upload`, `--from-url`) when they are the actual subject matter; `moda file search QUERY --source stock` adds stock photography (place the `stock_unsplash_…` id verbatim; credit the result's `attribution` wherever the photo appears); markup `<image icon="query"/>` covers functional UI icons; an icon/vector-only system is a deliberate style choice, never a cost fallback.
