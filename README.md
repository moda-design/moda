# moda — design skills + CLI for your agent (private dogfood)

## Set up Moda in your agent

Paste this to your agent (Claude Code, Codex, or any shell-capable agent) —
the agent runs everything:

```
Set up Moda for me so I can create designs, decks, and documents from here.

1. Install the CLI (os: darwin | linux, arch: arm64 | x64; on macOS verify
   with `shasum -a 256 -c` instead of `sha256sum -c`):
   gh release download --repo moda-design/moda -p moda-<os>-<arch> -p SHA256SUMS
   grep moda-<os>-<arch> SHA256SUMS | sha256sum -c -
   install -m 755 moda-<os>-<arch> ~/.local/bin/moda && rm moda-<os>-<arch> SHA256SUMS
2. Authenticate: run `moda auth login` and complete the sign-in in the
   browser it opens.
3. Install the companion skills: run `npx skills add moda-design/moda`.
4. Verify: run `moda doctor` and tell me when everything is ready.
```

Per surface:

- **Claude Code** — the paste block works as-is. Alternative:
  `/plugin marketplace add moda-design/moda` then `/plugin install moda@moda`
  gives plugin-managed skills that update through the marketplace, where
  `npx skills add` pins a local copy (steps 1–2 still apply for the CLI).
- **Codex** — the paste block as-is; this is the proven lane.
- **claude.ai** — coming with the MCP connector: one copy-paste URL (see the
  roadmap).

Private-dogfood caveat: until publish, steps 1 and 3 pull from this private
repo, so the machine needs `gh` authenticated (`gh auth login`) with repo
access — git uses those credentials for `npx skills add` too; at publish,
step 1 becomes the npm one-liner.

Skills that let any coding agent (Claude Code, Codex, Cursor, anything that
reads SKILL.md and has a shell) design on [Moda](https://moda.app) through the
`moda` CLI: real editable decks, one-page and multi-page PDFs with selectable
text, social posts and static ads, diagrams and UI mockups, live websites
hosted on `*.moda.page`, brand-true designs, and precise edits to existing
canvases — all deliverables the user can open and polish.

**Status: private dogfood.** Nothing here is published; installs ride team
GitHub auth. See [INSTALL.md](INSTALL.md) (humans) and
[INSTALL_FOR_AGENTS.md](INSTALL_FOR_AGENTS.md) (paste into an agent).

## The skills

| Skill | What it makes |
|---|---|
| `moda-deck` | Slide decks from a brief/doc/repo → native, editable PPTX |
| `moda-one-pager` | One-pagers, multi-page reports, and print pieces → text-layer PDF |
| `moda-social` | Social posts, carousels, static ads, banners → png/jpeg (carousel = zip) |
| `moda-diagram` | Flowcharts, 2×2 matrices, UI wireframes/mockups → png/pdf |
| `moda-website` | Live websites → published to a public `*.moda.page` URL |
| `moda-brand` | Brand-kit reads, creation, and canvas-vs-kit audits |
| `moda-edit` | Precise edits to an existing canvas from its URL |

Plus `/moda` (Claude Code) as a router. Every skill starts with the same
Step-0 doctor bootstrap (checks the CLI, auth, entitlements; never installs
anything itself) and the same UX rules (deliverables over plumbing, explicit
verify loop, metered verbs labeled with cost class and receipt).

## Repo layout

- `cli/` — TypeScript source of the `moda` CLI, compiled with Bun into
  per-platform standalone binaries (`bun scripts/build.ts`).
- `skills/` — the seven skills, each self-contained with its `references/`.
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
