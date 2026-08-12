# Contributing

**Dogfood phase (now):** skill text is authored directly in this repo.

- Shared blocks (`shared/step0.md`, `shared/ux-rules.md`) and canonical
  references (`shared/references/*.md`) are the single source of truth.
- After editing them, run `./scripts/fanout.sh` to refresh the per-skill
  copies, then `python3 scripts/validate.py`. Commit both the canonical file
  and the fanned copies — CI fails on drift.
- SKILL.md bodies embed the shared blocks byte-identically; if you change a
  shared block you must update all eight SKILL.md files to match (the
  validator enforces it).
- Verb names are canonical to the moda CLI contract (`verb-map.json` lists
  the allowed inventory). Internal Moda tool names never appear here.
- `allowed-tools` frontmatter is Claude Code-only metadata: other harnesses
  ignore it entirely, and even in Claude Code it is a permissions hint, not
  containment. Never rely on it to restrict what an agent can do, and keep
  SKILL.md prose harness-neutral — say "your harness's file-reading/search
  tools", not literal tool names like Read/Glob/Grep.

**At ship time:** this repo becomes a generated artifact of the studio
`skills-src/` publish pipeline. From that point, PR upstream in studio — the
publish workflow force-reconciles this tree, so drive-by edits here will not
stick.
