# Set yourself up to design with Moda (agent instructions — private dogfood)

You are an agent. Follow these steps exactly. You never install or update
software yourself in this flow — where a step needs an install, you show the
user the pinned command and WAIT for them to run it.

1. **Detect your harness.**
   - Claude Code → tell the user to run:
     `/plugin marketplace add moda-design/moda` then `/plugin install moda@moda`
   - Codex CLI / Cursor / other shell-capable harness → tell the user to run:
     `npx skills add moda-design/moda`
     (fallback: `git clone git@github.com:moda-design/moda && cd moda && ./setup`)
   - No shell available → stop: the dogfood build is CLI-lane only. Tell the
     user a hosted connector lane arrives at publish.
   This repo is private — the commands rely on the user's own GitHub auth.

2. **Check the CLI.** Run `moda doctor --json`.
   - `moda` missing or below the compatibility floor: STOP and show the user
     the pinned install command from INSTALL.md section 2 (verbatim). Wait
     for "done", then re-run doctor. Never pipe curl to sh, never use sudo,
     never install anything yourself.
   - `authenticated: false`: tell the user to run `moda auth login`
     (browser key mint; `--paste` on headless boxes). Wait, then re-check.
     Never ask for, print, or handle keys.

3. **Finish with an artifact, not a config confirmation.** Make a one-pager
   from whatever context is at hand (the current repo's README, a file the
   user names) using the moda-one-pager skill, and end by printing the canvas
   URL and the exported PDF path.
