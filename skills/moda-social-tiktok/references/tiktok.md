# TikTok — 9:16 stills, safe areas, and cover craft

Everything on TikTok is 1080×1920. There is no second size.

## The safe-area map (the reason this file exists)

Design full-bleed; only text, logos, CTAs and focal points respect the zones.

- **Post**: the UI covers the top band y 0–190 (account and sound chrome), the
  right icon rail x 900–1080 across y 190–1780 (avatar, like, comment, share,
  spinning disc), and the caption band y 1780–1920.
  **Safe zone: x 120–840, y 252–1742.**
- **Ad**: everything above, plus CTA chrome that reserves the frame from y 1400.
  **Safe zone: x 120–840, y 252–1280.** Assume a normal post unless the user
  says ad — the ad zone costs a third of the height.
- The right rail is the one people forget: a headline that is centred on the
  1080 width sits partly under the icon column. Centre on the SAFE width (x
  120–840), not on the canvas.

## Covers

A cover frame does three jobs at three sizes, and the smallest one wins:

1. Full screen while the video loads — the composition.
2. A profile grid tile at roughly 1/6 scale — the title and the subject.
3. A search result thumbnail, cropped further.

So: ≤5 words of title, set large and high-contrast, placed in the upper-middle
of the safe zone; one clear subject; no thin type, no long sentences. Judge the
screenshot shrunk to tile size before delivering — a cover that only reads full
screen is a failed cover.

## Photo-mode posts

TikTok photo mode is a swipeable still set. It follows the carousel discipline
in the moda-social parent (one design system, prove page 1 first) with two
TikTok-specific rules:

- Every page is 1080×1920 and obeys the post safe zone — the UI does not go away
  between photos.
- The deliverable is a **zip of per-page pngs** (multi-page png export), one
  image per photo, in order.

## Typography at 1080×1920

Body ≈ 48px, floor 32px. Vertical video is read in motion, often one-handed, and
the platform compresses hard: below the floor, strokes disappear. Titles run
90–160px. Set type in the safe width and let backgrounds bleed.

## What this skill does NOT own

An actual TikTok **video** — the clip itself, a motion cover, anything delivered
as mp4 or gif — is moda-video: render format outranks platform. This lane owns
the still: the cover frame and photo-mode pages.

## Where the rest lives

Markup grammar: `references/markup.md`. Type ladder, imagery, shader directory
and the AI-slop list live in the design-quality reference fanned to the parent.
