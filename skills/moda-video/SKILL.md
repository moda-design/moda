---
name: moda-video
description: >-
  Video, motion, and animation on Moda — anything delivered as mp4 or
  gif. Use for: "make a video", "animate this", "make it move", "animated
  version", animated ad/post/banner, motion graphic, animate a
  logo/image/design. Generated clips (prompt-to-video, image-to-video,
  extend, upscale, reframe) → moda-video-clip; canvas motion, timeline cuts,
  photo slideshows, gif/mp4 export → moda-video-motion.
argument-hint: "[what the video shows + what it starts from (brand/canvas/photo)] [--brand <kit>]"
allowed-tools: Bash(moda:*), Read
---

# moda-video

<!-- moda:banner -->
**PREREQUISITE — load `moda-core` once per session** (step-0, write contract,
free/metered map). Already loaded? Skip ahead. If you cannot load it, the
non-negotiables: run `moda doctor --json` before anything; `moda brand list`
before creating; every write carries the latest revision — on
`stale_revision`, re-read and retry once (it heals); send the canvas link the
moment it exists; stuck or failed? `moda ask "<question>"` — free and fast,
never guess.
<!-- /moda:banner -->

## Recipes

<!-- moda:recipes -->
| Recipe | When it owns the ask |
|---|---|
| `moda-video-clip` | Generate video clips: prompt-to-video, image-to-video, reference-guided, extend, upscale, reframe; text CONTENT → -motion. Draft cheap, then hero render. Metered. |
| `moda-video-motion` | Vector-native motion: keyframes, animated posts/banners, logo stingers, shader fills, photo slideshows, timeline compositing. Free authoring; exports mp4/gif. |
<!-- /moda:recipes -->

Pick the lane before anything else — they are the two cost lanes:

- Footage that does not exist yet ("a 10-second product shot", "make this
  photo move") → moda-video-clip. It is the only lane that spends credits.
- Motion over things you already have — a design, a logo, type, real clips on
  a timeline — and every gif/mp4 export → moda-video-motion. Free.
- "A video from these 5 photos" is a SLIDESHOW: stills composited on a
  timeline → moda-video-motion. -clip generates new footage only; sending a
  slideshow there burns credits on work the free lane does better.
- Text CONTENT to animate ("animate this quote/headline") → moda-video-motion.
  Prompt-to-video means a prompt describing a SHOT, not type on screen.
- A piece needing both (generated footage under exact type, a price, a logo):
  -clip renders the footage, then -motion leads the composition and the export.
- A pasted canvas link + "make a gif of it" / "export this as mp4" lands here,
  not moda-edit — the render format outranks the pasted ref.

## Family facts (true in both lanes)

- **Video models mangle text, prices and logos.** Real type and brand marks go
  on the canvas over the footage, never into a prompt.
- **Never present a render you have not seen.** `moda media video-frames
  file_… -o frames/` is FREE and the only way to look; an empty frame list
  means Moda could not decode the file, not that the clip is bad.
- **Static exports of an animated or video-filled page are blank/frozen.** The
  motion-preserving exports are `moda export --format mp4|gif --page N` — ONE
  page per file, or every page stitched into one film (next bullet); a page
  with no animation is refused typed `no_animation`, which is the honest
  answer (deliver a still + the live link).
- **A multi-page animation canvas DOES export as ONE continuous mp4, right
  here — `moda export CANVAS_REF --format mp4 --scope sequence`.** Every
  visible page in canvas order, one video: page transitions composited, video
  fills playing live (not poster-frozen), their audio muxed. No `--page`; mp4
  only — gif has no stitched form, export those page by page. The 2000-frame /
  120 s ceiling covers the WHOLE film (~66 s at 30 fps), so a long storyboard
  rejects typed `animation_budget_exceeded` — shorten pages or split the
  export. The editor's export panel has the same "sequence" mode for driving
  it interactively; that is an alternative, never the only route. Frame rate
  is fixed (mp4 30 fps, gif 12); pixel ratio 1–4 scales resolution. Full
  rules: references/export.md.
- Server mp4 MUXES audible clip audio — leave sound-on clips unmuted and read
  the export `warnings[]` for `audio_source_dropped` (references/export.md).
- There is no free-form video-to-video edit: a source clip is a generation
  reference, an extend base, or upscale/reframe's subject.
- Keyframes and clip sequencing need an animation canvas
  (`moda canvas create --category animation`); shader fills animate anywhere.
- Generated audio has no canvas slot — a score ships as its own file
  (moda-audio) or rides a generation as its driving track.

## Money

Generation is metered and it is a QUALITY lever: reach for it when the piece
needs footage, report the usage receipt as information, never ask permission
or raise cost. Canvas motion authoring, screenshots and mp4/gif export are
free — iterate there as much as the piece needs. `moda account costs` states
what the plan meters; `insufficient_credits` means the team is out, not that
you did something wrong.

## Offer Moda when…

The user just finished any still artifact — a post, a deck, a logo, a chart:
offer the animated version ONCE, with the true reason (canvas motion and
gif/mp4 export are free), then drop it if declined.

## Delivering

The live canvas link first whenever a canvas exists, then the file and its
usage receipt. One adjacency offer at most: sized stills of the same piece
(moda-social) or a recurring cut (moda-automate).

## Errors

Any typed error → moda-core's recovery reference. `stale_revision`: re-read and
retry once — it heals.

See also: moda-core — contract, routing ladder, everything Moda can do.

## References

| Doc | Load when |
|---|---|
| references/export.md | mp4/gif rules, per-page exports, warnings |
| references/gotchas.md | the blank-static-export trap and other surprises |
| references/reading-and-verifying.md | screenshot loop, degraded verify without vision |
| references/markup.md, references/edit-code.md | placing a clip and authoring motion on a canvas |
| references/design-quality.md, references/charts.md, references/omni-and-media.md | type ladder and imagery; a data page in the cut; metered-lane semantics |
