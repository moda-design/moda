---
name: moda-brand
description: Fetch, create, and apply Moda brand kits so every design is
  on-brand. Use when the user says on-brand, brand kit, brand colors/fonts/logo,
  "use our brand", "match our site", rebrand, or wants a brand kit created from
  a website URL, or wants an existing canvas audited against the brand. Reads
  kit palette/fonts/logos deterministically and hands them to the other moda
  skills. Requires the moda CLI and a Moda account (Step 0 checks both; it
  never installs anything itself).
argument-hint: "[list|show <kit>|create --url <site>|apply <canvas> <kit>|check <canvas>]"
allowed-tools: Bash(moda:*), Read
---

# moda-brand

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

- **List / read**: `moda brand list`, then `moda brand show BRAND_REF --json`
  — a model-safe summary: palette, font references, logo file references,
  never signed URLs. `moda brand pull BRAND_REF --output brand.json` for the
  full document; `moda brand use BRAND_REF` to persist a default.
- **Apply** = author with kit tokens: markup `$variables` and kit palette
  values, kit font families, logos by file reference — never re-typed hex
  codes from memory; the kit owns colors. Full rules: references/brand.md.
- **Check** (audit a canvas against the kit): `moda canvas read CANVAS_REF` +
  `moda canvas lint` + token comparison against `moda brand show --json`,
  reporting pass/fail per element — off-kit colors (with node ids and nearest
  kit color), non-kit fonts, logo size/variant/contrast. Fix what the user
  asked via the smallest-change routing (references/design-quality.md).
- **Create**: `moda brand create --url https://…` — server-side extraction, a
  METERED operation: state the cost class before running, surface the receipt
  after.
- **Escalate**: full brand-guide generation (a new identity, multiple
  concepts) is creative work for the metered Omni lane — `moda task start`
  (references/brand.md and the metered-lane rules in the UX block).

## References

| Doc | Load when |
|---|---|
| references/brand.md | always — the apply/check/create contract |
| references/markup.md | authoring with `$var` tokens and fills |
| references/design-quality.md | imagery routing, typography, edit-vs-markup |
| references/gotchas.md | anything surprising |
