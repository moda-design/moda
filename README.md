# moda — design skills + CLI for your agent (private dogfood)

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

- `cli/` — TypeScript source of the `moda` CLI, compiled with Bun into
  per-platform standalone binaries (`bun scripts/build.ts`).
- `skills/` — the four skills, each self-contained with its `references/`.
- `shared/` — the canonical authored copy of the shared blocks and
  references; `scripts/fanout.sh` fans them into the skills.
- `commands/` — the `/moda` router command (Claude Code).
- `packages/` — npm distribution: `moda` wrapper + per-platform
  `optionalDependencies` packages (esbuild/biome pattern; nothing published
  during dogfood).
- `scripts/` — build matrix (`build.ts`), npm stamping, release/checksums
  (`release.ts`), inventory parity, and `validate.py` (frontmatter lint,
  shared-block/fan-out integrity, banned-name greps, verb parity, markup
  element completeness, size budgets).
- `docs/cold-test.md` — the acceptance protocol; the cold run IS the test.
- Manifests: `.claude-plugin/` (marketplace + plugin — the repo IS a Claude
  Code marketplace: `/plugin marketplace add moda-design/moda`),
  `.codex-plugin/`, `.cursor-plugin/`, `compatibility.json`.
- `setup` — POSIX skills drop for file-based harnesses; prints the pinned CLI
  install command, never runs it.

## Develop (CLI)

```sh
cd cli
bun install
bun test            # unit suite
bun run typecheck
bun src/main.ts …   # run from source
bun ../scripts/build.ts --host   # compile dist/moda-host
```

Integration tests (against a local studio stack): set `MODA_API_BASE` +
`MODA_API_KEY` and run `bun test cli/test/integration/` — see
`cli/test/integration/integration.test.ts`.

Contract: `docs/roadmap/moda-for-agents/cli.md` in the studio repo (verb tree,
`--json` output shape, exit codes) with the orchestrator rulings applied
(endpoints under `/v1`; browser key-mint auth; dogfood update channel prints
`gh release download`).

## Contributing (skills)

See [CONTRIBUTING.md](CONTRIBUTING.md). Edit `shared/`, run
`./scripts/fanout.sh`, run `python3 scripts/validate.py`, commit both.
