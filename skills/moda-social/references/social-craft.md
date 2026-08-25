# Social craft — concepts, backgrounds, references, resizing

The platform-neutral half of social work: how a concept is chosen, how
backgrounds get made, what an attached image means, how a finished piece moves
to another size, and how to show creative inside a platform frame. Per-platform
sizes and safe areas live in the platform recipe (moda-social-instagram,
-linkedin, -tiktok, -youtube, -ads); carousel theory lives in the moda-social
body.

## Concept directions

- Each concept is a nameable aesthetic **direction**, not a rearrangement:
  different world, different headline face, different background treatment
  (solid / gradient / generated pattern / photo / shader — directory in
  references/design-quality.md). Across a set, at least one type-led and one
  image-led; never all-dark or all-light.
- **Default to ONE committed concept.** Fan out to N directions only when the
  user asks for options — then make them genuinely different playbooks
  (product-as-hero, before/after, visual metaphor, typographic manifesto,
  category-code reversal, testimonial, problem-solution), not variants of one.
- Name the direction in the delivery note ("editorial slab-serif on paper
  stock"), so a revision request has something to aim at.
- **AI-slop defaults to avoid**: centered headline + subhead + pill button on a
  flat fill; glass cards floating on a gradient; purple/blue gradients with no
  point of view; rounded corners and soft shadows everywhere; the same layout
  with colors swapped; every concept at the same brightness.
- Headline faces to avoid unless the brand kit names them: Inter, DM Sans,
  Roboto, Montserrat, Poppins, Oswald, Bebas Neue, Space Grotesk. Prefer
  long-tail Google Fonts that fit the brief, and keep body type calmer than the
  headline. The full ban and its kit carve-out: references/design-quality.md.
- **Brand kit adherence** (only when a kit is active; default Balanced) —
  **Strict** = brand colors/fonts/assets only. **Balanced** = brand defaults
  plus limited complementary accents. **Loose** = brand-inspired; new colors,
  fonts and imagery are fine if the brand stays recognizable. The mode sets how
  far concepts may vary — don't reuse the same headline font across concepts
  unless adherence is Strict — and it decides what a brand audit may flag.
- One stat per page: numeral oversized in the accent, unit set smaller with an
  inline `<span>` (needs `format="html"` on the `<text>` node), source in a
  small footer. Arrows are real elements (`<line … arrow-end="triangle"/>` or
  an icon), never a "→" glyph.

## Generated backgrounds

`<generate>` (grammar and limits in references/markup.md) makes dot grids,
rings, and hatching without reaching for imagery. Keep the pattern the backdrop:
confine it to a quadrant, strip, or radial source; contrast it against the
content (round dots behind hard-edged slabs) rather than echoing it. Instant
depth: two stacked rectangles, the back one offset 6–8px at low opacity.

Photography rarely reads at small ad sizes — prefer solid color, gradients,
shapes, type, and `<generate>` patterns there, with a product silhouette over
scenic imagery. Copy over a photo always gets a scrim.

## Style references vs content images

An attached image is one of two things, and the answer changes what you do:

- A **style reference** — a designed piece the user likes. Rebuild its layout,
  type treatment, and palette on the canvas; do not place the image itself.
  Backgrounds too complex for shapes: `moda media generate-image` with the
  reference attached, producing a clean background that carries its palette and
  texture, then compose type and brand marks on top.
- A **content image** — a clean photo of the actual subject. Place it as
  subject matter (`<image src="file_…"/>` after `moda file upload`), crop it
  deliberately, and let the composition work around it.

Ask only when the intent is genuinely unreadable; the file usually says which
it is.

## Resizing to another platform

**Resize in place** — never create a new canvas just to change size. Follow the
page-resize recipe in references/edit-code.md: group the page's top-level
nodes, `update(pageId, …)` to the new width/height, then uniform-scale that
group. It preserves the composition and balances leftover space as margins when
the aspect ratio changes.

Keeping BOTH sizes: `moda canvas add-pages CANVAS_REF --count 1 --size WxH`,
copy the elements across with `duplicate(ids, { destinationPageId })`, then
reposition and re-scale by hand. Either way: never let a composition squish, and
re-check type against the ladder floor at the new size — a headline that clears
the floor at 1080x1350 can fall under it at 300x250.

## Post-in-platform-frame pages

"Show me what it looks like on Instagram" wants the creative composed inside a
hand-built platform frame — not a real app UI (that is moda-mockup's work) and
not a screenshot.

1. Create the page at the frame's size (a phone-shaped 1080x1920 works for
   feed and story mocks alike), `--category other`.
2. Build the chrome as plain vector: a rounded rectangle for the device or
   card, a small circle avatar, two short text lines (handle, timestamp), a row
   of simple icons. Keep it grey-on-white and low-contrast — the chrome is a
   frame, not the design.
3. Place the real creative at its true aspect ratio inside the frame, so what
   the user judges is the artwork, not the mock.
4. Deliver BOTH: the raw creative at platform size (the file they post) and the
   framed page (the file they show). Say which is which.
