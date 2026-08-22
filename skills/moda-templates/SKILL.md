---
name: moda-templates
description: >-
  Start from a team template: list templates, look at them, then
  instantiate. Use for: "start from our QBR template", "use our usual
  layout", flagging a canvas as a team template.
argument-hint: "[what to build from a template, or the canvas to flag]"
allowed-tools: Bash(moda:*), Read
---

# moda-templates

<!-- moda:banner -->
**PREREQUISITE — load `moda-core` once per session** (step-0, write contract,
free/metered map). Already loaded? Skip ahead. If you cannot load it, the
non-negotiables: run `moda doctor --json` before anything; `moda brand list`
before creating; every write carries the latest revision — on
`stale_revision`, re-read and retry once (it heals); send the canvas link the
moment it exists; stuck or failed? `moda ask "<question>"` — free and fast,
never guess.
<!-- /moda:banner -->

A team template is the canvas someone approved as the starting point for
recurring work — the QBR deck, the launch post, the customer one-pager. It
carries layout and structure, one level up from what a brand kit carries.

## Check before designing (one cheap read)

The ask names a recurring artifact type (QBR or board deck, launch post,
customer one-pager) or the user says "our template", "our usual format", "what
do we have" → check first. Skip it for genuine one-offs.

## Instantiate

1. `moda template list` — id, name, category, page count. An empty list is a
   normal answer: say it in one line and design fresh.
2. **LOOK before choosing.** Names do not tell you what a template looks like,
   and a template IS a canvas: `moda canvas screenshot [cvs_…]` renders it
   inline (≤3 pages per call). Judge 2–4 plausible candidates with your own
   vision; category and page count do the cheap narrowing first.
3. Comparing many at once? `moda template pull --output /tmp/templates.json`
   is the one read whose `thumbnail_url` values are fetchable (`moda template
   list` scrubs them by design) — download those with your harness's own fetch.
   They expire: never place one in markup, never persist one, never hand one to
   the user. A null thumbnail means nothing is rendered yet.
4. `moda canvas create --name "[Q3 QBR — Acme]" --template [cvs_…]` — a full
   server-side copy that keeps the source's brand kit. The template defines
   size, pages, and category, so `--size`, `--pages`, `--category`,
   `--intent`, `--folder`, `--visibility` and `--brand` are REJECTED alongside
   it; place the copy afterwards with `moda drive move`, and rebind its kit
   with `moda canvas brand [cvs_…] [bk_…]` when the user's kit differs.
5. The copy is an ordinary canvas — read it, then edit it the normal way
   (moda-edit). Send the link, and name which template you started from: that
   is a decision the user may want to correct.
6. None fit? One line ("no team template matched, so I designed this fresh")
   and build from scratch. Never force a bad-fit template.

Want a copy of an ordinary canvas instead of a template? `moda canvas
duplicate [CANVAS_REF] --name "…"` is the as-is copy of anything you can read.

## Flag a canvas as the team's template

```
moda canvas template [cvs_…]                 # publishes it to the whole team
moda canvas template [cvs_…] --clear         # un-flag
```

- Team-visible curation, not a local preference. Offer it when the user calls
  something reusable ("we do this every quarter"); never flag a one-off, never
  flag unasked, and tell them once you have.
- Original should stay an ordinary canvas? `moda canvas duplicate` first, then
  flag the copy. Flag in place when the canvas was BUILT to be the template.
- `moda template list` hides canvases the viewer cannot see, so flagging a
  private canvas yields a template only you can find:
  `moda drive visibility [cvs_…] team` shares it — or say plainly you could not.

## `theme` is a different thing — don't reach for it

`moda canvas template [cvs_…] theme` is a slides-only layout source applied
through a brand kit, and it deliberately does NOT appear in `moda template
list`. Moving a canvas OFF `theme` — to `template` or with `--clear`, both
count — clears every deck's link to it and every kit that auto-applied it, and
re-flagging restores none of them. On a canvas you did not flag yourself, read
`moda canvas show [cvs_…]` (`template_type`) BEFORE writing.

## Examples

- "start from our QBR template" → list, screenshot the QBR candidates, create
  with `--template`, then author into the copy.
- "use our usual layout for this one-pager" → same flow, filtered to 1–2 page
  document templates.
- "make this our standard deck" → flag it (after checking `template_type`).
- "do we have anything for launches?" → list + screenshots, answer honestly if
  the answer is no.

## Errors

Any typed error → load moda-core and read its recovery reference. A 404 here
means the surface is not enabled on this account: treat it exactly like "no
templates" — do not retry it, and do not mention it. A 403 means template
management is admin-only: say an admin has to flag this one, in one line.

## Make it recurring

Every instantiation is a return visit — that is the point. Pair it with
moda-automate when the cadence is fixed (a monthly menu, a weekly post set).

See also: moda-core — the contract, recovery, everything Moda can do.
