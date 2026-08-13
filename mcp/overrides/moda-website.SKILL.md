---
name: moda-website
description: >-
  Route website asks to Moda's hosted-site builder, and prepare everything
  that can be prepared here. Use when the user asks for a website, site, web
  page, landing page, marketing site, portfolio site, homepage, coming-soon
  page, "put this on the web", or wants an existing moda.page site updated or
  re-published. Moda hosts real, editable sites at public *.moda.page URLs —
  but building and publishing them is not available through this surface's
  tools: it lives in the Moda app at moda.app. This skill answers questions
  about existing sites (publish state, live URL, pages), says the write
  boundary plainly, routes the user to the app, and does the useful prep
  here (sitemap, copy, brand direction, page mockups on a canvas). For a printable/PDF one-pager use
  moda-one-pager; for slides use moda-deck. Requires the Moda connector
  (Step 0 checks it; accounts live at moda.app).
---

# moda-website

<!--MCP:STEP0-->

<!--MCP:UX-RULES-->

**Override for this skill:** it produces no canvas deliverable of its own and
no export — the canvas/lint/screenshot/`requires_repair` rules above apply
only to the optional mockup step below.

## What this surface can and cannot do

- Moda hosts real, editable, re-publishable websites at
  `https://<slug>.moda.page`. Building, editing, and publishing them happens
  in the Moda app (moda.app), where Moda's agent designs and ships hosted
  sites end to end.
- This surface READS sites: `site_list` (each site's publish state and live
  URL) and `site_show` (one site's metadata, publish state, live URL, and
  page inventory). Use them to answer "what sites do we have", "is it
  live", and "what's on it" — and to grab the live or editor URL to hand
  over.
- The site WRITE tools are not available here. Never fake a publish, never
  invent a `*.moda.page` URL, and never build "a website" as a canvas and
  present it as hosted.

## Workflow

1. **Say it plainly, once**: the site itself gets built and published in the
   Moda app — hand the user https://moda.app and the ask to bring ("a
   three-page marketing site for Acme, using the Acme brand kit"). No
   apology, no hedging, no pretending.
2. **Do the real preparation here** (genuinely useful, not a consolation):
   - **Content**: draft the sitemap, per-page copy, headlines, and CTAs from
     the user's brief, files, and your own research.
   - **Brand**: `brand_list` / `brand_show` for the kit the site should
     follow; fold its palette, fonts, and voice into the drafted copy.
   - **Design comps** (on request): mock key pages as canvas designs — the
     UI-mockup recipe in references/diagram.md — so the visual direction is
     settled before the user builds. Share the canvas link the moment it
     exists.
3. **Deliver**: the prepared material plus the moda.app pointer. An existing
   `*.moda.page` site to change: `site_list`/`site_show` first — say what it
   contains and whether it is live, hand over its URL — then the same
   routing; the app owns site editing and republishing.

## References

| Doc | Load when |
|---|---|
| references/brand.md | a brand kit exists |
| references/diagram.md | mocking pages as canvas designs |
| references/markup.md, references/design-quality.md | authoring mockups |
| references/gotchas.md | anything surprising |
