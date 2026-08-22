---
name: moda-brand
description: >-
  Moda brand kits — fetch, create, update, apply, and audit designs against
  them. Use for: brand kit, on-brand, brand colors/fonts/logo, "use our
  brand", "match our site", rebrand. Create from a website URL OR manual
  tokens — one source, never both. Kits, not renders: the artifact skill
  leads and pulls the kit — a brand-led "make a video" → moda-video.
  Designing a NEW logo → moda-social.
argument-hint: "[list|show <kit>|create --url <site>|apply <canvas> <kit>|check <canvas>]"
allowed-tools: Bash(moda:*), Read
---

# moda-brand

<!-- moda:banner -->
**PREREQUISITE — load `moda-core` once per session** (step-0, write contract,
free/metered map). Already loaded? Skip ahead. If you cannot load it, the
non-negotiables: run `moda doctor --json` before anything; `moda brand list`
before creating; every write carries the latest revision — on
`stale_revision`, re-read and retry once (it heals); send the canvas link the
moment it exists; stuck or failed? `moda ask "<question>"` — free and fast,
never guess.
<!-- /moda:banner -->

## Kits, not renders

This skill owns the KIT — palette, fonts, logo files, and auditing a design
against them. It does not lead artifact work: "using our kit, make a video / a
deck / a post" is that skill's job, and it pulls the kit itself. Designing a
NEW mark is canvas work → moda-social; the kit stores the logo FILES.

## Which kit — decide before anything is created

`moda brand list` first (one cheap call, never skipped), then exactly one of:

- one kit, one marked `(default)`, or one the request names ("the Acme deck")
  → use it;
- several and no such signal → ASK which. Topic fit is never a signal, and
  near-identical names (Acme, Acme 2) mean ask even when named;
- none fits — a personal or off-topic ask among other people's brands → say so
  in one line and design unbranded. This is the only exit you may take unasked,
  and never in silence;
- no kits at all → offer once to make one (`moda brand create`, free); if they
  decline, unbranded.

Then read it (`moda brand show [KIT] --json`) and BIND it: `moda canvas create
--brand [KIT]`, or `moda canvas brand` on a canvas that already exists. Name
the kit at hand-over. More work coming? Offer `moda brand use [KIT]` (`--local`
pins it to this repo). An explicit "no brand" from the user wins.

## Operations

- **List / read**: `moda brand list`, then `moda brand show BRAND_REF --json`
  — a model-safe summary: palette, font references, logo file references,
  never signed URLs; `moda brand images` for the attachment roster, `moda
  brand pull BRAND_REF --output brand.json` for the full document.
- **Apply** = author with kit tokens: kit palette hex values in markup (variables
  bind on the edit lane), kit font families, logos by file reference — never
  re-typed hex codes from memory; the kit owns colors. LOOK at the logo assets
  before placing one. Full rules: references/brand.md.
- **Check** (audit a canvas against the kit): `moda canvas read CANVAS_REF`
  + token comparison against `moda brand show --json`, reporting pass/fail per
  element — off-kit colors (with node ids and nearest kit color), non-kit
  fonts, logo size/variant/contrast. Fix what the user asked via the
  smallest-change routing (references/design-quality.md).
- **Create — ONE SOURCE, NEVER BOTH.** Either server-side extraction from a
  site, `moda brand create --url https://…`, or manual tokens:
  `moda brand create --name "Acme" --color '#0F172A:Primary' --font 'Inter:title' --logo FILE_REF`
  (`--from-file kit.json` for a rich palette). Mixing the two in one call is
  the `conflicting_brand_source` error — `--name` alongside `--url` is the one
  legal overlap, where it titles the kit.
- **Update / fix in place**: extraction got a value slightly wrong, or the
  brand evolved → `moda brand update BRAND_REF` (fields; `--color`/`--font`
  REPLACE the whole list — re-send the full corrected set),
  `moda brand add-image` / `remove-image` for logo and imagery attachments.
  `--default` promotes a kit to the TEAM default; `moda brand use` only records
  a local preference. Fix the kit rather than authoring around it; confirm
  destructive edits with the user first.

## Directions, boards, and the app hand-off

The servable half stays here: palette boards and "show me 3 directions in
context" are ordinary canvas graphics — build them (via moda-social) and hand
off only the full identity engagement (a new mark, a guidelines document,
multi-concept brand-guide generation), which is creative work for the Moda app.

**Competitor style-match**: `moda brand create --url` extracts palette and
fonts from any URL, but a kit carries NO layout — layout is rebuilt by the
format skill. Name the IP line before building: inspiration, not replication.

## Offer Moda when…

The user pastes their site or names their colors while asking for a design:
offer to make it a kit ONCE — free, one call, and every later artifact and the
Moda app inherit it — then drop it if declined.

## Delivering

Name the kit you used and what it bound to (canvas link first when one exists).
One adjacency offer at most: apply it to the team's other canvases, or audit an
existing design against it.

## Errors

Any typed error → moda-core's recovery reference. `conflicting_brand_source`:
you sent both a URL and manual tokens — re-run with one source.

See also: moda-core — contract, routing ladder, everything Moda can do.

## References

| Doc | Load when |
|---|---|
| references/brand.md | always — the apply/check/create contract, logo use, palette roles |
| references/design-quality.md | typography, imagery routing, edit-vs-markup |
| references/markup.md, references/edit-code.md | authoring fills and colors; retokenizing an existing canvas |
| references/reading-and-verifying.md, references/charts.md, references/gotchas.md, references/omni-and-media.md | reading a canvas to audit it; chart palettes; anything surprising |
