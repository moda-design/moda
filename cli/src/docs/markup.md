# moda canvas markup — XML markup reference (offline copy)

`moda canvas markup CANVAS_REF --file page.xml [--page PAGE_ID] [--mode append|replace]`
applies XML markup to a page. It is partial-success: elements that fail are skipped and
reported; the mutation still commits (exit 0 with `requires_repair: true`). `--mode replace`
is an atomic full-page rewrite — deletion happens only after a clean parse, and it requires a
revision token (`moda canvas read` first, or `--revision`).

## Root and flow

- All markup wraps in `<content>`. Its attributes (e.g. `font-family`) become defaults for
  every text descendant.
- `<content padding="60" gap="40">`: `padding` offsets all top-level elements; `gap` (or any
  non-zero padding) enables vertical flow — elements without an explicit `y` auto-stack.
- Floating nodes: `--page canvas` makes `x`/`y` canvas-absolute (Design canvases only).

## Elements

- Shapes: `<rectangle>`, `<ellipse>`, `<polygon>`, `<star>`, `<line>`, `<connector>`, `<path>`.
- Layout: `<row>`, `<column>`, `<layers>`, `<group clip="true">` (first child is the mask).
- `<text>`: `font-size`, `color`, `text-align`, `format="markdown|html"` for rich text.
- `<image src="…">` or `<image icon="search query">`; `fit="cover|contain"`. Images are
  pattern fills — use `image(REF)` fills with the short refs `moda file upload` returns.
- Generated: `<chart>` (pipe-delimited `<data>` block), `<qr>`, `<latex>`, `<map>`.
- `<background fill="…">` — native page background (colors, gradients, `shader(...)`).
- `<table>` — HTML `<tr>/<td>/<th>`; zebra via `background-colors`; headers via `<th>`.
- Programmatic: `<repeat count="N" as="i">` with `{expression}` interpolation;
  `<generate>` blocks calling `emit(tag, attrs)` (caps: 2,000 emits / 4,096 chars per block).
- `<styles>` class blocks; `$variable` references in fills.

Caps: 5,000 elements per apply; 1,000 per `<repeat>`. Cannot author `<blend>`/`<container>`.

## Sizing

- Flex child sizing: px, `fill`, `1fr`, `hug`, `half`/`third`/`50%`. `fill` on a ROOT
  container errors — use `hug` or explicit dimensions.
- Child `x`/`y` inside a row/column are relative offsets from the flex slot.
- `corner-radius="full"` = pill/circle; per-corner `"TL,TR,BR,BL"`.
- Effects: `shadow="x,y,blur,color"`, `blend-mode`, text `glow`/`echo`/`extrude`.
- `rotation` is clockwise degrees around the shape's center.

## Discipline

1. Read first: `moda canvas read` returns the DSL with short ids (`n7`, `p_a`) + the revision.
2. Mutate, then inspect: `moda canvas screenshot` / `moda canvas lint`. Mutations never
   attach screenshots — the revise loop is explicit.
3. On `requires_repair: true`, read the warnings and author a corrective edit; do NOT re-run
   the same command.
4. A hallucinated image ref produces an `image_load_failed` warning — refs come from reads,
   uploads (`moda file upload`), or brand kits (`moda brand show`).
