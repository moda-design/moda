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

Route by what the ask needs: cinematic/photographic motion or a logo brought to
life → generated; crisp type, exact brand geometry, UI/diagram motion, looping
texture → vector-native. Bare "make a video" decides nothing — read the brief. A video ask
IS format words — the motion file is the deliverable, so exporting or
downloading it is compliant, never a ceremony violation.

Canvases DO take video (see references/markup.md and references/gotchas.md):
`<video src="file_…"/>` places a clip as a video fill, and on an animation
canvas `t.video` sequences clips on the page timeline — so compositing type
over a clip and cutting two shots together are real moves. The catch is
delivery: static exports (png/pdf/pptx) draw only a video-filled node's poster
frame (a clip whose placement warned `video_poster_unavailable` renders blank),
so deliver canvas-video work as an mp4/gif export or as the standalone clip,
never as a still. Route by the deliverable: a raw clip with no design over
it stays in the media lane; type, brand geometry, or a cut belongs on an
animation canvas exported to mp4/gif.

There is no generative free-form video-to-video edit. A source clip is a declared
generation reference, the base of an `--extend-video` extension (below), or the
subject of one of the two media verbs that take a video as their SUBJECT: `moda
media upscale-video` (bigger) and `moda media reframe-video` (a new shape — the
shot is kept and the newly exposed edges are painted in, so the 16:9 becomes the
9:16 story cut without regenerating it).

## Main Edit service — composition-only P1

Use the Edit service for deterministic cut-list changes to the Main Edit:

- `moda edit read CANVAS_REF --json` returns compact tracks and clips with stable
  ids, links, transitions, and exact rational times. Each time carries an integer
  string `value` numerator and a positive integer `timescale` denominator; for
  example, value `3000` at timescale `1000` is exactly three seconds.
- Put an array of `insert_clip`, `move_clip`, `trim_clip`, `remove_clip`, and
  `reorder_clip` operations in a JSON file. Run `moda edit validate CANVAS_REF
  --file operations.json` before a mutation when planning or debugging.
- Operation shapes are exact:

  ```json
  {"op":"move_clip","clip_id":"clip-a","track_id":"track-v1","start":{"value":"3000","timescale":1000}}
  {"op":"trim_clip","clip_id":"clip-a","edge":"end","time":{"value":"5000","timescale":1000}}
  {"op":"remove_clip","clip_id":"clip-a"}
  {"op":"reorder_clip","track_id":"track-v1","clip_id":"clip-a","before_clip_id":"clip-b"}
  {"op":"insert_clip","track_id":"track-v1","clip":{"id":"clip-new","source":{"kind":"composition","composition_id":"composition-page-id"},"start":{"value":"0","timescale":1},"duration":{"value":"5","timescale":1}}}
  ```

  The inserted clip `id` is a new caller-chosen unique id; every track, canvas,
  source composition, existing clip, and relationship id must come from
  `moda edit read` rather than being invented.
- Apply atomically with `moda edit apply CANVAS_REF --file operations.json
  --revision REV`. The whole batch commits or none of it does; re-read
  after `stale_revision` and retry with the new revision.

P1 accepts composition clips only and keeps the visual track ripple-contiguous.
Raw media sources, source-audio policy, non-`hold` visual end behavior, audio
tracks or mixing, and transition authoring are deliberately unsupported.
Rejections name the runtime capability
(for example `edit.visual.media-source`, `edit.audio.track`, or
`edit.transition`) instead of silently dropping authored state. Never replace the
Edit document as raw JSON; these operations preserve fields a newer producer may
have written even when this client does not understand them.

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
- **MiniMax Hailuo 2.3 / MiniMax Hailuo 2.3 Pro / MiniMax Hailuo 2.3 Fast /
  MiniMax Hailuo 2.3 Fast Pro** — the cheap SILENT preview lane, priced per
  render from $0.19. No audio, seed, end frame, resolution or aspect control
  (both asks are dropped and reported): standard is always 768p and runs 6 or
  10 s, Pro is always 1080p and takes no duration. Both Fast tiers are IMAGE
  ANIMATORS ONLY. Below H3 on every axis — iterate here, render elsewhere.
- **Gemini Omni Flash** — the default: strong quality/cost for ordinary
  text- and image-to-video, coherent motion, 3–10 s. **720p is its only
  resolution on all three modes** (a 1080p ask snaps down and is reported),
  and its audio is INTRINSIC — nothing can silence it, so steer the
  soundtrack through the prompt. No seed.
