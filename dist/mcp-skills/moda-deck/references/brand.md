# Brand kits — deterministic on-brand authoring

A brand kit is Moda's canonical record of a brand: palette, font families, logo assets, and usage guidance. On-brand authoring is client-side by design: **you read the kit, then author markup with its tokens.** There is no server "apply brand to canvas" verb.

## Tools

```
brand_list()            # kits in the workspace (name, id, default marker)
brand_show(brand_ref)   # model-safe summary: palette, fonts, voice, logo refs
```

Kit creation, updates, defaults, and image management are not available on this surface — they live in the Moda app's brand-kit editor (`brand_show` returns the kit's app link to hand over).

`brand_show` returns colors, fonts, voice fields, and per-logo durable `file_` references — never signed preview URLs (they don't exist on this surface). The `file_` ref is the only thing that ever goes into markup or media inputs — refs resolve server-side; never retype a URL or a hex you think you remember.

## Applying a kit (the deterministic lane)

- **Colors:** the kit owns them. Use kit palette values (and canvas `$variables` seeded from them) — never re-type hex codes from memory. Prefer creating canvas variables for kit colors used in multiple places (`create('variable', …)` in edit code, then `$name` in markup) so a later brand change is one update.
- **Fonts:** the kit's families are the font menu. There is no list-fonts verb — the kit (plus families already used on the canvas) defines what is safely available. Kit-listed fonts are loaded and safe to use as named; substitute only a font the kit explicitly marks unavailable, preferring its listed alternative.
- **Voice:** the kit's `tagline`, `brand_values`, `brand_tone_of_voice`, and usage rules (all on the `brand_show` result) govern copy. Read them before writing any headline or body text on a branded artifact — a visually on-brand deck with off-brand copy is still off-brand.
- **Logos:** place by file reference from the kit (`<image src="ref" fit="contain"/>`), never re-hosted or retyped URLs. Check contrast against the background; kits often carry light/dark logo variants — pick the one that contrasts.
- **Imagery:** kit assets outrank stock or generated imagery. Route per the order in references/design-quality.md.

## Look at the brand, not just the tokens (mandatory for net-new design)

Hex codes and font names don't tell you what the brand LOOKS like. Before the
concept step of any net-new design that uses a kit — deck cover, one-pager,
social — and before placing any logo:

1. `brand_show(brand_ref)` for the kit's logo `file_` refs and their
   labeled roles/variants (asset preview links don't exist on this
   surface).
2. Place the plausible logo variant on the working canvas by `file_` ref,
   then `canvas_screenshot` and VIEW it with your own vision. Note: mark vs
   wordmark, light/dark variants, the logo's real colors, and the style of
   any brand imagery the kit describes.
3. Author with what you SAW: pick the variant that contrasts with your
   background, and match imagery style to the kit's. Place assets by `file_`
   ref only — never invent or retype asset URLs.

Once per session per kit is enough. Skipping this is how wrong-logo-variant
and off-brand-imagery output happens.

## Auditing a canvas against a kit ("check")

The auditable brand check no competitor offers — pure read verbs:

1. `brand_show(brand_ref)` — the reference tokens.
2. `canvas_read(canvas_ref)` — every node's fills, strokes, fonts, and the `## Vars` legend.
3. `canvas_read(canvas_ref, lint=true)` — catches undersized logos and contrast defects.
4. Compare and report pass/fail per element:
   - Every fill/stroke color is a kit palette value, a `$variable` bound to one, or neutral (white/black/gray scale).
   - Every text node's family is a kit family (or a family the kit lists as an approved alternative).
   - Logo present where expected, at legible size, correct variant for its background, undistorted (contain fit, aspect preserved).
   - No off-kit accent colors introduced "for pop" — flag each with node id and the nearest kit color.
5. Fix what the user asked you to fix via the smallest-change routing (references/design-quality.md); report the rest.

## Creating and escalating

Kit creation is not available on this surface — it lives in the Moda app at moda.app, free, with two paths worth explaining to the user:

- **URL extraction — the fast path.** The app extracts colors, fonts, and logos from the brand's live website. Prefer it whenever the brand has a website: it captures more than the user would dictate.
- **Manual build — for brands without a website** (or when the user already holds the ground truth: a style guide, a logo file, exact hexes), built field by field in the app's brand-kit editor.

Once the user creates the kit there, `brand_list` picks it up here immediately.

### Fixing a kit in place

Extraction is good, not perfect — a slightly-off primary, a missed accent, a wrong font role. **Fix the kit, don't work around it**: authoring around a wrong kit value re-breaks every future branded artifact.

- Kit edits (fields, palette, fonts, logo attachments) happen in the Moda app's brand-kit editor — hand the user the kit's app link from `brand_show` and name the exact fix ("the extracted primary looks like #0E1620, the site's is #0F172A").
- Confirm destructive changes with the user before recommending them (removing images, replacing a palette) — kit changes affect every future branded artifact, not just this session.
- **Honor the kit's written brand rules.** The `brand_show` result's voice, tone, values, and usage fields are the rules Moda's own agent honors — follow them with the same force as the palette; where they are silent, ask the user rather than inventing brand law (full guide documents live in the Moda app).
- Full brand-**guide** generation — a new identity, multiple creative directions, logo concepts — is creative work for the metered Omni lane: `task_start` (see references/omni-and-media.md). Do not try to hand-author a brand identity out of markup primitives.

## Honest gaps

- No list-fonts verb exists: font discovery = the kit + the canvas's existing families. A font-substitution event surfaces as a structured warning on the mutation result (e.g. `font_substituted`) — read it and either accept the substitute or switch to a kit family.
- All kit editing happens in the Moda app's brand-kit editor; this surface reads kits (`brand_list` / `brand_show`) and authors with their tokens.
