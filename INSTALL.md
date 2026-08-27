# Installing

Two pieces: the **skills** (what teaches your agent) and the **moda CLI**
(what it drives). Install both.

> `@moda-design/moda` installs from the public npm registry — no auth, no
> registry wiring.

## 1. Install the skills

| Harness | One-liner (you run it; the agent never installs) |
|---|---|
| Claude Code | `/plugin marketplace add moda-design/moda` then `/plugin install moda@moda` |
| Codex CLI | `npx skills add moda-design/moda` (drops into `~/.agents/skills/`) — fallback: `git clone https://github.com/moda-design/moda && cd moda && ./setup` |
| Cursor | `npx skills add moda-design/moda`, or clone + `./setup` |
| Anything with a shell | `git clone https://github.com/moda-design/moda && cd moda && ./setup` |
| claude.ai | Agent Skills uploads — see [INSTALL-CLAUDE-AI.md](INSTALL-CLAUDE-AI.md) |

`setup` copies the skill directories and **prints** the CLI install command
below — it never runs it.

The `/moda` router command (`commands/moda.md`) installs with the Claude Code
plugin only — other harnesses invoke the skills directly. Its routing table is
convenience; the cross-skill arbitration rules travel inside every skill's
shared UX rules, so no harness depends on the router being present.

## 2. Install the moda CLI

The package path is `npm i -g @moda-design/moda` (see the note at the top).
The rest of this section is the **no-npm, checksum-verified** path: GitHub
Releases on this repo. Release artifacts are named `moda-<platform>-<arch>`
(`moda-linux-x64`, `moda-linux-arm64`, `moda-darwin-x64`,
`moda-darwin-arm64`, `moda-win32-x64.exe`) plus a `SHA256SUMS` file. Run exactly:

```sh
gh release download --repo moda-design/moda -p "moda-$(uname -s | tr '[:upper:]' '[:lower:]')-$(uname -m | sed 's/x86_64/x64/; s/aarch64/arm64/')" -p SHA256SUMS -D /tmp/moda-dl
(cd /tmp/moda-dl && sha256sum -c SHA256SUMS --ignore-missing)   # macOS: shasum -a 256 -c SHA256SUMS --ignore-missing
install -m 0755 /tmp/moda-dl/moda-* "$HOME/.local/bin/moda"
moda doctor
```

Quick path without checksum verification:

```sh
gh release download --repo moda-design/moda -p moda-$(uname -s | tr '[:upper:]' '[:lower:]')-$(uname -m | sed 's/x86_64/x64/; s/aarch64/arm64/') -O ~/.local/bin/moda && chmod +x ~/.local/bin/moda
```

(`~/.local/bin` must be on PATH. Upgrades: `moda update` self-updates on
this channel — it downloads your platform's artifact, verifies it against
`SHA256SUMS`, and atomically replaces the running binary; if it can't
(e.g. the install dir is not writable by your user), it prints the
complete manual curl + verify + `mv` sequence instead.)

### Windows (x64)

The commands above are POSIX-shell only. On Windows use the npm package —
identical CLI, and it pulls `@moda-design/cli-win32-x64` automatically:

```powershell
npm i -g @moda-design/moda
moda doctor
```

Standalone alternative: download `moda-win32-x64.exe` plus `SHA256SUMS` from
the release, verify with `Get-FileHash moda-win32-x64.exe -Algorithm SHA256`,
and put it on `PATH` as `moda.exe`.

Windows notes: config lives in `%APPDATA%\moda`, state in `%LOCALAPPDATA%\moda`
(the XDG variables still win if your shell sets them). There is no Windows
keychain backend — Credential Manager's CLI cannot read a secret back — so
credentials sit in `%APPDATA%\moda\credentials.json`, protected by your
user-profile ACL rather than a POSIX mode bit; `moda auth login` says so once.

The Windows binary is **beta**: CI typechecks, unit-tests and runs the
compiled-binary stub proof on `windows-latest`, but it has not been soaked in
real use. Two fallbacks if it misbehaves: the claude.ai MCP connector needs no
local binary at all, and WSL2 runs the `moda-linux-x64` binary unchanged.

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