- **Seedance 2.0** — the control pick: end frames, square/portrait/cinema
  aspect ratios beyond 16:9/9:16, reference-heavy product work,
  including reference VIDEO (up to 3 clips, 2–15 s each, 15 s combined, and
  they discount the call to 0.6× — though the input clips' own running time
  bills on top).
- **Seedance 2.0 Fast** — 2.0's iteration lane: the same controls and reference paths, including 3 video clips,
  at 80% of the price, capped at 720p. Explore here, then re-run the keeper on 2.0 for 1080p.
- **Seedance 2.0 Mini** — the budget tier: 480p/720p, 4–15 s or `auto`, optional end frame, and image/video/audio
  references (`@Image1`, `@Video1`, `@Audio1`). Use 2.0 for 1080p or 2.5 for longer clips.
- **Seedance 2.5** — the long-form pick and the roster's JOINT AUDIO-VIDEO
  entry: up to ~30 s in ONE native shot, big reference boards and reference
  video (address inputs in the prompt as `@Image1`, `@Image2`, …). Audio is
  native and on by default — ambience, effects, and SPOKEN DIALOGUE render
  jointly with the picture, no separate TTS: quote the line in the prompt, e.g.
  `moda media generate-video --model seedance-2.5 --duration 8 --prompt 'Close-up, a barista looks up and says: "We open at seven." Natural delivery, normal blinking.'`
  Caveats: reference audio landed on this route — up to 10 clips, 2–30 s
  each and ≤30 s combined, addressed `@Audio1`…`@AudioN` like 2.0 Mini's, and it needs an
  image or video reference alongside (audio references do not bill; only
  reference VIDEOS add input seconds and the 0.6× discount); a
  photoreal HUMAN image input — reference or first frame — is rejected
  outright (`content_policy_violation`), with or without audio or speech:
  its reference and audio lanes are for vehicles, products, scenes, and
  stylized characters, while text-DESCRIBED humans in plain text-to-video
  render fine. For photoreal-human identity anchors route to the Kling 3
  family (pick an exact id off `moda media models`; they take the same
  image anchors) or the Seedance 2.0 tiers (2.0 Fast has taken real human
  footage as reference video); fast action still decoheres —
  keep talking shots calm. In a small
  2026-08 evaluation on this route, its in-prompt speech graded closest to
  a passable talking human of any roster lane, yet still clearly below the
  professional bar — frozen torso, lip lag at line starts, a mechanical
  end-of-line grin, high roll variance; treat that as provisional and
  re-test before a large spend. For on-camera speech read
  "Talking humans" below — in-prompt dialogue is now the LAST of three lanes,
  not the first.
  Dearer per second than 2.0 — use 2.0 when the clip fits in 15 s and
  nothing needs to speak.
- **OmniHuman v1.5** — the presenter lane: one photo of a person plus one
  audio track, and that person delivers the track on camera, with emotion and
  body movement following the read. Takes `--start-image` (REQUIRED — the
  character) and one `--reference-audio` of 2–30 s. Unlike Seedance 2.5 it
  ACCEPTS a photoreal human photo. Billed per second of the delivered clip,
  which is the track's own length, so a shorter read is a cheaper render; the
  30 s cap is per CALL, so chunk a longer script and cut the pieces together.
- **Kling LipSync** — the cheap lip-sync post step: a 2–10 s clip plus a
  2–60 s track, and the mouth in that clip is re-animated to the track. No
  prompt, no duration — the shot comes back at its own length. Billing rounds
  up to a 5-second block, so a 3 s shot costs a 5 s one. SLOW: about 12
  minutes per job whatever the length, so fire it with `--no-wait` and collect
  it later.
- **Sync Lipsync 2 / 2 Pro** — the dedicated lip-sync house, priced per minute
  of the clip handed over, roughly 3.5x Kling's rate for the same footage. Pro
  bills 1.67× the base tier and fal describes it as enhanced facial animation
  for close-ups and commercial work. Both take a longer source than Kling's
  10 s ceiling, and `--model-params '{"sync_mode":"remap"}'` decides what
  happens when the track and the clip are different lengths — `cut_off`
  (truncate the audio, the default), `silence` (hold the picture), or `remap`
  (time-stretch the audio to fit). The picture keeps the source clip's own
  length on all three; fal's two picture-repeating modes are not served here.
