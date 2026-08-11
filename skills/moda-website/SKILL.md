---
name: moda-website
description: >-
  Build and publish a live website hosted on Moda. Use when the user
  asks for a website, site, web page, landing page, marketing site, portfolio
  site, homepage, coming-soon page, "put this on the web", or wants an existing
  moda.page site updated or re-published. Produces a real hosted site at a
  public *.moda.page URL that stays editable and re-publishable. For a
  printable/PDF one-pager use moda-one-pager; for slides use moda-deck.
  Requires the moda CLI and a Moda account (Step 0 checks both; it never
  installs anything itself).
argument-hint: "[what the site is for, or an existing site to change] [--brand <kit>]"
allowed-tools: Bash(moda:*), Read, Glob, Grep
---

# moda-website

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
  (Omni) and `moda media *` are metered: they print a cost class before
  running and a receipt after. Surface the cost class to the user before
  invoking a metered verb; never treat them as an invisible fallback.
- A cost class on a metered verb is a NOTIFICATION, not a permission request.
  In a non-interactive run, never end your turn on a question — state your
  assumption in one line and proceed.
- Make content decisions yourself and state them; don't batch-ask questions.
- End every deliverable the same way: the canvas link ("open in Moda to
  fine-tune — everything stays editable") plus the export you produced.

## Workflow

A site is one self-contained HTML page (v1 is static single-page) published
to `https://<slug>.moda.page`. The site verbs are deterministic and free;
only `moda web *` research and `moda media *` imagery are metered.

1. **Gather** content with your own tools (Read/Glob/Grep; your own
   research). Live web facts: `moda web search` / `moda web read` (metered)
   — references/web.md. For an existing site, `moda site list` +
   `moda site show` first.
2. **Read references/website.md before authoring** — structure, styling,
   typography, and the library/embed allowlists (violations silently break
   or fail the publish gate). When a brand kit is in play, `moda brand show`
   it and LOOK at its assets before settling the direction
   (references/brand.md); imagery must be Moda-hosted, never hotlinked.
3. **Author the page locally**: write one complete, self-contained HTML
   document (inline styles, mobile-first) to a file, reviewing it against
   references/website.md as you go.
4. **Create**: `moda site create --file page.html --title "…"` — note the
   site id from the result. Nothing is public yet.
5. **Publish**: `moda site publish SITE_ID [--slug hint]` — print the live
   URL. If `review_status` is `pending_review`, tell the user the site is
   published but held for review and goes live once approved — never present
   it as already browsable.
6. **Revise**: edit the local file, `moda site set-content SITE_ID --file
   page.html`, then `moda site publish SITE_ID` again — saved content does
   NOT go live until republished (`has_unpublished_changes` flags this).
7. **Deliver**: end with the live *.moda.page URL ("stays editable —
   re-publish after changes"). `moda site unpublish` takes it down if asked.

## References

| Doc | Load when |
|---|---|
| references/website.md | before authoring any page (always) |
| references/brand.md | a brand kit exists |
| references/web.md | content needs live web research |
