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

**Point your agent at <https://docs.moda.app/agents/setup.md> and it does the rest** —
installs the CLI, signs you in, installs the skills, and verifies the result. That page is
the single authority for setup; this README used to restate it, and the copy is gone rather
than kept in step.

```
Set up Moda by following the guide at https://moda.app/install.md
```

No shell? The same page's step 5 covers the MCP connector for chat-only hosts.

Two things that page deliberately leaves out, because they are human reference rather than
agent procedure: [INSTALL.md](INSTALL.md) has the no-npm, checksum-verified release path
and the Windows specifics, and Claude Code users may prefer plugin-managed skills —
`/plugin marketplace add moda-design/moda` then `/plugin install moda@moda` — which update
through the marketplace where `npx skills add` pins a local copy.

## The skills

Nine skills, each self-contained. They are the difference between an agent
that *can* call the CLI and one that reliably produces something you'd send
to a customer.

| Skill | What it makes | Recipe children |
|---|---|---|
| `moda-core` | Meta home: setup/update, auth + teams, routing, recovery | — |
| `moda-deck` | Slide decks from a brief/doc/repo → native, editable PPTX | `-pptx` (import and fix a `.pptx`) |
| `moda-document` | One-pagers, reports, whitepapers of any length → text-layer PDF | `-print` (poster, flyer, menu, resume, cards, merch) |
| `moda-social` | Posts, carousels, stories, quote cards, logo/icon design → png/jpeg (carousel = zip) | `-instagram`, `-linkedin`, `-tiktok`, `-youtube`, `-ads` |
| `moda-diagram` | Flowcharts, org charts, decision trees, swimlanes, 2×2 matrices → png/pdf | — |
| `moda-chart` | Standalone data charts from real numbers → png/pdf | — |
| `moda-mockup` | Static UI mockups and wireframes at real viewport sizes → png/pdf | — |
| `moda-website` | Live websites → published to a public `*.moda.page` URL | — |
| `moda-video` | Video and motion → mp4/gif | `-clip` (generated clips), `-motion` (vector-native motion) |
| `moda-image` | Images as the deliverable: generate, edit, upscale, outpaint | — |
| `moda-audio` | Voiceover, narration, music, jingles, sound effects | — |
| `moda-brand` | Brand-kit reads, creation, and canvas-vs-kit audits | — |
| `moda-edit` | Precise edits, exports, and shares of an existing canvas from its URL | — |

Plus four helpers — `moda-library` (workspace, drive, assets), `moda-templates`
(team templates), `moda-context` (repo-pinned defaults), `moda-automate`
(recurring work) — and `/moda` (Claude Code) as a router.

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
contract, and `moda-core` owns the tie-breaks.

## Update

Paste this to your agent:

```
Update Moda to the latest version for me.

1. Run `moda update` — it updates the CLI and the companion skills in one
   step, and prints the exact command to run yourself for anything it
   cannot do from inside the session.
2. Verify: run `moda doctor` and confirm everything is healthy, then tell
   me the update succeeded.
```

`moda update` covers both halves: the CLI (a plain `npm i -g` reinstall —
printed rather than run on Windows, where the running binary is locked) and
the installed skills (re-resolving the hash pins in `skills-lock.json`).
Nothing updates silently: the at-most-hourly update-available line and
`moda doctor` only ever *suggest* the verb.

## Security

See [SECURITY.md](SECURITY.md) for how to report a vulnerability.

## License

[Apache-2.0](LICENSE) © Nullframe, Inc. (Moda). Bundled third-party licenses
are listed in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
