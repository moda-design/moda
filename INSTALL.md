# Installing

**The procedure lives at <https://docs.moda.app/agents/setup> —
[`setup.md`](https://docs.moda.app/agents/setup.md) is the copy written to an agent.**
Point your agent at that URL and it installs the CLI, signs you in, installs the skills,
and verifies the result. It is the single authority for how setup goes; this file does not
restate it.

What is here instead is the part that procedure deliberately leaves out: installing the
binary **without npm**, and the Windows specifics.

> `@moda-design/moda` installs from the public npm registry — no auth, no registry wiring.
> If npm works for you, `npm i -g @moda-design/moda` is the whole story and the rest of
> this file is unnecessary.

## Install without npm (checksum-verified)

GitHub Releases on this repo. Artifacts are named `moda-<platform>-<arch>`
(`moda-linux-x64`, `moda-linux-arm64`, `moda-darwin-x64`, `moda-darwin-arm64`,
`moda-win32-x64.exe`) plus a `SHA256SUMS` file. Run exactly:

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

(`~/.local/bin` must be on PATH. Upgrades: `moda update` self-updates on this channel — it
downloads your platform's artifact, verifies it against `SHA256SUMS`, and atomically
replaces the running binary; if it can't (e.g. the install dir is not writable by your
user), it prints the complete manual curl + verify + `mv` sequence instead.)

## Windows (x64)

The commands above are POSIX-shell only. On Windows use the npm package — identical CLI,
and it pulls `@moda-design/cli-win32-x64` automatically:

```powershell
npm i -g @moda-design/moda
moda doctor
```

Standalone alternative: download `moda-win32-x64.exe` plus `SHA256SUMS` from the release,
verify with `Get-FileHash moda-win32-x64.exe -Algorithm SHA256`, and put it on `PATH` as
`moda.exe`.

Windows notes: config lives in `%APPDATA%\moda`, state in `%LOCALAPPDATA%\moda` (the XDG
variables still win if your shell sets them). There is no Windows keychain backend —
Credential Manager's CLI cannot read a secret back — so credentials sit in
`%APPDATA%\moda\credentials.json`, protected by your user-profile ACL rather than a POSIX
mode bit; `moda auth login` says so once.

The Windows binary is **beta**: CI typechecks, unit-tests and runs the compiled-binary stub
proof on `windows-latest`, but it has not been soaked in real use. Two fallbacks if it
misbehaves: the MCP connector needs no local binary at all, and WSL2 runs the
`moda-linux-x64` binary unchanged.

## Rules that hold everywhere

Never `curl | sh`, never sudo, never a silent install — a skill that finds the CLI missing
or stale STOPS and shows you the pinned command. No CLI verb ever prints a credential.

The one exception is first-run bootstrap: the [setup
procedure](https://docs.moda.app/agents/setup.md) lets an agent run
`npm i -g @moda-design/moda` itself, because at that point nothing is installed and there
is no skill to defer to. The prohibition resumes the moment the skills exist.
