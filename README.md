# moda — design skills + CLI for your agent

**Moda is a design runtime your agent can drive.** Point any shell-capable
agent — Claude Code, Codex, Cursor — at the `moda` CLI and the nine skills in
this repo, and it produces real, editable artifacts on your
[Moda](https://moda.app) account: decks that open as native PPTX, one-pagers
and reports as text-layer PDFs, social creative, diagrams, hosted websites,
video and motion, brand kits.

Not screenshots of designs. Not a chat that describes a deck. A live
collaborative canvas with a URL you can share, plus the exported file.

```
you ──► your agent ──► moda CLI ──► Moda canvas ──► deck.pptx + a share URL
```

This repo is the client half: the CLI source, the skills that teach an agent
how to use it well, and the harness manifests that install both.

---

## Install

> **Early access.** Moda for Agents is rolling out workspace by workspace. If
> `moda doctor` reports your workspace doesn't have API access yet, the
> install is fine — access just hasn't reached your workspace. Watch
> [moda.app](https://moda.app) for the open rollout.

Paste this to your agent — it runs everything:

```
Set up Moda for me so I can create designs, videos, decks, and documents from here.

1. Install the CLI: npm i -g @moda-design/moda
2. Authenticate: run `moda auth login` and wait for me to complete sign in.
3. Install the companion skills: run `npx skills add moda-design/moda`.
4. Verify: run `moda doctor` and tell me when everything is ready.
```


<details>
<summary>Fallback: standalone binary (air-gapped / no npm)</summary>

os: darwin | linux, arch: arm64 | x64; on macOS verify with
`shasum -a 256 -c` instead of `sha256sum -c`:

```sh
gh release download --repo moda-design/moda -p moda-<os>-<arch> -p SHA256SUMS
grep moda-<os>-<arch> SHA256SUMS | sha256sum -c -
install -m 755 moda-<os>-<arch> ~/.local/bin/moda && rm moda-<os>-<arch> SHA256SUMS
```

Windows (x64) ships `moda-win32-x64.exe` — same CLI, suffixed because Windows
needs it. Download it, verify against `SHA256SUMS`, and put it on `PATH` as
`moda.exe`. The npm path above is the supported one; the `.exe` is **beta**
(cross-compiled and unit-tested on Windows CI, not yet soaked in real use).

</details>

Per harness:

- **Claude Code** — the paste block works as-is. Alternative:
  `/plugin marketplace add moda-design/moda` then `/plugin install moda@moda`
  gives plugin-managed skills that update through the marketplace, where
  `npx skills add` pins a local copy (steps 1–2 still apply for the CLI).
- **Codex** — the paste block as-is.
- **Cursor** — `npx skills add moda-design/moda`, or clone and run `./setup`.
- **Anything with a shell** — clone and run `./setup`; it copies the skills
  and *prints* the CLI install command, never runs it.
- **claude.ai** — the skills also ship in a connector-flavored form for
  claude.ai Agent Skills; see [INSTALL-CLAUDE-AI.md](INSTALL-CLAUDE-AI.md).

Full detail, including checksum-verified installs:
[INSTALL.md](INSTALL.md). Agent-facing instructions to hand an agent
directly: [INSTALL_FOR_AGENTS.md](INSTALL_FOR_AGENTS.md).

## Quickstart

```sh
moda auth login     # opens the browser; mints a scoped key into your OS keychain
moda doctor         # CLI version, auth, API reachability, entitlements — one call
```

Then start a new agent session and ask for something real:

> "Make a one-pager from this README and give me the PDF and a link."

The agent picks the right skill, checks the CLI and your auth first, designs
on a real canvas, screenshots it to verify its own work, and finishes with a
canvas URL plus the exported file. No verb names, no flags, no coaching from
you.

Headless or CI: set `MODA_API_KEY` to a scoped key
(`moda auth login --paste` mints one for a machine with no browser). No CLI
verb ever prints a credential.

## The skills

Nine skills, each self-contained. They are the difference between an agent
that *can* call the CLI and one that reliably produces something you'd send
to a customer.

| Skill | What it makes |
|---|---|
| `moda-deck` | Slide decks from a brief/doc/repo → native, editable PPTX |
| `moda-one-pager` | One-pagers, multi-page reports, and print pieces → text-layer PDF |
| `moda-social` | Social posts, carousels, static ads, banners → png/jpeg (carousel = zip) |
| `moda-diagram` | Flowcharts, 2×2 matrices, UI wireframes/mockups → png/pdf |
| `moda-website` | Live websites → published to a public `*.moda.page` URL |
| `moda-video` | Video and motion: generated clips (brand stingers, image-to-video), animation-canvas exports → mp4/gif |
| `moda-brand` | Brand-kit reads, creation, and canvas-vs-kit audits |
| `moda-edit` | Precise edits to an existing canvas from its URL |
| `moda-help` | Meta home: setup/update, auth + orgs, routing, CLI troubleshooting |

Plus `/moda` (Claude Code) as a router.

Three things every skill shares:

- **Step 0.** Every run starts with the same doctor bootstrap — CLI version,
  auth, entitlements, brand kits. A skill that finds the CLI missing or stale
  *stops* and shows you the pinned command. It never installs anything
  itself, never pipes a script to a shell, never uses sudo.
- **Deliverables over plumbing.** The agent verifies its own output
  (screenshot, lint) before it replies, and ends on an artifact — a URL and a
  file — not a status report.
- **Honest metering.** Deterministic authoring costs nothing. The metered
  verbs (image/video generation, upscales) are labeled with their cost class
  and report a receipt in the delivery note.

Exactly one skill claims any given ask — the mutual-exclusivity contract is
written down and maintained in [docs/routing-table.md](docs/routing-table.md).

## Update

Paste this to your agent:

```
Update Moda to the latest version for me.

1. Update the CLI: npm i -g @moda-design/moda
2. Update the companion skills: npx skills add moda-design/moda
3. Verify: run `moda doctor` and confirm everything is healthy, then tell
   me the update succeeded.
```

The CLI and the skills update separately: installed skills are hash-pinned in
`skills-lock.json` and never auto-update (step 2 re-resolves them), while the
CLI prints a once-daily stderr notice naming the update command whenever a
newer version exists.

## Repo layout

- `cli/` — TypeScript source of the `moda` CLI, compiled with Bun into
  per-platform standalone binaries (`bun scripts/build.ts`).
- `skills/` — the nine skills, each self-contained with its `references/`.
- `shared/` — the canonical authored copy of the shared blocks and
  references; `scripts/fanout.sh` fans them into the skills.
- `commands/` — the `/moda` router command (Claude Code).
- `packages/` — npm distribution: `moda` wrapper + per-platform
  `optionalDependencies` packages (the esbuild/biome pattern).
- `scripts/` — build matrix (`build.ts`), npm stamping, release/checksums
  (`release.ts`), inventory parity, and `validate.py` (frontmatter lint,
  shared-block/fan-out integrity, banned-name greps, verb parity, markup
  element completeness, size budgets).
- `mcp/` + `dist/mcp-skills/` — the connector-flavored projection of the nine
  skills for claude.ai Agent Skills upload: `scripts/project-mcp.py`
  re-speaks every CLI verb as the Moda connector's tools (rules in
  `scripts/mcp_projection_rules.py`; `mcp/connector-tools.json` is the tool
  roster). The projection is a committed build artifact — regenerate with
  `python3 scripts/project-mcp.py build`; CI fails on drift. Per-skill
  `moda-*.skill.zip` uploads are attached to each release; install steps in
  [INSTALL-CLAUDE-AI.md](INSTALL-CLAUDE-AI.md).
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

Integration tests run against a live API base: set `MODA_API_BASE` +
`MODA_API_KEY` and run `bun test cli/test/integration/` — see
`cli/test/integration/integration.test.ts`.

## Contributing and security

- [CONTRIBUTING.md](CONTRIBUTING.md) — the current stance (we are not taking
  outside code contributions yet) and how to work on the skills.
- [SECURITY.md](SECURITY.md) — how to report a vulnerability. Please don't
  open a public issue for one.
- Issues are welcome for bugs and rough edges in the skills or the CLI.
- [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) — the open-source
  libraries bundled into the compiled CLI, with their license texts.

Moda itself lives at [moda.app](https://moda.app).

## License

[Apache-2.0](LICENSE) © Nullframe, Inc. (Moda). Bundled third-party licenses are listed in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
