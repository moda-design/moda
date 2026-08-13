# Social formats — sizes, safe areas, and craft

Social work is designed on a canvas at the platform's exact pixel size and
delivered as raster exports: `export(canvas_ref, format='png')` (or
`'jpeg'`), `pixel_ratio=2` for crisp feed rendering. A multi-page canvas
exported to png/jpeg arrives as a **zip of one image per page — that zip IS
the IG/TikTok carousel deliverable**. A **LinkedIn carousel is a document
post: deliver ONE multi-page PDF** (`export(format='pdf')`), not a zip.
Single formats: pass `page=N` or keep the canvas single-page.

**Motion belongs to moda-video**: this skill's deliverables are stills
(png/jpeg/pdf; webp has no lane anywhere). An animated ad, motion graphic,
or "make it a video" ask routes to the moda-video skill — Moda DOES ship
motion: animation canvases play their motion live at the canvas link
(mp4/gif files export from the Moda app) and the metered media tools
generate video. When motion comes up mid-build here, hand the motion to moda-video
and keep the still formats' sizing/safe-area rules from this document.
Never fake motion or silently deliver a static file for an animated ask.

## Canvas sizes (create with `canvas_create(width=…, height=…)`)

| Format | Size | Notes |
| --- | --- | --- |
| IG/FB square post | 1080×1080 | also LinkedIn carousel slides |
| IG portrait post / carousel slide | 1080×1350 | 4:5 — the IG default |
| Story / Reel cover / TikTok / 9:16 ad | 1080×1920 | vertical |
| LinkedIn/X landscape link image | 1200×627 | |
| LinkedIn profile banner | 1584×396 | see safe area below |
| X header | 1500×500 | |
| YouTube thumbnail | 1280×720 | |
| Leaderboard web ad | 728×90 | above the article |
| Large leaderboard / billboard | 970×90 / 970×250 | premium placements |
| Medium rectangle (MPU) | 300×250 | the display workhorse |
| Skyscraper / half page | 160×600 / 300×600 | sidebar tall |
| Mobile banner | 320×50 / 320×100 | tiny — type only |

A bare "banner ad" request means build BOTH 728×90 and 300×250. Never
landscape for feed carousels — it wastes mobile real estate. A one-off with
no platform attached (quote card, simple standalone graphic): default
1080×1080 sized to purpose, `category='other'`, deliver png (pdf on request)
— and the effort rule applies: go direct, no concept fan-out.

## Safe areas (design full-bleed; keep essentials inside)

The safe zone is not a margin: backgrounds, textures, and bleed elements go
edge-to-edge — only text, logos, CTAs, and focal points must stay inside.

- **TikTok post (1080×1920)**: UI covers top y 0–190, right rail x 900–1080
  (y 190–1780), bottom y 1780–1920. Safe zone **x 120–840, y 252–1742**.
- **TikTok ad**: extra CTA chrome — bottom reserved from y 1400. Safe zone
  **x 120–840, y 252–1280**. Assume a normal post unless the user says ad.
- **IG feed/carousel**: platform chrome overlays ~60px top, ~50px bottom,
  ~50px top-right — keep essentials in a centered ~960×1200 (on 1080×1350).
- **LinkedIn carousel**: bottom-center ~60px is overlapped.
- **LinkedIn banner (1584×396)**: the profile photo covers the bottom-left —
  keep that quiet, place content center/right (right two-thirds), keep copy
  to a name/role and at most one short line.
- **Web ads**: keep type and CTA 8–10px off every edge (networks add a
  border at serve time); 4–6px on 320×50, never touching.

## Craft — organic posts and carousels

- Each concept is a nameable aesthetic **direction**, not a rearrangement:
  different world, different headline face, different background treatment
  (solid / gradient / generated pattern / photo / shader — directory in
  references/design-quality.md), at least one type-led and one image-led,
  never all-dark or all-light across a set. Default to ONE committed concept
  unless the user asks for options.
- **A carousel is one design system across N pages** (5–8 IG, 6–10
  LinkedIn): lock 2–4 colors, exactly two fonts, one grid, one repeating
  motif — then vary composition per slide (full-bleed type, number-hero,
  split, quiet slide, pull-quote, photo-led) so adjacent slides never repeat
  a layout. Slide 1 is the hook (5–9 words, no logo — branding on slide 1
  reads as an ad); the last slide carries the one ask and the brand. Build
  slide 1 alone first, screenshot it, and prove the look before authoring
  the rest.
- One stat per slide: numeral oversized in the accent, unit set smaller with
  an inline `<span>` (requires `format="html"` on the `<text>` node), source
  in a small footer. Arrows are real elements
  (`<line … arrow-end="triangle"/>` or an icon), never a "→" glyph. Skip
  custom pagination dots — platforms draw their own.
- **AI-slop defaults to avoid**: centered headline + subhead + pill button
  on a flat fill; glass cards floating on a gradient; purple/blue gradients
  with no point of view; rounded corners and soft shadows everywhere; the
  same layout with colors swapped; every concept in the same brightness.
- Headline faces to avoid unless the brand kit names them: Inter, DM Sans,
  Roboto, Montserrat, Poppins, Oswald, Bebas Neue, Space Grotesk.

## Craft — ads (paid social and display)

- **Write the idea first, in one sentence**: "For [audience], [brand] is the
  [category] that [single claim]." Then the Rule of One — one audience, one
  promise, one ask; kill every secondary message.
- **Stopping power** before clarity: one element dramatically larger than
  everything else, color that violates the feed, a deliberate crop, exactly
  one focal point. Squint test: if the blurred draft still shows what it's
  for and where the eye lands, it works.
- Headline and visual are ONE idea — if the headline works pasted on a
  different image, the lockup is weak. Never describe the image.
- Run the brand's **distinctive assets** (logo, colors, device, tagline) at
  real scale in every concept. Multiple concepts get different playbooks
  (product-as-hero, before/after, visual metaphor, typographic manifesto,
  category-code reversal, testimonial, problem-solution) — not variants of
  one playbook.
- **Display banners**: one message; hierarchy hook → brand → CTA with brand
  and CTA both visible; the CTA is always button-shaped and the
  highest-contrast element ("See the demo", never "Learn more"). Photography
  is expensive at these sizes — prefer solid color, gradients, shapes, type,
  and `<generate>` patterns; a product silhouette over scenic imagery.
- **LinkedIn banners**: person-first when a name is given (name as the hero
  lockup; the company supports). Company-led only on request: logo + one
  value prop, no headshots. At least one concept should work with no logo.

## Generated backgrounds

`<generate>` (grammar and limits in references/markup.md) makes dot grids,
rings, and hatching cheaper than imagery. Keep the pattern the backdrop:
confine it to a quadrant, strip, or radial source; contrast it against the
content (round dots behind hard-edged slabs) rather than echoing it. Cheap
depth: two stacked rectangles, the back one offset 6–8px at low opacity.

## Style references and resizing

- An attached image is either a **style reference** (a designed piece —
  rebuild its layout, type treatment, and palette) or a **content image** (a
  clean photo — place it as subject matter). Complex reference backgrounds
  that shapes can't rebuild: `media_generate_image` with the reference
  attached (metered) for a clean background carrying its palette and
  texture, then compose on top. Copy over a photo always gets a scrim.
- Adapting a design to another platform size: there is **no page-resize
  tool**. Add a page at the target size in `canvas_edit` code
  (`create('page', { width, height })`), copy the elements over with
  `duplicate(ids, { destinationPageId })` (references/edit-code.md), then
  reposition and re-scale each element by hand — never let a composition
  squish, and re-check type against the ladder floor at the new size.
