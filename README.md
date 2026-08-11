# moda

Moda for Agents — the `moda` CLI, agent skills, and install manifests. Prototype; private
until publish.

- `cli/` — TypeScript source, compiled with Bun into per-platform standalone binaries
  (`bun scripts/build.ts`).
- `skills/` — agent skills (lands with the skills slice; authored for dogfood, regenerated
  from studio at ship time).
- `packages/` — npm distribution: `moda` wrapper + per-platform `optionalDependencies`
  packages (esbuild/biome pattern; nothing published during dogfood).
- `scripts/` — build matrix, npm stamping, release/checksums, inventory parity.
- `.claude-plugin/` / `.codex-plugin/` / `.cursor-plugin/` — harness manifests; the repo IS a
  Claude Code marketplace (`/plugin marketplace add moda-design/moda`).
- `setup` — POSIX skills drop for file-based harnesses; prints the pinned CLI install
  command, never runs it.

Install (dogfood): see [INSTALL_FOR_AGENTS.md](INSTALL_FOR_AGENTS.md).

Develop:

```sh
cd cli
bun install
bun test            # unit suite
bun run typecheck
bun src/main.ts …   # run from source
bun ../scripts/build.ts --host   # compile dist/moda-host
```

Integration tests (against a local studio stack): set `MODA_API_BASE` + `MODA_API_KEY` and
run `bun test cli/test/integration/` — see `cli/test/integration/integration.test.ts`.

Contract: `docs/roadmap/moda-for-agents/cli.md` in the studio repo (verb tree, `--json`
output shape, exit codes) with the orchestrator rulings applied (endpoints under `/v1`;
browser key-mint auth; dogfood update channel prints `gh release download`).
