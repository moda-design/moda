# moda — design skills for your agent (private dogfood)

Skills that let any coding agent (Claude Code, Codex, Cursor, anything that
reads SKILL.md and has a shell) design on [Moda](https://moda.app) through the
`moda` CLI: real editable decks, one-page PDFs with selectable text, brand-true
designs, and precise edits to existing canvases — all on a live, collaborative
canvas the user can open and polish.

**Status: private dogfood.** Nothing here is published; installs ride team
GitHub auth. See [INSTALL.md](INSTALL.md) (humans) and
[INSTALL_FOR_AGENTS.md](INSTALL_FOR_AGENTS.md) (paste into an agent).

## The skills

| Skill | What it makes |
|---|---|
| `moda-deck` | Slide decks from a brief/doc/repo → native, editable PPTX |
| `moda-one-pager` | One-pagers and PDF documents → text-layer PDF |
| `moda-brand` | Brand-kit reads, creation, and canvas-vs-kit audits |
| `moda-edit` | Precise edits to an existing canvas from its URL |

Plus `/moda` (Claude Code) as a router. Every skill starts with the same
Step-0 doctor bootstrap (checks the CLI, auth, entitlements; never installs
anything itself) and the same UX rules (deliverables over plumbing, explicit
verify loop, metered verbs labeled with cost class and receipt).

## Repo layout

- `skills/` — the four skills, each self-contained with its `references/`.
- `shared/` — the canonical authored copy of the shared blocks and
  references; `scripts/fanout.sh` fans them into the skills.
- `scripts/validate.py` — frontmatter lint, shared-block/fan-out integrity,
  banned-name greps, verb parity, markup element completeness, size budgets.
- `docs/cold-test.md` — the acceptance protocol; the cold run IS the test.
- Manifests: `.claude-plugin/` (marketplace + plugin), `.codex-plugin/`,
  `.cursor-plugin/`, `compatibility.json`.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Edit `shared/`, run
`./scripts/fanout.sh`, run `python3 scripts/validate.py`, commit both.
