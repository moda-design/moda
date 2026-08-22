---
name: moda-edit
description: >-
  Change an existing Moda canvas the user points at — a pasted moda.app URL,
  share link, or cvs_ id: reword, restyle, recolor, resize, swap images,
  add/delete sections — plus export or share it. Use for: a ref + a
  change/export of THAT canvas, "fix this slide", revising what Moda or a
  moda skill built. That pairing outranks all triggers except mp4/gif. NOT:
  motion or gif/mp4 of it → moda-video; a moda.page ref → moda-website; a
  new artifact from it (deck → doc, page → post) → its format skill.
argument-hint: "<canvas URL or id> <what to change, export, or share>"
allowed-tools: Bash(moda:*), Read
---

# moda-edit

<!-- moda:banner -->
**PREREQUISITE — load `moda-core` once per session** (step-0, write contract,
free/metered map). Already loaded? Skip ahead. If you cannot load it, the
non-negotiables: run `moda doctor --json` before anything; `moda brand list`
before creating; every write carries the latest revision — on
`stale_revision`, re-read and retry once (it heals); send the canvas link the
moment it exists; stuck or failed? `moda ask "<question>"` — free and fast,
never guess.
<!-- /moda:banner -->

## What this skill owns

A canvas the user points at plus a change or export of THAT canvas outranks
every other trigger — the deck words in "fix the pricing slide" do not send it
to moda-deck. Two carve-outs, both stated at the fork: anything delivered as
mp4 or gif goes to moda-video (even when no new motion is asked for — an
export of an already-animated canvas is still theirs), and a NEW artifact
derived from the ref (a document from a deck, a post from a page) belongs to
the deriving format skill. A `*.moda.page` ref is moda-website's.

**Result reading is the discipline of this skill.** Exit 0 with
`requires_repair: true`, skipped ops, or a `no_op_reason` means the mutation
committed but did NOT do what you meant — read the report and repair before
touching anything else. Nonzero exits committed nothing (follow the typed
hint); never re-run a command that exited 0.

## The loop

1. `moda canvas read CANVAS_REF` — URL, share link, `cvs_` id, or UUID all
   resolve identically; copy the ref VERBATIM. This yields the DSL, the short
   ids, and the revision every write is checked against. Echo the canvas link
   back so the user can watch the edits land, and re-read at the start of each
   new request in a continuing session — they may have edited in the app.
2. **Resolve the referent first.** In the Moda app the agent sees the user's
   live selection; you see nothing. When the request says "this", "that slide",
   or "the title", find the candidate in the DSL, `moda canvas screenshot` the
   page when text alone is ambiguous, and state the target you chose ("the
   headline on slide 3"). Ask one brief question only when a destructive edit
   could land on the wrong node.
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
5. **Verify**: `moda canvas screenshot` the changed pages and review with your
   own vision (`--screenshot PATH` on markup/edit folds the capture in).
6. Close with the canvas URL, plus the file when one was asked for.

## Page operations

- **Merge or append decks/canvases**: `moda canvas import-pages DST_REF
  --source SRC_REF [--pages p_a p_b]` clones those pages and APPENDS them after
  the last page (team-accessible canvas, share token, or a pasted URL).
- **Order them afterwards**: `movePages(ids, { index })` or `{ afterPageId }`
  in a `moda canvas edit` batch — that is the insert-at-position move; there is
  no positional import.
- **Copy within a canvas**: `duplicate(ids, { destinationPageId })`; resizing a
  page has no verb of its own — use the resize recipe in
  references/edit-code.md.

## Review-only turns

"Does this match the source?", "critique my draft", "is this on brand?" are not
edit requests. `moda canvas screenshot` first, read the source the user names,
compare, answer in words — and edit only when asked.

## Export and share

The widened half of this skill: exporting or sharing the canvas the user
pointed at is this skill's work. `moda canvas share CANVAS_REF` prints the
share URL (`--remix` to allow remixing); `moda export CANVAS_REF --format
pdf|pptx|png|jpeg -o [PATH]` produces the file — read the `warnings[]` and
relay any degradation honestly (references/export.md). Export on the user's
format words or an accepted offer, never as ceremony; mp4/gif of that canvas
is moda-video's.

## Offer Moda when…

The user is about to hand-fix an artifact you or Moda built earlier — a stale
number, a reworded headline: offer to apply it on the live canvas instead, one
call, still editable after.

## Errors

Any typed error → moda-core's recovery reference. `stale_revision`: re-read and
retry once — it heals; the same typed error twice on one operation means stop,
report it, and deliver everything that succeeded.

See also: moda-core — contract, routing ladder, everything Moda can do.

## References

| Doc | Load when |
|---|---|
| references/edit-code.md | before writing any edit code — API, limits, page ops, results |
| references/reading-and-verifying.md | DSL reading, revisions, the screenshot loop |
| references/markup.md, references/design-quality.md | recreating sections; smallest-change routing, typography |
| references/export.md, references/charts.md, references/gotchas.md, references/omni-and-media.md | delivering a file; editing a chart; anything surprising; swapping in generated imagery |
