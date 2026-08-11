---
name: moda-deck
description:
  Create a real, editable slide deck on Moda from a brief, a document,
  or the current repo. Use when the user asks for a deck, slides, a presentation,
  pitch deck, keynote, QBR, board update, sales/client deck, launch deck, or
  "turn this doc/repo/notes into slides". Produces designed pages on a Moda
  canvas (live URL, stays editable) and exports native PPTX with real shapes and
  text layers, or a text-layer PDF — not screenshots pasted into python-pptx.
  Requires the moda CLI and a Moda account (Step 0 checks both; it never
  installs anything itself).
argument-hint: "[topic or source file/dir] [--slides N] [--brand <kit>] [--export pptx|pdf]"
allowed-tools: Bash(moda:*), Read, Glob, Grep
---

# moda-deck

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
- Make content decisions yourself and state them; don't batch-ask questions.
- End every deliverable the same way: the canvas link ("open in Moda to
  fine-tune — everything stays editable") plus the export you produced.

## Workflow

1. **Gather** with your own tools (Read/Glob/Grep over the named source; your
   own research). Distill to a slide list first: title, agenda, one idea per
   slide, 6–12 slides unless the user named a count. Data preservation rules
   apply from here on (references/design-quality.md).
2. **Read the design references before authoring**: references/deck-design.md
   (concept-first cover, layout bar), references/deck-playbooks.md when the
   deck matches a known type, references/markup.md before any markup, and
   compute the type ladder for your canvas size per
   references/design-quality.md (1920×1080 → body ≈ 40px, floor 18px).
3. **Create**: `moda canvas create --name "…" --size 1920x1080 --pages 1
   --category slides` (brand application is client-side: `moda brand show`
   the kit and author with its tokens — create takes no brand flag), then
   `moda canvas add-pages CANVAS_REF --count N` for the remaining slides.
4. **Author per slide** with `moda canvas markup CANVAS_REF --file - --page P`
   in small batches — one slide per apply. Read every result: `requires_repair`
   or `operation_counts.skipped > 0` means fix before the next slide.
5. **Verify**: `moda canvas lint` once per finished section (fix every
   error-severity finding); `moda canvas screenshot` at milestones and review
   the PNGs with your own vision — layout balance, dead zones, clipped text.
6. **Deliver**: `moda export CANVAS_REF --format pptx -o <name>.pptx` (or pdf),
   `moda canvas share CANVAS_REF` for the link, then close per the UX rules.

## References

| Doc | Load when |
|---|---|
| references/markup.md | before writing any markup |
| references/deck-design.md, references/deck-playbooks.md | planning slides |
| references/design-quality.md | typography ladder, imagery, recreate rules |
| references/charts.md | any data slide |
| references/edit-code.md | targeted fixes via `moda canvas edit` |
| references/reading-and-verifying.md | DSL reading, lint/screenshot loop |
| references/brand.md | a brand kit exists |
| references/export.md, references/omni-and-media.md | delivering; metered lanes |
| references/gotchas.md | anything surprising |