- **Veo 3.1** — the quality pick: cinematic realism and camera language,
  4K, a true first-to-last-frame morph; fixed short clip lengths (an
  off-menu duration snaps).
- **Veo 3.1 Fast** — the iteration pick: the same envelope at roughly half
  the price and latency; try a direction here before committing a pricier
  model.
- **Veo 3.1 Lite** — the cheapest Veo second (PixVerse V6 goes lower): the
  same Veo envelope again, a third of Fast's rate, 1080p as its ceiling.
  Unlike the other two tiers, 1080p costs more here than 720p, and its
  first-and-last-frame morph takes 8 s only (4/6/8 without an end frame).
- **Grok Imagine Video 1.5** — the framing pick for short social clips:
  seven aspect ratios including square, portrait and 3:2. Fixed 5–8 s,
  audio always on and not disableable. **Reach for it when 3:2 or 2:3 is
  the point** — those two are its alone. Per second it is dearer than Veo
  3.1 Lite at every resolution both offer, and its 1080p is the dearest on
  the roster, so let the framing be the reason you pick it.
  Its three modes disagree more than any other
  model's — reference stops at 720p and defaults to 480p and 8 s, the other
  two reach 1080p and default to 720p and 6 s — and animating a start frame
  has NO aspect control (the framing follows your image), so pick something
  else when a ratio is non-negotiable. Only model that charges per
  reference image ($0.01 each, 1–7) on top of the clip; address them in the
  prompt as `<IMAGE_0>`, `<IMAGE_1>`, …
- **PixVerse V6** — the flexible low-cost pick: text, required-first-frame
  animation, required-first-and-last-frame transition, and source-video
  extension, all at any whole 1–15 s. It reaches 360p/540p as well as
  720p/1080p, with native audio off by default. Plain image animation follows
  the first frame; transition exposes eight aspect ratios through 21:9.
  `negative_prompt`, style, prompt optimization, and one-file multi-clip
  storytelling live in `model_params`. Prompts and negative prompts are capped
  at 2,048 UTF-8 bytes, not characters. Extension returns source plus tail but
  bills only the requested tail duration.
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
  landscape/square/portrait; image follows the source frame (≤50MB, ≥300×300, aspect ratio 0.4:1–2.5:1).
  O3 exposes `shot_type`, but not Kling 3's guidance/negative prompt; describe multi-shot sequences in one prompt.
- **Wan 2.7** — reaches shorter than anything else here: a 2 s clip no other model will render (Kling and Gemini
  stop at 3 s, Seedance at 4 s), whole-second control from 2–15 s, flat $0.10/s (720p) or $0.15/s (1080p) with the
  frame not entering the price. **Reach for it when you need a clip shorter than anything else will render** — at
  ordinary 5–15 s lengths Seedance 2.0 and Veo 3.1 Lite cost less per second and are the better picks. Audio always
  on and not disableable. Its
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
- **Wan 3.0 / Wan 3.0 Prime** — text/start-frame/reference video, 2–30 s or `auto`, optional audio/end frame,
  480p/720p/1080p, and up to 10 images, 5 videos (15 s total, ≥16 fps), plus 5 audios (15 s total; needs a visual).
  Standard is $0.05/$0.10/$0.20 per second; faster Prime is $0.068/$0.14/$0.28. Default 1080p/audio on.
  This is the roster's strongest audio-REFERENCE lane: tracks ride beside image/video references, with a
  SEED, in one native 2–30 s pass — route reference-consistent clips that a supplied track must drive here.
- **Happy Horse 1.1** — the lip-sync pick: synchronized native audio and
  multilingual lip-sync on every mode, and the widest framing menu here —
  nine ratios, 21:9 to 9:21. 3–15 s, $0.14/s (720p) or $0.18/s (1080p,
  its default). No end frame, and no aspect control when animating a start
  frame. Its reference mode takes up to 9 images at no extra charge;
  address the subjects as `character1`, `character2`, … in supply order.

