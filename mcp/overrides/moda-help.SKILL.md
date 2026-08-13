---
name: moda-help
description: >-
  Moda meta and routing help — NOT a design tool. Use for meta asks only:
  connecting Moda to Claude, account/team/workspace questions, "what can Moda
  do?", "which Moda skill or tool should handle X?", troubleshooting failed
  Moda tool calls (typed errors), automation and integration asks ("set up
  Moda to auto-post/sync/schedule X", connect Moda to another tool, recurring
  jobs — the automation part only: any artifact to author still routes to its
  format skill) — or when a Moda request doesn't CLEARLY fit any other moda
  skill (a matching format skill always wins; this is the none-fit catcher,
  never a shortcut). Creating or editing designs, decks, documents, sites,
  graphics, videos, or diagrams is NEVER this skill — load the format skill
  (moda-deck, moda-one-pager, moda-social, moda-diagram, moda-website,
  moda-video, moda-brand, moda-edit). Requires the Moda connector (Step 0
  checks it).
---

# moda-help
<!--MCP:STEP0-->

<!--MCP:UX-RULES-->

## Lifecycle
- **Setup**: the Moda tools ride the Moda connector — claude.ai → Settings →
  Connectors → Moda, sign in with the Moda account (accounts at moda.app),
  then enable it in the chat's tools menu. A succeeding `moda_bootstrap` IS
  the health check.
- **Teams** (ONLY when asked; team = workspace + billing): Step-0's team
  rule above.
- **Troubleshooting**: every failure is a typed error on the tool result —
  read its code and hint. Never re-run a failed write just to see its error
  again, and never retry the same typed error twice on one operation.

## Which skill handles X (mirrors the repo routing table — update both)
| Ask | Skill |
|---|---|
| deck, slides, presentation, pitch | moda-deck |
| one-pager, report (any page count), infographic, print piece | moda-one-pager |
| social post, carousel, static ad, banner, quote card, one-off graphic | moda-social |
| flowchart, architecture, 2x2, standalone data chart, UI mockup | moda-diagram |
| live hosted site / landing page on *.moda.page | moda-website |
| video, GIF, animated ad/post, motion graphic, animate a logo/design | moda-video |
| brand kits and brand guides | moda-brand |
| change THIS canvas (URL/id given) | moda-edit |

Boundaries: print → one-pager; a mockup is a picture (diagram), a landing
page is live (website); decorative shapes → social; mp4/gif output → video.

## Tool conventions
- Each tool's own description is its ground truth — what it takes, and
  whether it mutates, meters, or only reads.
- Big canvases: `canvas_read(summary=true)` first, then page-scoped reads.
  A list result is a PAGE (`total`/`has_more`; follow the cursor or offset
  the result names). Copy ids/URLs verbatim.

## When nothing fits
Consult the table above; a format skill that fits after all wins — load it,
don't narrate the detour. Outside Moda's powers? Say so honestly, offer the
nearest thing Moda CAN do, and ask exactly ONE question, only when the fork
is real — never enumerate the catalog.

## Tools at a glance (load the format skill for the work)
Decks/documents/social/diagrams author via `canvas_apply_markup`/`canvas_edit`
and deliver files via `export`; kits read via `brand_list`/`brand_show`
(created and edited in the Moda app); `task_start` delegates whole jobs to
Moda's own designer; `media_generate_image`/`media_generate_video`/
`media_upscale` generate imagery and video (metered). Hosted websites are
built in the Moda app — moda-website routes the user there.
