---
name: moda-one-pager
description: >-
  Design a one-pager, PDF report, handout, flyer, or printable
  document on Moda. Use when the user asks for a one-pager, single-page summary,
  PDF, report, brief, handout, fact sheet, leave-behind, or "make this
  markdown/README look designed", or an infographic. Multi-page documents
  belong here too — a 12-page report, guide, whitepaper, or proposal — as do
  print pieces: posters, flyers, menus, resumes, certificates, invitations,
  business cards (slides go to moda-deck; social/banner graphics to
  moda-social). Produces designed US-Letter (or A4) pages on
  a live Moda canvas and exports a real PDF with selectable text and hyperlinks.
  Requires the moda CLI and a Moda account (Step 0 checks both; it never
  installs anything itself).
argument-hint: "[source file or topic] [--size letter|a4] [--pages N] [--brand <kit>]"
allowed-tools: Bash(moda:*), Read, Glob, Grep
---

# moda-one-pager

## Step 0 — doctor (always run first; skip nothing)

1. Run `moda doctor --json`. It verifies CLI version compatibility, auth state,
   API reachability, and account entitlements in one call.
   - `moda` is not on PATH, the CLI is below this skill's compatibility floor,
     or doctor reports an update is required: STOP. Show the user the exact
     pinned install/upgrade command doctor prints (or the one in this repo's
     INSTALL.md when the CLI is missing entirely) and wait for them to run it.
     Never install or update anything yourself, never pipe curl to sh, and
     never use sudo.
   - `authenticated: false`: tell the user to run `moda auth login` (opens the
     browser to mint a scoped key; the credential goes to the OS keychain — on
     headless machines use `moda auth login --paste`, or set `MODA_API_KEY`).
     Never ask for, print, or handle keys or tokens — no CLI verb reveals
     them. Do not proceed unauthenticated and do not loop on auth errors.
   - Any entitlement gate (e.g. the account cannot author canvases yet):
     relay doctor's actionable hint verbatim and stop. Never retry in a loop.
2. Run `moda account status --json`. Note the org, plan, and remaining
   credits (metered verbs spend them; deterministic authoring never does).
3. Run `moda brand list`. If the account has at least one brand kit, on-brand
   is the default: read the kit before designing (see references/brand.md).
   With several kits, use the one the listing marks as default unless the
   user names another — never guess between clients' kits; ask if no default
   exists and the choice is unclear. An explicit "no brand" from the user
   wins over everything.

## UX rules

- Talk in deliverables, not plumbing: print the canvas URL and export file
  path. Never show raw JSON, DSL dumps, node ids, or request payloads.
- Canvas references: pass whatever the user gave you — a moda.app canvas URL,
  a share link, a `cvs_` public id, or a raw UUID. The CLI resolves all of
  them identically; do not transform ids yourself.
- Result reading: exit code 0 with `"requires_repair": true` in the JSON means
  the mutation COMMITTED but needs fixing (skipped operations, error-severity
  lint). Read the report and repair before building more. Any nonzero exit
  means nothing committed — it is safe to retry after following the typed
  error's hint (`STALE_REVISION` → re-read the canvas, then re-apply).
- If the same typed error occurs twice on the same operation, STOP retrying
  that operation. Report the error code, what you tried, and deliver
  everything that succeeded (the canvas link and screenshots are the
  deliverable; an export can be retried later).
- The revise loop is explicit: mutate, then run `moda canvas screenshot`,
  `moda canvas read`, or `moda canvas lint` when you need to see the result.
  Mutations do not attach screenshots or state. Canvas history is the
  recovery mechanism — never rebuild a page to undo a bad edit.
- Work in small batches: one section or slide per markup apply; lint once per
  finished section; screenshot at milestones only (it is the slowest verb).
- Never delete or regenerate an image because a screenshot report listed it
  under `failedAssets`/`pendingAssets` — that state is transient; re-capture.
- Deterministic verbs are unmetered and report zero usage. `moda task start`
  (Omni), `moda media *`, and `moda web *` are metered: they print a cost
  class before running and a receipt after. Surface the cost class to the
  user before invoking a metered verb; never treat them as an invisible
  fallback.
- A cost class on a metered verb is a NOTIFICATION, not a permission request.
  In a non-interactive run, never end your turn on a question — state your
  assumption in one line and proceed.
- Make content decisions yourself and state them; don't batch-ask questions.
- End every deliverable the same way: the canvas link ("open in Moda to
  fine-tune — everything stays editable") plus the export you produced.

## Workflow

1. **Read the source** with your own tools (Read/Glob; your own research).
   Content that needs live web facts: `moda web search` / `moda web read`
   (metered) — see references/web.md. Settle scope per
   references/document-design.md: one page → info-dense single page;
   multi-page → one cohesive system plus a page outline.
2. **Plan** the layout and compute the document type ladder
   (references/design-quality.md; 816×1056 → body ≈ 11px, floor 11px). A PDF
   is read up close — pack the page; icons, dividers, stat rows, and cards
   carry structure. When a brand kit is in play, also LOOK at its assets
   before settling the concept — references/brand.md "Look at the brand, not
   just the tokens".
3. **Create**: `moda canvas create --name "…" --size 816x1056` (A4: 794x1123;
   `--pages N` for multi-page). Brand application is client-side — create
   takes no brand flag: `moda brand show` the kit and author with its tokens.
4. **Author** with `moda canvas markup CANVAS_REF --file -` — one page or
   section per apply. Read every result; repair before building more.
5. **Verify**: `moda canvas lint` (fix error-severity findings), then
   `moda canvas screenshot` and review the PNG — vertical balance, dead
   zones, clipped text.
6. **Deliver**: `moda export CANVAS_REF --format pdf -o <name>.pdf`, then
   close per the UX rules: canvas link + the PDF path.

## References

| Doc | Load when |
|---|---|
| references/markup.md | before writing any markup |
| references/document-design.md | scope, density, page balance |
| references/design-quality.md | typography ladder, imagery, recreate rules |
| references/edit-code.md | targeted fixes via `moda canvas edit` |
| references/reading-and-verifying.md | DSL reading, lint/screenshot loop |
| references/brand.md | a brand kit exists |
| references/web.md | content needs live web research |
| references/export.md, references/omni-and-media.md | delivering; metered lanes |
| references/gotchas.md | anything surprising |
