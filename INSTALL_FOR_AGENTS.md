# Install Moda for Agents (dogfood variant)

> Private-repo dogfood edition. The public variant (npm/brew install lines, served at
> moda.app/agents.md) replaces this at publish. You need git/`gh` credentials that can read
> `moda-design/moda`.

## 1. Install the CLI (pinned command — never `curl | sh`, never sudo)

```sh
gh release download --repo moda-design/moda -p moda-$(uname -s | tr '[:upper:]' '[:lower:]')-$(uname -m | sed 's/x86_64/x64/; s/aarch64/arm64/') -O ~/.local/bin/moda && chmod +x ~/.local/bin/moda
```

Verify: `moda version` then `moda doctor --json`.

## 2. Install the skills

- **Claude Code**: `/plugin marketplace add moda-design/moda` then `/plugin install moda@moda`.
- **Codex / anything file-based**: `git clone git@github.com:moda-design/moda && cd moda && ./setup`
  (drops `skills/` into `~/.agents/skills/`; prints — never runs — the CLI install command).

## 3. Authenticate

- Interactive: `moda auth login` (browser key-mint → localhost callback → OS keychain).
- Headless/CI: set `MODA_API_KEY` (mint a scoped key in the Moda app). No verb ever prints a
  credential.

## 4. Smoke test

```sh
moda canvas create --name "hello" --json
moda canvas markup <ref> --file - <<'XML'
<content><text font-size="64">Hello from your agent</text></content>
XML
moda canvas screenshot <ref> -o hello.png
moda canvas share <ref>
```

Notes: exit 0 always means the mutation committed (`requires_repair: true` = committed but
needs a follow-up fix — never re-run the same command). `moda docs workflow` prints the full
loop offline.
