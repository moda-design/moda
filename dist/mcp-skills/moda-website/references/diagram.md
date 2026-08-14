# Diagrams, 2×2 matrices, and UI wireframes

Three intents, one deterministic toolkit: shapes with embedded text,
`<connector>` for anchored links, `<path>` for custom marks, containers for
lanes, lint to catch collisions, and `export(format='png'|'pdf')` (png at
`pixel_ratio=2` for docs and chat; pdf when it's headed into a document).

## Diagrams and flowcharts

A diagram's job is to make structure legible at a glance. Clarity beats
exhaustiveness: few primitives, short labels, consistent sizing and spacing,
flow top-to-bottom or left-to-right unless asked otherwise. Detail that
doesn't fit a box belongs in a caption outside the flow.

- Draw links with `<connector>`, never hand-placed lines — connectors stay
  anchored when a node moves, including across later incremental edits.
  Full grammar in references/markup.md; the load-bearing rules: `from`/`to`
  take `@Target:top|bottom|left|right`, and the target resolves in three
  passes — a name from the SAME markup call, a direct node id, or a UNIQUE
  node name already in the scene (take ids and names from
  `canvas_read`, and prefer ids when names repeat). Both endpoints must sit on the
  same page, and within one call the target element must appear BEFORE the
  connector that references it. `routing="straight|elbowed|curved"`
  (`elbowed` takes `corner-radius`); labels via `text` + `text-position`;
  connectors do NOT work inside flex containers — position connected nodes
  with absolute x/y.
- Color carries meaning: neutral for ordinary steps, green for success, red
  for failure, the accent for emphasis only — never on every node.
- Node text is the type anchor; connector labels and captions step down.
- Swimlanes / architecture / multi-section: build real lanes with containers
  and alignment (`group="true"` when a container must be a connector
  target), and keep routing simple enough to avoid crossings.

```xml
<content font-family="DM Sans">
  <rectangle name="Validate" x="160" y="160" width="180" height="56" fill="#ffffff" stroke="#d4d4d8"
             corner-radius="12" text="Validate input" font-size="16" font-weight="600" color="#3f3f46" />
  <rectangle name="Error" x="280" y="300" width="160" height="56" fill="#fef2f2" stroke="#f87171"
             corner-radius="12" text="Error" font-size="16" font-weight="600" color="#dc2626" />
  <connector from="@Validate:bottom" to="@Error:top" routing="elbowed" arrow-end="triangle"
             stroke="#f87171" dash="dashed" text="Invalid" text-position="0.5" font-size="14" color="#dc2626" />
</content>
```

## Standalone data charts

A bar/line/pie/scatter graphic that stands alone rides `<chart>` — the
parser does the math from a pipe-delimited data block; full grammar and
data-honesty rules in references/charts.md. Give it its own right-sized
canvas, title it, and export png. The 2×2 matrix below is the deliberate
exception: shapes and text, not `<chart>`.

## 2×2 matrices (competitive landscape, quadrant chart)

Build with shapes and text — **not `<chart>`** (it doesn't support this
format). Inside-out:

1. **Axes**: two centered lines forming a cross, 2–3px neutral gray
   (`#cbd5e1`), the matrix filling ~70–80% of the canvas.
2. **Four pole labels** at the axis ends (~28px on a 960×540 slide, muted) —
   and only those four; no ticks, no grid. Desirable poles go **top** and
   **right**. No axes given? Propose a pair that fits the space ("Legacy →
   AI-First" vs "Point Solution → Platform"; "Manual → Automated" vs "SMB →
   Enterprise").
3. **Competitor plots**: 3–6 competitors (more clutters), spread across the
   OTHER three quadrants realistically — never in the winning quadrant. A
   plot is a small filled circle (20–28px, muted) with a name label under
   it; when the user supplies logo files or URLs, upload them
   (the `upload` tool — it takes URLs too) and place 40–60px image fills
   instead, one consistent treatment for all.
4. **The user's company** in the **upper-right**: larger (56–72px or a 32–40px
   accent circle), name in the accent color, clearly separated.
5. Optional title above, 24–32px bold. Group the matrix elements so they
   move as one unit.

## UI wireframes and mockups

A static picture of an interface — not a live page (that is the website
skill). Pick the viewport before composing; it decides everything:

| Viewport | Canvas | Pattern |
| --- | --- | --- |
| Desktop app / dashboard | 1440×900 | sidebar nav, multi-column |
| Marketing/landing mockup | 1440×2000+ | tall single scroll |
| Tablet landscape / portrait | 1024×768 / 768×1024 | split view / single column |
| Phone (iOS / Android) | 390×844 / 412×915 | single column, bottom nav |

- UI type uses **real OS point sizes**, not display-scaled canvas type: body
  small but legible, headings stepping up by viewport. Cut copy before
  shrinking below the ladder floor (references/design-quality.md).
- Phone safe bands: ~47pt status bar top, ~34pt home-indicator / ~16dp
  gesture area bottom; touch targets ≥44pt; no hover-only affordances.
- Nest `<row>`/`<column>` for the chrome — shell, sidebar, header, card
  grids — and reserve absolute x/y for decorative accents and full-bleed
  blocks. Icons come from `<image icon="query"/>` or
  `file_search(kind='icon')` (the shared packs ARE the stock icon
  library); product screenshots from uploads or
  `media_generate_image`.
- Push past three-equal-cards: a bento grid (a 2fr feature beside stacked
  1fr cards), a full-bleed color block carrying nav + hero, oversized
  low-opacity step numerals, colored overline labels. A mockup with a point
  of view beats a gray wireframe — unless the user asked for a wireframe,
  in which case grayscale boxes, real hierarchy, and honest labels win.

## Verify and deliver

Lint after each section (`canvas_read(lint=true)` — overlapping-node and
contrast findings matter most here), screenshot and LOOK: no connector
crossing a node, no label collisions, consistent gaps. Deliver png
(`pixel_ratio=2`) for chat/docs, pdf for print/documents, and the canvas
link — diagrams get
edited later more than any other format.
