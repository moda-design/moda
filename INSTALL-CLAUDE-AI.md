# Installing the Moda skills on claude.ai (Agent Skills)

Repo-internal doc — private repo, not published anywhere. The distributable
artifacts are the `moda-*.skill.zip` files attached to each GitHub release.

## What these are

The nine Moda skills, projected from the CLI-flavored sources in `skills/`
into an MCP-flavored form that speaks the **Moda connector's tools**
(`canvas_create`, `canvas_apply_markup`, `media_generate_image`, …) instead of
CLI verbs, with filesystem steps replaced by link handoffs. Same workflows,
same design doctrine, same metering ceremony — different transport.

- Generated output lives in `dist/mcp-skills/<skill>/` (committed; CI fails on
  drift). Never hand-edit it — change `skills/`, `shared/`, `mcp/`, or
  `scripts/mcp_projection_rules.py` and run `python3 scripts/project-mcp.py
  build`.
- The skills assume the **Moda connector is enabled** in the conversation —
  they teach tool calls; they do not carry the connector itself.

## Prerequisites (once)

1. A claude.ai account — Agent Skills are available on **all plans, including
   Free** (per the claude.ai help center; the platform-docs "Pro and above"
   page is stale).
2. Settings → **Capabilities** → enable **"Code execution and file
   creation"** (Skills ride that capability).
3. The Moda connector connected (Settings → Connectors) and enabled in the
   chat's tools menu.

## Install a skill (2 steps per skill)

1. Download `moda-<skill>.skill.zip` from the GitHub release
   (`gh release download --pattern '*.skill.zip'`).
2. claude.ai → Settings → **Capabilities → Skills** (also reachable at
   `claude.ai/customize/skills`) → **"+" → Upload skill** → pick the ZIP.

Repeat per skill. The upload format requires the ZIP root to be **one** skill
folder containing `SKILL.md`, so there is no combined nine-in-one ZIP — nine
skills means nine uploads. Skills auto-invoke by description matching after
upload and idle at roughly ~100 tokens each.

**No deeplink exists today.** There is no documented install URL /
`?install=` pattern for skills, so "one-click install" is not currently
possible — the closest is handing someone a ZIP plus the
`claude.ai/customize/skills` link.

## Org provisioning (Team / Enterprise admins)

One admin action covers the whole org, zero end-user friction:

Organization settings → **Skills** → **"+ Add"** → upload the same ZIPs.
Uploaded skills are immediately provisioned to all users and enabled by
default (help-center article 13119606).

## Updating

Skills are static uploads — a new release means re-uploading the new ZIPs
(and, for orgs, one admin re-upload). Keep the release's `SHA256SUMS` handy to
verify downloads.

## Maintainer notes

- `python3 scripts/project-mcp.py check` — CI gate: regenerates the projection
  in memory, fails on drift, dead rules, unmapped CLI verbs, or CLI-surface
  leaks in the output.
- `python3 scripts/project-mcp.py table` — the CLI-verb → connector-tool
  mapping table.
- `python3 scripts/project-mcp.py audit-server --studio-root <path>` — strict
  reconciliation of `mcp/connector-tools.json` (including the
  `pending_server` best-guess names for the connector surface-parity wave)
  against the studio repo's connector manifest. Run it when that wave lands;
  a name that landed differently fails loudly and gets renamed in the roster,
  the rules, and the projection in one commit.
- `dist/mcp-skills/index.json` is the machine-readable manifest for the
  studio-side `load_skill` connector lane — path-stable, deterministic, no
  timestamps.
