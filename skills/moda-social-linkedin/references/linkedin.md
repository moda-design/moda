# LinkedIn — document posts, feed images, and profile art

## The size family

| Format | Size | Category | When |
|---|---|---|---|
| Link / landscape image | 1200×627 | `social` | the feed default for link-style posts |
| Portrait post image | 1080×1350 | `social` | type-led posts that want feed height |
| Square post image | 1080×1080 | `social` | quote cards, stat cards |
| Document-carousel page | 1080×1350 | `carousel` | 6–10 pages; 1080×1080 also renders well |
| Profile banner | 1584×396 | `social` | personal profile |
| Company page cover | 1128×191 | `social` | very short strip |

## The document post — the format that defines this platform

A LinkedIn carousel is not an image carousel: it is a **document upload**, and
the deliverable is **ONE multi-page PDF**. Exporting a zip of pngs is the single
most common failure on this lane — png/jpeg multi-page exports arrive as a zip,
so carousels export `--format pdf`.

Consequences for the design:

- LinkedIn renders document pages SMALL in the feed and the reader swipes with a
  thumb. Headline-first pages, one idea each, body type no smaller than ~34px at
  1080 wide, and no two-column layouts.
- Page 1 is a cover: the promise in 5–9 words, no logo. The last page carries the
  one ask.
- Bottom-centre ~60px of each page is overlapped by LinkedIn's page counter —
  keep it clear.
- 6–10 pages is the working range. Past 12, completion collapses.
- Hyperlinks in the PDF flatten to plain text (`pdf_links_flattened`). Put the
  URL in the caption, never as a clickable page element.

## Feed images

- Link-style posts crop to 1.91:1 — 1200×627 is exactly that shape, so nothing
  is lost. Anything taller is the user's deliberate choice for feed height.
- Copy on a feed image is read in a scroll: one headline, at most one supporting
  line, and the brand mark small.

## Profile banner (1584×396)

The profile photo covers the **bottom-left** corner — roughly a 250px square
starting at the left edge. Keep that region quiet: place the lockup and copy in
the right two-thirds, vertically centred. A name and role plus at most one short
line is the whole budget; anything more is unreadable on mobile, where the
banner is cropped further from both sides.

Person-first when a name is given: the name is the hero lockup and the company
supports it. Company-led only on request — logo plus one value proposition, no
headshots. At least one concept should work with no logo at all.

## Company page cover (1128×191)

A strip, not a canvas: a horizontal lockup, one line of positioning, and a colour
field. Assume the middle 60% is what most viewers actually see.

## Where the rest lives

Markup grammar: `references/markup.md`. Export mechanics — the PDF-not-zip rule,
warnings, pixel ratio: `references/export.md`. Carousel theory (one design system
across N pages, prove page 1 first) lives in the moda-social parent. An animated
LinkedIn post is moda-video.
