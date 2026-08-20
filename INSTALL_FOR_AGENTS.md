# Set yourself up to design with Moda (agent instructions)

You are an agent. Follow these steps exactly. You never install or update
software yourself in this flow — where a step needs an install, you show the
user the pinned command and WAIT for them to run it.

1. **Detect your harness.**
   - Claude Code → tell the user to run:
     `/plugin marketplace add moda-design/moda` then `/plugin install moda@moda`
   - Codex CLI / Cursor / other shell-capable harness → tell the user to run:
     `npx skills add moda-design/moda`
     (fallback: `git clone https://github.com/moda-design/moda && cd moda && ./setup`)
   - No shell available → stop and tell the user that the skills also ship in a
     connector-flavored form for claude.ai Agent Skills; see
     [INSTALL-CLAUDE-AI.md](INSTALL-CLAUDE-AI.md).

2. **Check the CLI.** Run `moda doctor --json`.
   - `moda` missing or below the compatibility floor: STOP and show the user
     the pinned install command from INSTALL.md section 2 (verbatim). Wait
     for "done", then re-run doctor. Never pipe curl to sh, never use sudo,
     never install anything yourself. If their install fails with a 401 or a
     registry error, have them retry explicitly against the public registry (`npm i -g @moda-design/moda --registry https://registry.npmjs.org`) — a
     locally configured private registry or proxy can shadow it.
   - `authenticated: false`: tell the user to run `moda auth login`
     (browser key mint; `--paste` on headless boxes). Wait, then re-check.
     Never ask for, print, or handle keys.

3. **Finish with an artifact, not a config confirmation.** Make a one-pager
   from whatever context is at hand (the current repo's README, a file the
   user names) using the moda-one-pager skill, and end by printing the canvas
   URL and the exported PDF path.
