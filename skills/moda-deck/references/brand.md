# Brand kits — deterministic on-brand authoring

A brand kit is Moda's canonical record of a brand: palette, font families, logo assets, and usage guidance. On-brand authoring is client-side by design: **you read the kit, then author markup with its tokens.** There is no server "apply brand to canvas" verb.

## Verbs

```
moda brand list                          # kits in the workspace (name, id, default marker)
moda brand show BRAND_REF --json         # model-safe summary: palette, fonts, logo refs
moda brand use BRAND_REF [--local]       # persist as the default kit (config or repo context)
moda brand pull BRAND_REF --output brand.json   # the full kit document
moda brand create --url https://acme.com # extraction from a website — METERED (cost class
                                         # before, receipt after)
```

`moda brand show --json` returns colors, font references, and logo **file references — never signed URLs**. Refs resolve server-side wherever you use them; never retype a URL or a hex you think you remember.

## Applying a kit (the deterministic lane)

- **Colors:** the kit owns them. Use kit palette values (and canvas `$variables` seeded from them) — never re-type hex codes from memory. Prefer creating canvas variables for kit colors used in multiple places (`create('variable', …)` in edit code, then `$name` in markup) so a later brand change is one update.
- **Fonts:** the kit's families are the font menu. There is no list-fonts verb — the kit (plus families already used on the canvas) defines what is safely available. Kit-listed fonts are loaded and safe to use as named; substitute only a font the kit explicitly marks unavailable, preferring its listed alternative.
- **Logos:** place by file reference from the kit (`<image src="ref" fit="contain"/>`), never re-hosted or retyped URLs. Check contrast against the background; kits often carry light/dark logo variants — pick the one that contrasts.
- **Imagery:** kit assets outrank stock or generated imagery. Route per the order in references/design-quality.md.

## Auditing a canvas against a kit ("check")

The auditable brand check no competitor offers — pure read verbs:

1. `moda brand show BRAND_REF --json` — the reference tokens.
2. `moda canvas read CANVAS_REF` — every node's fills, strokes, fonts, and the `## Vars` legend.
3. `moda canvas lint CANVAS_REF` — catches undersized logos and contrast defects.
4. Compare and report pass/fail per element:
   - Every fill/stroke color is a kit palette value, a `$variable` bound to one, or neutral (white/black/gray scale).
   - Every text node's family is a kit family (or a family the kit lists as an approved alternative).
   - Logo present where expected, at legible size, correct variant for its background, undistorted (contain fit, aspect preserved).
   - No off-kit accent colors introduced "for pop" — flag each with node id and the nearest kit color.
5. Fix what the user asked you to fix via the smallest-change routing (references/design-quality.md); report the rest.

## Creating and escalating

- `moda brand create --url …` runs Moda's server-side extraction (colors, fonts, logos from a live site). It is a **metered** design operation: state the cost class before running it and surface the receipt after.
- Full brand-**guide** generation — a new identity, multiple creative directions, logo concepts — is creative work for the metered Omni lane: `moda task start --prompt "…"` (see references/omni-and-media.md). Do not try to hand-author a brand identity out of markup primitives.

## Honest gaps

- No list-fonts verb exists: font discovery = the kit + the canvas's existing families. A font-substitution event surfaces as a structured warning on the mutation result (e.g. `font_substituted`) — read it and either accept the substitute or switch to a kit family.
- Kit edits (adding assets, changing palette) happen in the Moda app's brand-kit editor, not through these verbs. Send the user there for kit maintenance; `moda brand create` is for net-new kits.