- **LTX-2.5 Pro / LTX-2.5 Fast** — the only models that generate video FROM a
  track: pass a reference audio on its own (no image or video reference) and the
  clip is rendered to that audio, which comes back in the output; add a start
  image and it becomes the opening frame. The clip's length IS the track's
  (2–10 s Pro, 2–20 s Fast — on Fast a full 20 s VO read or
  music bed drives the entire clip), so a duration you ask for comes back
  adjusted — pick the audio, not the seconds. Otherwise 6/8/10 s (Pro) or 6–20 s in 2 s
  steps (Fast), `auto` by default on both, so pin the duration or you reserve
  the ceiling. Pro is $0.12/s (720p) and $0.17/s (1080p); Fast is cheaper at both
  ($0.09/$0.13) and the only tier reaching 1440p ($0.19/s), 4K ($0.30/s) or
  clips past 10 s. Native audio on by default and free at every resolution; the
  audio-driven route bills a flat $0.17/s (Pro) or $0.13/s (Fast) of the track.
  `camera_motion` scripts one move on the text and image routes only. No seed.

## Talking humans — the routing doctrine

Measured 2026-08-24/25. **No general video model on this roster clears a
professional bar for on-camera speech.** The best measured lane was Seedance
2.5's in-prompt dialogue at roughly 78% realism with a severity-7 worst case and
high roll-to-roll variance; LTX, MiniMax H3, Happy Horse and Veo all graded
below it. So do not open a talking-head brief by prompting for dialogue. Work
down this list and stop at the first lane that fits:

1. **VO-led (the default).** Cut the beats so lips are never the focus —
   over-the-shoulder, hands, product, cutaways — and carry the words in a
   voiceover from `moda media generate-audio`. Nothing here is a lip-sync
   problem, so nothing here can fail as one, and it is the cheapest lane.
2. **Lip-sync post.** Generate the performance shot with the actor NOT
   talking, on a model that accepts a photoreal identity anchor (the Kling 3
   family does; pick an exact id off `moda media models`). Then lay the cast
   read over the finished clip with `--lipsync-video`. This is the lane that
   gets all three at once: a consistent character, a voice you chose, and lips
   that match. Draft on `kling-lipsync`; escalate a hero close-up to
   `sync-lipsync-2-pro`.
3. **Standalone presenter.** When the shot IS a person talking to camera and
   there is no surrounding action — a spokesperson, an explainer, a testimonial
   — go straight to `omnihuman-1.5` from one character photo and one audio
   file. It skips the generate-then-sync round trip entirely.

**Which lip-sync.** `kling-lipsync` is the cheap default: use it for drafts and
for wide and medium shots where the mouth is not the subject of the frame.
`sync-lipsync-2-pro` is the escalation for hero close-ups and commercial-grade
facial animation, at many times the cost — reach for it deliberately, after a
cheap pass has settled the edit. **This ranking is PROVISIONAL**: it rests on
provider claims and community reputation, not on a graded head-to-head run
here. A bakeoff of the same clip and read through all three is planned; if the
ordering flips, this paragraph changes.

**Identity, not just lips.** Seedance 2.5 rejects ANY photoreal human image
input, so its reference and audio lanes cannot carry a real person's likeness —
route that work to the Kling 3 family or the Seedance 2.0 tiers, then lip-sync
the result.

**Not on the roster, and why** — do not reach for these, they are notes so the
question is not re-opened: `infinitalk` (image+audio, 720p ceiling,
open-source class) is a plausible budget lane for long audio and is on the
watchlist only; `veed/avatars` offers preset characters with no custom photo, so
it cannot do identity work at all; PixVerse's lip-sync measured worse than the
lanes above; and OmniHuman v1 exists at a slightly lower rate than v1.5 but with
weaker motion, so v1.5 is the single entry we carry.

**Reference video** rides `--reference-video <ref-or-url>` (repeatable; the
wire field is `reference_videos`), and only models whose card shows "ref
videos" accept any. Clip count, per-clip and combined length caps, price
multiplier, and whether the input's running time bills are all per-model —
read them off the card, and a 422 names the whole envelope back to you.
Each clip also lands as a durable file in the team's library.

**Extending an existing clip** rides `--extend-video <ref-or-url>` (`extend_video` on the wire). Pass what happens NEXT; no other inputs may accompany it, and **`--duration` is the ADDED segment**, not the final file.
Read `billing.duration_quantity`, source envelope, and resolutions in `moda media models`: **PixVerse V6** meters only that segment at the selected 360p/540p/720p/1080p and audio tier (`--resolution` works; `--aspect-ratio` does not), and publishes no source envelope.
**Grok Imagine Video 1.5** meters the whole return plus every source second again (10 s added to a 15 s, 720p source: 25 x $0.07 + 15 x $0.01 = $1.90); its source decides the frame/rate and both framing flags do nothing.
Grok's source must be 2–15 s, at most 921,600 px per frame, and MP4 with a supported codec.

