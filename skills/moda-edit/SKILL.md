---
name: moda-edit
description: Make precise edits to an existing Moda canvas from its URL or share
  link — reword or restyle text, recolor, realign, resize, swap an image, add or
  delete a section, fix a slide someone touched in the editor. Use when the user
  pastes a moda.app canvas or share URL (or a cvs_ id) and asks for changes, or
  to revise a design a previous moda skill or Moda's AI built. Deterministic:
  reads canvas state, applies targeted markup/code edits, verifies with lint and
  screenshots. Requires the moda CLI and a Moda account (Step 0 checks both; it
  never installs anything itself).
argument-hint: "<canvas URL or id> <what to change>"
allowed-tools: Bash(moda:*), Read
---

# moda-edit

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

**Result reading is the discipline of this skill.** Exit 0 with
`requires_repair: true`, `operation_counts.skipped > 0`, or a `no_op_reason`
means the mutation committed but did NOT do what you meant — read the report
and repair before touching anything else. Any nonzero exit committed nothing;
follow the typed hint. Never re-run a command that exited 0.

1. `moda canvas read CANVAS_REF` (URL, share link, `cvs_` id, or UUID — all
   resolve identically; re-run it at the start of each new request in a
   continuing session — the user may have edited in the app since your last
   read). This yields the DSL, the short ids, and the revision token every
   write is checked against.
2. **Resolve the referent first.** In the Moda app the agent sees the user's
   live selection; you see nothing. When the request says "this", "that
   slide", or "the title", resolve it yourself: find the candidate in the DSL
   from step 1, `moda canvas screenshot` the page when text alone is
   ambiguous, and state the target you chose in your reply ("the headline on
   slide 3"). Ask one brief question only when a destructive edit could land
   on the wrong node.
3. **Smallest-change routing** (full rules: references/design-quality.md):
   restyle / move / retext → `moda canvas edit` with a small code batch; new
   content → `moda canvas markup`; removal → `moda canvas delete-items`;
   full-page redo → `moda canvas markup --mode replace` (atomic). Preserve
   every source value verbatim — data preservation is non-negotiable.
4. **Re-read after structural changes** before referencing new ids — created
   nodes get fresh short refs. A write against a stale revision exits 5 with
   `STALE_REVISION` and commits nothing: re-read, then re-apply. A busy canvas
   (running task) also exits 5 after built-in retries: back off or
   `moda task cancel`.
5. **Verify**: `moda canvas lint` once when the edits are done (fix every
   error-severity finding, one confirm re-lint max), `moda canvas screenshot`
   the changed pages and review with your own vision.
6. Close with the canvas URL; export only if the user asked for a file.

## References

| Doc | Load when |
|---|---|
| references/edit-code.md | before writing any edit code — API, limits, results |
| references/reading-and-verifying.md | DSL reading, revision, lint/screenshot |
| references/markup.md | recreating sections; markup grammar |
| references/design-quality.md | routing, data preservation, typography |
| references/gotchas.md | anything surprising |
