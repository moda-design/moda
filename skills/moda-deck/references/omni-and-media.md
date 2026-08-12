# The metered lanes — media generation and the Omni escalation

Everything in this document spends Moda credits — spend them where they make the work better. Media generation is a normal part of doing good design, not a lane to justify or apologize for: use it wherever it improves the result, and report the usage receipt after each call as information (`usage.class: "metered"` on the response; exact credits enrich asynchronously on account usage).

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
```

**`moda media models` is the capability source**: each model's supported aspect ratios, resolution tiers, durations, and extra `--model-params` come from it — read it before passing per-model knobs; never hardcode capabilities from memory.

Results return durable refs that feed markup `image(...)` fills and `src` attributes directly — never a raw URL.

### Choosing an image model

`--model` is **required — there is no "auto"**. The authoritative model list, with each model's aspect ratios, resolutions, and controls, comes from the CLI itself (`moda media models`) — defer to it; never hardcode capabilities from memory. Strengths in one line each, to route the choice:

- **NanoBanana 2** — fast, low-cost baseline; the default when nothing else is demanded.
- **NanoBanana 2 Pro** — hi-res path for higher-fidelity output.
- **GPT Image 2.0** — strong in-image text rendering.
- **Ideogram V4** — crisp posters, logos, and accurate in-image text; the logo-preset lane.
- **FLUX.2 Pro** — high-quality general-purpose text-to-image.
- **Seedream V5 Lite** — high-resolution output at moderate cost.
- **Recraft V4 Pro** — design/brand-focused generation with palette control.
- **Grok Imagine** — separate 1K/2K resolution axis.

### Image rules

- Your `prompt` goes to the model VERBATIM — nothing is added or rewritten. Write the complete instruction: subject, style, composition, and (for edits) exactly what to preserve.
- Aspect ratio / resolution / model params are per-model enums — copy values exactly from the model's capability line; an unlisted ratio fails the call rather than snapping.
- There is no separate edit tool: to edit an image generatively, pass it as a source image and describe the complete edit. Source images are modified/preserved content; reference images guide style, palette, or composition.
- Each result returns an image ref — the canonical handle. Place it in markup (`<image src="…"/>`), pass it to later verbs, and never invent, alter, or reconstruct a ref.
- Inspect the returned image with your own vision before claiming visual details the prompt doesn't guarantee. If it misses, retry with a refined prompt or a different model — nothing falls back silently.

### Video rules

- Same verbatim-prompt and required-model rules. Video models (e.g. Veo 3.1 / Veo 3.1 Fast, Seedance 2.0/2.5, Gemini Omni Flash) differ in modes (text / start-image / reference-to-video), durations, resolutions, and native audio. `moda media models` lists the video model IDS only; the per-model envelope is enforced server-side — knobs snap (read `applied`/`adjustments`), and an unsupported mode fails typed, naming the models that can do it. The moda-video skill owns model routing and the video workflows.
- **Always pass an explicit duration** — duration is the dominant cost driver (a 30s clip costs ~6× a 5s clip), and omitting it forces the credit precheck to reserve for the model's longest clip, which can fail outright on a small balance.
- Requested duration/resolution/shape SNAP to the nearest supported value; the result reports what was `applied` and each `adjustment` — read them before describing the output. Snapping can round upward and cost more.
- Put exact graphic text, branding, prices, and CTA/legal copy on the canvas AFTER generation — never ask a video model to render precise text.
- There is no video-to-video editing and no source-video input; a canvas never takes video (see gotchas.md).

## Imagery is a default quality lever

Generated imagery is a DEFAULT quality lever, not a last resort. Covers, heroes, section breaks, and full-bleed closers get generated imagery wherever it elevates the design — styled to the brand's palette and mood. Reuse brand-kit assets and the user's own uploads (`moda file search` / `moda file upload`, `--from-url`) when they are the actual subject matter; `moda file search QUERY --source stock` adds stock photography (place the `stock_unsplash_…` id verbatim; credit the result's `attribution` wherever the photo appears); markup `<image icon="query"/>` covers functional UI icons; an icon/vector-only system is a deliberate style choice, never a cost fallback.

## `moda task start` — the Omni escalation lane (metered)

Handing the whole job to Moda's own agent. It plans, designs, sources imagery, and builds on a canvas server-side — the lane where Moda's models run.

```
moda task start --prompt PROMPT [--canvas CANVAS_REF] [--files FILE_REF...]
                [--brand BRAND_REF] [--format slides|one-pager|social|...]
                [--wait] [--export pptx -o out.pptx]
moda task status TASK_REF        moda task list [--active]        moda task cancel TASK_REF
```

**When to escalate** (instead of authoring markup yourself):

- A genuinely open-ended creative brief where the user wants Moda's designer to own the direction ("surprise me", "make it beautiful", multiple concepts to choose from).
- Imagery-heavy work where generation, art direction, and layout must co-evolve.
- Brand-guide generation (a new identity — see references/brand.md).
- Motion choreography beyond the deterministic lane (motion v3 via `moda canvas edit` on an animation-category canvas covers the basics; preset animations on ordinary canvases remain app-only).

**When NOT to escalate:** anything you can author deterministically. You are the agent; a known layout with known content is your job, free, and faster to iterate on.

### Task-lane rules

- A task delegates the whole job and spends accordingly — mention, matter-of-fact, that you're starting one (no permission-seeking), and report the receipt after.
- `moda task start` is idempotent: an identical re-run replays the already-started task instead of spending again — within the server's idempotency window (the CLI says so when it detects the replay). A deliberate new attempt — e.g. after `task_failed` — takes `--fresh`.
- Omit `--canvas` for net-new work — the task creates and designs its own canvas. Pass `--canvas` only when the job must land on an existing one; a running task **owns its canvas** — your writes exit 5 as busy until it finishes, and the CLI already retried. Recovery: find the owner with `moda task list --active` (newer servers also accept `--canvas CANVAS_REF` to filter; on older servers match the canvas id in the listing), then wait or `moda task cancel`.
- Pass `--brand` rather than restating colors/fonts/logos in the prompt — the resolved kit owns them. Put the slide/page count and format in the flags or the prompt explicitly.
- A completed task returns a finished, already-exported result when `--export` was chained — don't re-export in a different verb unless you need another format.
- Typed failures map to the standard exits: billing precheck and plan caps exit 6 with the cap in the message; a live run owning the canvas exits 5. Surface hints verbatim.
- After a task completes you can resume surgical control: `moda canvas read` the result, then targeted `moda canvas edit` / `moda canvas markup` refinements — the hybrid is often the best workflow.
