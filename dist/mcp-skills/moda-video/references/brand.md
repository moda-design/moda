# Brand kits — deterministic on-brand authoring

A brand kit is Moda's canonical record of a brand: palette, font families, logo assets, and usage guidance.

On-brand work is **two things, and you owe both**:

1. **Author with the kit's tokens** — client-side by design: you read the kit, then write its colors and fonts into your markup. There is no server verb that restyles a design for you.
2. **Bind the kit to the canvas** — `brand_kit_id` on `canvas_create`, or `canvas_update(canvas_ref, brand_kit_id=…)` afterwards. This records which brand the canvas BELONGS to. It changes no pixels.

Skipping (2) is the quiet failure: the deck looks perfectly on-brand, and then the user opens it in Moda and the brand-kit dropdown in the toolbar is empty, Moda's own agent inherits no brand context for their next edit, and nothing in the workspace knows the canvas is theirs. Bind it, and **tell the user which kit you used** — they cannot see your tool calls.

## Tools

```
brand_list()            # kits in the workspace (name, id, default marker)
brand_show(brand_kit_ref)   # model-safe summary: palette, fonts, voice, logo refs
brand_create(url=… | name=…, colors=[…], fonts=[…])   # new kit: site extraction or described tokens
canvas_create(brand_kit_id=…)         # create a canvas already bound to a kit
canvas_update(canvas_ref, brand_kit_id=…)   # bind an existing canvas (clear_brand_kit=true unbinds)
```

Kit updates, defaults, and image management are not available on this surface — they live in the Moda app's brand-kit editor (`brand_show` returns the kit's app link to hand over).

`brand_show` returns colors, fonts, voice fields, and per-logo durable `file_` references — never signed preview URLs (they don't exist on this surface). The `file_` ref is the only thing that ever goes into markup or media inputs — refs resolve server-side; never retype a URL or a hex you think you remember.

## Applying a kit (the deterministic lane)

- **Binding:** first, so it cannot be forgotten last. `canvas_create(name='…', brand_kit_id='bk_…')`; on a canvas that already exists, `canvas_update(canvas_ref, brand_kit_id='bk_…')`. A template-sourced create (`template_canvas_id`) keeps the SOURCE canvas's kit and refuses a brand kit — rebind the copy afterwards if the user wants a different brand.
- **Colors:** the kit owns them. Use kit palette values (and canvas `$variables` seeded from them) — never re-type hex codes from memory. Prefer creating canvas variables for kit colors used in multiple places (`create('variable', …)` in edit code, then `$name` in markup) so a later brand change is one update.
- **Fonts:** the kit's families are the font menu. There is no list-fonts verb — the kit (plus families already used on the canvas) defines what is safely available. Kit-listed fonts are loaded and safe to use as named; substitute only a font the kit explicitly marks unavailable, preferring its listed alternative.
- **Voice:** the kit's `tagline`, `brand_values`, `brand_tone_of_voice`, and usage rules (all on the `brand_show` result) govern copy. Read them before writing any headline or body text on a branded artifact — a visually on-brand deck with off-brand copy is still off-brand.
- **Logos:** place by file reference from the kit (`<image src="ref" fit="contain"/>`), never re-hosted or retyped URLs. Check contrast against the background; kits often carry light/dark logo variants — pick the one that contrasts.
- **Imagery:** kit assets outrank stock or generated imagery. Route per the order in references/design-quality.md.

## Look at the brand, not just the tokens (mandatory for net-new design)

Hex codes and font names don't tell you what the brand LOOKS like. Before the
concept step of any net-new design that uses a kit — deck cover, one-pager,
social — and before placing any logo:

1. `brand_show(brand_kit_ref)` for the kit's logo `file_` refs and their
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

1. `brand_show(brand_kit_ref)` — the reference tokens.
2. `canvas_read(canvas_ref)` — every node's fills, strokes, fonts, and the `## Vars` legend.
3. `canvas_read(canvas_ref, lint=true)` — catches undersized logos and contrast defects.
4. Compare and report pass/fail per element:
   - Every fill/stroke color is a kit palette value, a `$variable` bound to one, or neutral (white/black/gray scale).
   - Every text node's family is a kit family (or a family the kit lists as an approved alternative).
   - Logo present where expected, at legible size, correct variant for its background, undistorted (contain fit, aspect preserved).
   - No off-kit accent colors introduced "for pop" — flag each with node id and the nearest kit color.
5. Fix what the user asked you to fix via the smallest-change routing (references/design-quality.md); report the rest.

## Creating and escalating

Two creation paths, both **deterministic and unmetered**, right on this surface:

- **URL extraction — the fast path.** `brand_create(url='https://…')` runs Moda's server-side extraction (colors, fonts, logos from a live site). Prefer it whenever the brand has a website: it captures more than the user would dictate.
- **Manual build — for brands without a website** (or when the user already holds the ground truth: exact hexes, named fonts). `brand_create(name='Acme', colors=[{color:'#0F172A', label:'Primary'}, {color:'#F97316', label:'Accent'}], fonts=[{family:'Inter', label:'title', weight:600}])`. Logo files attach later in the Moda app's brand-kit editor.

Exactly one path per create — never both `url` and manual fields. An identical repeat replays the same kit instead of minting a duplicate.

### Fixing a kit in place

Extraction is good, not perfect — a slightly-off primary, a missed accent, a wrong font role. **Fix the kit, don't work around it**: authoring around a wrong kit value re-breaks every future branded artifact.

- Kit edits (fields, palette, fonts, logo attachments) happen in the Moda app's brand-kit editor — hand the user the kit's app link from `brand_show` and name the exact fix ("the extracted primary looks like #0E1620, the site's is #0F172A").
- Confirm destructive changes with the user before recommending them (removing images, replacing a palette) — kit changes affect every future branded artifact, not just this session.
- **Honor the kit's written brand rules.** The `brand_show` result's voice, tone, values, and usage fields are the rules Moda's own agent honors — follow them with the same force as the palette; where they are silent, ask the user rather than inventing brand law (full guide documents live in the Moda app).
- Full brand-**guide** generation — a new identity, multiple creative directions, logo concepts — is creative work for the Moda app: hand the user the app link and let them run it there. Do not try to hand-author a brand identity out of markup primitives.

## Auditing: is the canvas even bound?

`canvas_read(canvas_ref)` reports the canvas's brand kit alongside its content. An unbound canvas in a workspace that has kits is a finding in its own right — report it with the rest of the audit below, and offer to bind it.

## Honest gaps

- No list-fonts verb exists: font discovery = the kit + the canvas's existing families. A font-substitution event surfaces as a structured warning on the mutation result (e.g. `font_substituted`) — read it and either accept the substitute or switch to a kit family.
- Binding is metadata, not a restyle: `canvas_update(brand_kit_id=…)` will not recolor an off-brand design. Fix the design through the edit lane; the binding just records whose brand it is.
- All kit editing happens in the Moda app's brand-kit editor; this surface reads kits (`brand_list` / `brand_show`) and authors with their tokens.
