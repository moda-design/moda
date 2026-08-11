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

## 2. Install the moda CLI (pinned command)

The dogfood channel is GitHub Releases on this repo (`github-private`); npm
and Homebrew come at publish. Run exactly:

```sh
gh release download -R moda-design/moda -p "moda-$(uname -s | tr '[:upper:]' '[:lower:]')-$(uname -m)*" -D /tmp/moda-dl
(cd /tmp/moda-dl && shasum -a 256 -c checksums.txt --ignore-missing)
install -m 0755 /tmp/moda-dl/moda-* "$HOME/.local/bin/moda"
moda doctor
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
