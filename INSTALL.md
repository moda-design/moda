# Installing (private dogfood)

This repo is **private**. Every install path below rides your existing GitHub
auth (`gh auth login` / git SSH); nothing here is published anywhere.

## 1. Install the skills

| Harness | One-liner (you run it; the agent never installs) |
|---|---|
| Claude Code | `/plugin marketplace add moda-design/moda` then `/plugin install moda@moda` |
| Codex CLI | `npx skills add moda-design/moda` (drops into `~/.agents/skills/`; rides git auth) — fallback: `git clone git@github.com:moda-design/moda && cd moda && ./setup` |
| Cursor | `npx skills add moda-design/moda`, or clone + `./setup` |
| Anything with a shell | `git clone git@github.com:moda-design/moda && cd moda && ./setup` |

`setup` copies the skill directories and **prints** the CLI install command
below — it never runs it.

The `/moda` router command (`commands/moda.md`) installs with the Claude Code
plugin only — other harnesses invoke the skills directly. Its routing table is
convenience; the cross-skill arbitration rules travel inside every skill's
shared UX rules, so no harness depends on the router being present.

## 2. Install the moda CLI (pinned command)

The dogfood channel is GitHub Releases on this repo (`github-private`); npm
and Homebrew come at publish. Release artifacts are named
`moda-<platform>-<arch>` (`moda-linux-x64`, `moda-linux-arm64`,
`moda-darwin-x64`, `moda-darwin-arm64`) plus a `SHA256SUMS` file. Run exactly:

```sh
gh release download --repo moda-design/moda -p "moda-$(uname -s | tr '[:upper:]' '[:lower:]')-$(uname -m | sed 's/x86_64/x64/; s/aarch64/arm64/')" -p SHA256SUMS -D /tmp/moda-dl
(cd /tmp/moda-dl && sha256sum -c SHA256SUMS --ignore-missing)   # macOS: shasum -a 256 -c SHA256SUMS --ignore-missing
install -m 0755 /tmp/moda-dl/moda-* "$HOME/.local/bin/moda"
moda doctor
```

Quick path without checksum verification — the same command `moda doctor`
and `moda update` print on this channel (they print your platform's artifact
name already resolved, e.g. `-p moda-linux-x64`):

```sh
gh release download --repo moda-design/moda -p moda-$(uname -s | tr '[:upper:]' '[:lower:]')-$(uname -m | sed 's/x86_64/x64/; s/aarch64/arm64/') -O ~/.local/bin/moda && chmod +x ~/.local/bin/moda
```

(`~/.local/bin` must be on PATH. Upgrades: same command — `moda update`
prints it too rather than self-updating on this channel.)

## 3. Authenticate

```sh
moda auth login          # opens the browser; mints a scoped key into the OS keychain
moda auth login --paste  # headless: paste the key shown in the browser once
```

CI / automation: set `MODA_API_KEY` with a scoped key. No CLI verb ever
prints a credential.

## 4. First artifact

Start a new agent session and ask for something real — e.g.
"make a one-pager from this README". The skills take it from there and end
on a canvas link plus the exported file.

Rules that hold everywhere: never `curl | sh`, never sudo, never a silent install —
a skill that finds the CLI missing or stale STOPS and shows you the pinned
command above.
