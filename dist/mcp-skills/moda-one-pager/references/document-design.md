# Document design — PDFs, one-pagers, reports

Scope decides the deliverable, so settle it first:

- **One page** (one-pager, handout, flyer, single printable) → build **1 committed concept**: pick the strongest direction for the content and brand, plan it in a paragraph (layout structure, visual density, type hierarchy, accent treatment), then build that page end to end on one canvas. Author alternate directions only when the user explicitly asks for options — a second concept roughly doubles wall-clock and canvas churn for a deliverable the user asked for once.
- **Multi-page** (report, guide, proposal, or any request naming several pages) → build **1 cohesive document**, not alternates. Plan one visual system — grid, margins, type, palette, headers/footers — plus a page-by-page outline, then vary page layouts only as the content needs.

Default page size is US Letter: `canvas_create(name='…', width=816, height=1056)` (A4: 794×1123). Typography is the document ladder — body ≈ 11px at US-Letter size, floor 11px (compute per references/design-quality.md).

## Making it good

- **Pack the page.** A PDF is read up close, not across a room — it should be information-dense, and text-only is boring. Icons, dividers, stat rows, and cards break up prose and carry structure.
- **Keep backgrounds print-friendly.** Simple fills and rules; do NOT generate images for PDF backgrounds.
- **Never encode a comparison in semantic red/green** ("problem vs solution", "before vs after"). Differentiate with layout, weight, or tonal variations of the brand palette.

## Balance the vertical composition

Content top-packed with a large empty band under it reads as unfinished — but forcing oversized type or stretched spacing to fill every pixel reads worse. When the content is shorter than the page, distribute the slack as deliberate spacing between sections, and/or anchor a natural closing element (signature block, sign-off, date line, footer) near the bottom margin so the whitespace sits inside the body.

Mechanically: a page-spanning top-level `<column justify="space-between">`, or an empty `<row height="fill" />` as a flexible spacer above a trailing block. Note that a tall fixed `height` does NOT push children down — they top-pack, so a `height="340"` column whose children total 234px just leaves 106px empty below it.

If the user's instructions contradict any of the above, follow the user.