**Lip-syncing an existing clip** rides `--lipsync-video <ref-or-url>` (`lipsync_video` on the wire), and it needs
exactly one `--reference-audio` beside it — the speech the mouth is re-cut to. Nothing else may accompany the pair:
no frames, no references, and not `--extend-video`. The clip returns at its OWN length, so `--duration` is not a
control and the `--prompt` is ignored entirely (pass anything). Read the source envelope off `moda media models`:
`kling-lipsync` takes 2–10 s of MP4 at up to 1920×1080 and bills in 5-second blocks; the sync tiers take
up to 2 minutes and bill per minute. Budget the LATENCY, not just the price — `kling-lipsync` runs about 12 minutes
per job regardless of clip length, so use `--no-wait` and collect the render rather than blocking on it.

**Reference audio** rides repeatable `--reference-audio <ref-or-url>` (`reference_audios` on the wire). Read limits from the model card.
For H3, bind by modality/list order: `Image 1`, `Video 1`, `Audio 1`. Wan 3.0/Prime require a visual reference.
Seedance 2.5 and 2.0 Mini take reference audio, addressed as `@Audio1` beside `@Image1`/`@Video1` (2.5: up to
10 clips, 2–30 s each and ≤30 s combined, an image or video reference required alongside); plain Seedance 2.0 and 2.0 Fast
accept image and video references only.
Beside an image/video it is one reference among several; ALONE it drives the clip only on a model whose card shows
`audio→video`. An audio-only ask elsewhere is refused before anything is billed.

Native-audio defaults are model-specific. The model card is the authority: `moda media models` reports
`generate_audio_default` and `generate_audio_controllable`; pass `--generate-audio` whenever sound is wanted and
the default is off. `--no-generate-audio` buys the SILENT rate where audio is controllable — on Kling 3 Standard
and Pro that is a third off, so use it whenever the clip does not need sound — including VO-led work
where the mix discards generated audio anyway; silent is the right default there. Models where controllable is false
have INTRINSIC audio: they accept the flag but still produce audio, so silence buys nothing. The receipt is the truth.

## Pin the knobs — before EVERY generation

Video knobs snap server-side, so state them rather than letting the server
choose for you. Before each `moda media generate-video` / `upscale-video`
call:

1. **Pin the duration explicitly** (`--duration N`). Omitting it lets the
   server reserve the model's LONGEST clip, which is rarely the clip you
   meant to make. The one exception is an audio→video render: there the clip
   IS the driving track's length, a duration you pass is reported back as
   adjusted, and the way to a shorter (cheaper) clip is a shorter track.
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
   path + receipt; offer `upscale-video` for the final cut, `reframe-video
   --aspect-ratio 9:16` for vertical.

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
- Choreography beyond what you can author confidently → stop rather than
  thrashing; hand the user the canvas link — the app's motion tools pick
  up from there.

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
   link — png/pdf keeps only each clip's poster frame (blank if placement
   warned `video_poster_unavailable`); say so if a still is asked for.

**7. Finished cuts** — a logo animation, a product teaser, a social ad, an
animated display banner: the composed, branded DELIVERABLE rather than a
clip, which is where this
surface beats a bare video model. Those are recipes 1–4 in
references/motion-recipes.md; every one of them that generates footage runs
the draft ladder end to end.
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

## Motion taste — pacing, preset choice, and the hazards

The rosters above say what exists; this says what to reach for.

- **Pacing.** Typical durations: 600–800 ms for main elements, 400–600 ms
  for secondary elements. Stagger sequential elements (`t.stagger`, or
  stepped `startMs`) for a polished entrance flow, and vary the looks
  across different pages or concepts. Keep animations subtle and
  professional — don't over-animate every element; decorative elements
  stay still.
- **Preset to content.** `text-kinetic` (word × appear, a comfortable
  speed) for headlines and key text; `count-up` for statistics, monetary
  values, and metrics; `recipe-slide-in` / `recipe-rise` for supporting
  text and images; `opacity-fade-in` as a safe default. `recipe-burst-in`
  is scale + spin + fade — energetic, so use it for one hero element at
  most.
