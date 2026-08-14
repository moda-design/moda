# Contributing

**We are not accepting outside code contributions yet.** The skills and the
CLI are moving fast and the authoring pipeline is still being settled, so
pull requests from outside the team will generally be closed unread. That
will change — this note gets rewritten when it does.

**What is very welcome right now:** issues. If a skill misroutes an ask,
produces something off, or the CLI gives you a confusing error, open an issue
with what you asked for and what you got. That is the highest-value feedback
we can get. For anything security-related, use
[SECURITY.md](SECURITY.md) instead of a public issue.

## Working on the skills (maintainers)

- Shared blocks (`shared/step0.md`, `shared/ux-rules.md`) and canonical
  references (`shared/references/*.md`) are the single source of truth.
- After editing them, run `./scripts/fanout.sh` to refresh the per-skill
  copies, then `python3 scripts/validate.py`. Commit both the canonical file
  and the fanned copies — CI fails on drift.
- SKILL.md bodies embed the shared blocks byte-identically; if you change a
  shared block you must update all nine SKILL.md files to match (the
  validator enforces it).
- Verb names are canonical to the moda CLI contract (`verb-map.json` lists
  the allowed inventory). Internal Moda tool names never appear here.
- `allowed-tools` frontmatter is Claude Code-only metadata: other harnesses
  ignore it entirely, and even in Claude Code it is a permissions hint, not
  containment. Never rely on it to restrict what an agent can do, and keep
  SKILL.md prose harness-neutral — say "your harness's file-reading/search
  tools", not literal tool names like Read/Glob/Grep.
- The connector-flavored projection under `dist/mcp-skills/` is generated.
  Never hand-edit it: change `skills/`, `shared/`, `mcp/`, or
  `scripts/mcp_projection_rules.py` and run
  `python3 scripts/project-mcp.py build`.

Acceptance for skill changes is a cold-session run, not a unit test — the
protocol is in [docs/internal/cold-test.md](docs/internal/cold-test.md).
