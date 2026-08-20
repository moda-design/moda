# moda — design skills for your agent

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

> **This repository is a generated artifact.** It carries the published
> skills, harness manifests, and install docs — exactly what
> `npx skills add moda-design/moda` and the plugin marketplaces consume — and
> it is regenerated automatically from the Moda platform on every change, so
> it is always current. The CLI itself ships on npm
> (`@moda-design/moda`); its source is developed on the Moda platform and is
> not in this repo. **Issues and feedback are welcome here** — the tracker is
> read by the team. Pull requests can't be accepted against generated
> content.

---

## Install

> **Available now.** Public Moda-for-Agents API access rolled out to 100% of
> users, unfiltered, on 2026-08-17.

Paste this to your agent — it runs everything:

```
Set up Moda for me so I can create designs, videos, decks, and documents from here.

1. Install the CLI: npm i -g @moda-design/moda
2. Authenticate: run `moda auth login` and wait for me to complete sign in.
3. Install the companion skills: run `npx skills add moda-design/moda`.
4. Verify: run `moda doctor` and tell me when everything is ready.
```

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
  (screenshot) before it replies, and ends on an artifact — a URL and a
  file — not a status report.
- **Honest metering.** Deterministic authoring costs nothing. The metered
  verbs (image/video generation, upscales) are labeled with their cost class
  and report a receipt in the delivery note.

Exactly one skill claims any given ask — routing is mutually exclusive by
contract, and `moda-help` owns the tie-breaks.

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

## Security

See [SECURITY.md](SECURITY.md) for how to report a vulnerability.

## License

[Apache-2.0](LICENSE) © Nullframe, Inc. (Moda). Bundled third-party licenses
are listed in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