- **Ambient loops.** Reach for ONE, on a single focal element; overusing
  ambient motion reads as noise. `pulse` / `breathe` are the quiet "this
  is alive" cue for a logo or badge, `float` / `bob` suit a hero element
  or an icon, `shake` is emphasis and brief — and `heartbeat`, the
  double-beat "lub-dub", is energetic: one accent element only.
- **The easing hazard.** The `*Back` curves (`easeInBack`, `easeOutBack`,
  `easeInOutBack`) overshoot [0,1] — use them for spatial pop, not on
  `opacity` (`easeOutBounce` stays in range).
- **Text-kinetic speed is units/sec, not duration.** Its
  `params: { unit, animation, speed }` set the look, and because speed
  counts UNITS PER SECOND, longer text takes proportionally longer at a
  consistent pace rather than being crammed into a fixed window:
  typewriter = char × appear at speed ≈ 30; reveal by word = word ×
  appear at ≈ 4; reveal by line = line × appear at ≈ 2. The same three
  looks also ship pre-grouped as `recipe-typewriter`,
  `recipe-reveal-word` and `recipe-reveal-line` (with `recipe-fade-word`,
  `recipe-slide-word`, `recipe-scale-word` and `recipe-rise-line` for the
  softer per-unit variants).

Unsure which preset a piece of content wants? `moda ask "which entrance
preset should a stat headline get on an animation canvas?"`.

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

## Post-production routing — canvas owns picture, local owns audio

The default split, learned in production. Do not abandon the canvas
timeline for local tools because one step must be local:

- The canvas timeline OWNS picture assembly (`t.video` bars are the cuts),
  trims and retimes, text and supers, vector end cards and overlays,
  canvas-native motion, and reframing for aspect variants. Prefer it even
  when local tools feel faster: the canvas artifact is editable,
  collaborative, and re-exportable; a local concat is a dead end.
- Local post is legitimate ONLY for the audio mix (music bed, VO,
  loudness) — the timeline has no standalone audio tracks or mixing
  today — and for concatenating chunked exports.
- The hybrid recipe: assemble picture + text on canvas → export video →
  mux audio locally → deliver. Never assemble picture locally just
  because audio must be local. The local half needs a general shell
  (ffmpeg or similar) — in a moda-only harness, hand over the exported
  picture and the audio files with the mux step stated plainly, and do
  not claim final delivery.

Constraints that force the local half — plan for them from the start:

1. The timeline carries no standalone audio tracks or mixing — plan the
   local mix up front, don't discover it at delivery. Video FILLS' own
   audio IS muxed into mp4 exports (an `audio_source_dropped` warning
   names any fill whose sound went missing): mute the fills, or
   account for their sound, before laying a local mix over the picture.
2. Long-composition exports can be DECLINED. `frame_dump_budget` is
   content-shaped and TERMINAL — re-running the same composition declines
   the same way; shrink what one export renders — lower the resolution,
   shorten the composition, or split it across PAGES: `moda export` has no
   time-range selector, so the supported chunk recipe is one chunk of the
   cut per page, exported page-by-page with `--page N`, then concatenated
   locally (re-encode on concat, never stream-copy across chunks; the
   local half's shell caveat above applies). `frame_dump_scratch_pressure`
   is capacity and retryable.
3. Externally UPLOADED video files can fail to place on a canvas;
   platform-generated `file_` refs place fine. Route generated media by
   `file_` ref and treat upload-then-place as unreliable.
4. A clip whose placement warned `video_poster_unavailable` renders blank
   in stills — deliver canvas-video work as an mp4/gif export, never a
   still.
5. `t.video` bars hide clips outside their bar; to hide arbitrary nodes
   per shot use `t.setLifetime`. Set the video FILL before authoring the
   bar — the bar re-derives from the fill. Mechanics live in
   references/edit-code.md and references/markup.md.

## Delivery

- Media-lane results: the file path is the deliverable (plus the usage
  receipt as information). Print where it landed; never show raw JSON.
- Canvas-motion results: live link FIRST (it never depends on the export),
  then the mp4/gif; everything stays editable in the app.
- Offer the enhance step (upscale) once, briefly, for hero deliverables;
  no nagging.
