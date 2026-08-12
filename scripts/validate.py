#!/usr/bin/env python3
"""Repo-local validation for the Moda skills package.

Checks (mirrors skills-and-distribution.md section 3, adapted to the
dogfood-authored repo):

1. Frontmatter lint (name matches directory, description, argument-hint,
   allowed-tools restricted to Bash(moda:*) + read-only file tools).
2. Shared-block integrity: the Step-0 and UX-rules blocks in every SKILL.md
   are byte-identical to shared/step0.md and shared/ux-rules.md.
3. Reference fan-out integrity: per-skill references/ copies are
   byte-identical to shared/references/ and match the expected set.
4. Link check: every references/*.md a SKILL.md mentions exists.
5. Banned-name greps: internal tool names and removed concepts never appear
   in external skill text; no curl-pipe-sh, no sudo (prohibition sentences
   containing "never" are exempt).
6. Verb parity: every backticked/fenced `moda ...` invocation resolves to the
   inventory in verb-map.json; optionally cross-checked against a local CLI
   source tree (MODA_CLI_ROOT, default ../moda) when one exists.
7. Markup element completeness: the external markup reference documents all
   23 parser dispatch elements (the chart/path/repeat/generate trap).
8. Size budgets: SKILL.md <= 150 lines, each reference <= 350 lines.
9. Manifests parse and agree on the plugin name.

Exit 0 = clean. Any finding prints with its file and fails the run.
"""

from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

SKILLS = ["moda-deck", "moda-one-pager", "moda-brand", "moda-edit", "moda-website", "moda-social", "moda-diagram", "moda-help"]

# Must mirror scripts/fanout.sh.
EXPECTED_REFERENCES: dict[str, list[str]] = {
    "moda-deck": [
        "markup", "edit-code", "reading-and-verifying", "gotchas", "design-quality",
        "brand", "export", "omni-and-media", "deck-design", "deck-playbooks", "charts", "web",
    ],
    "moda-one-pager": [
        "markup", "edit-code", "reading-and-verifying", "gotchas", "design-quality",
        "brand", "export", "omni-and-media", "document-design", "web", "charts",
    ],
    "moda-brand": [
        "brand", "gotchas", "markup", "design-quality", "charts", "edit-code", "omni-and-media",
        "reading-and-verifying",
    ],
    "moda-edit": [
        "edit-code", "reading-and-verifying", "gotchas", "markup", "design-quality", "brand",
        "charts", "omni-and-media",
    ],
    "moda-website": [
        "website", "brand", "web", "design-quality", "omni-and-media", "markup", "edit-code",
        "gotchas", "charts", "reading-and-verifying",
    ],
    "moda-social": [
        "social", "markup", "edit-code", "reading-and-verifying", "gotchas", "design-quality",
        "brand", "export", "omni-and-media", "charts",
    ],
    "moda-help": [
        "brand", "gotchas", "markup", "design-quality", "charts", "edit-code", "omni-and-media",
        "reading-and-verifying",
    ],
    "moda-diagram": [
        "diagram", "markup", "edit-code", "reading-and-verifying", "gotchas", "design-quality",
        "brand", "export", "charts", "omni-and-media",
    ],
}

ALLOWED_TOOLS = {"Bash(moda:*)", "Read", "Glob", "Grep"}

# The 23 markupParser.ts dispatch elements (content is the root).
MARKUP_ELEMENTS = [
    "content", "group", "row", "column", "layers", "rectangle", "ellipse",
    "polygon", "star", "line", "connector", "text", "image", "path", "chart",
    "qr", "latex", "map", "background", "comment", "table", "repeat", "generate",
]

# Internal names and removed concepts that must never appear in external text.
BANNED_TOKENS = [
    "attachState", "dryRun", "dry_run", "--dry-run",
    "layout_mode", "layoutMode",
    "search_assets", "view_image", "read_skill", "layerize",
    "create_pages", "idMapping", "assetMapping", "skill://",
    "start_design_task", "create_from_markup", "edit_canvas",
    "read_canvas_state", "delete_canvas_items", "capture_canvas_screenshot",
    "lint_canvas", "create_canvas", "export_canvas",
    "generate_image", "generate_video", "remove_image_background",
    "upscale_image", "upscale_video",
    "list_brand_kits", "find_brand_kits", "create_brand_kit",
    "create_website", "open_website", "close_website", "screenshot_website",
    "edit_website", "publish_website",
    "editWarnings", "requiresRepair", "noOpReason", "operationCounts",
    "moda auth token",
    "eager",
    "MCP",
    # Web-research provider neutrality (founder-explicit): the research lane never names an
    # underlying provider. ("exa" is unusable as a substring guard — it matches "example".)
    "firecrawl",
    "Firecrawl",
]

# Patterns banned even in INSTALL/setup; a line containing "never" is a
# prohibition sentence and exempt.
BANNED_PATTERNS = [
    (re.compile(r"curl[^\n|]*\|\s*(sudo\s+)?sh\b"), "curl piped to sh"),
    (re.compile(r"\bsudo\b"), "sudo"),
]

SKILL_TEXT_GLOBS = ["skills/**/*.md", "shared/**/*.md", "commands/*.md"]
INSTALL_FILES = ["INSTALL.md", "INSTALL_FOR_AGENTS.md", "setup", "README.md", "CONTRIBUTING.md"]

findings: list[str] = []


def fail(path: Path | str, msg: str) -> None:
    findings.append(f"{path}: {msg}")


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def skill_dir(skill: str) -> Path:
    return ROOT / "skills" / skill


def parse_frontmatter(text: str, path: Path) -> dict[str, str]:
    if not text.startswith("---\n"):
        fail(path, "missing frontmatter")
        return {}
    end = text.find("\n---\n", 4)
    if end == -1:
        fail(path, "unterminated frontmatter")
        return {}
    block = text[4:end]
    fields: dict[str, str] = {}
    key = None
    for line in block.splitlines():
        m = re.match(r"^([a-z-]+):\s*(.*)$", line)
        if m:
            key = m.group(1)
            fields[key] = m.group(2).strip()
        elif key and (line.startswith("  ") or line.startswith("\t")):
            fields[key] = (fields[key] + " " + line.strip()).strip()
    return fields


def check_frontmatter() -> None:
    for skill in SKILLS:
        path = skill_dir(skill) / "SKILL.md"
        if not path.exists():
            fail(path, "missing SKILL.md")
            continue
        fm = parse_frontmatter(read(path), path)
        if fm.get("name") != skill:
            fail(path, f"frontmatter name {fm.get('name')!r} != directory {skill!r}")
        desc = fm.get("description", "")
        if not desc:
            fail(path, "missing description")
        elif len(desc) > 1024:
            fail(path, f"description too long ({len(desc)} chars > 1024)")
        if not fm.get("argument-hint"):
            fail(path, "missing argument-hint")
        tools = {t.strip() for t in fm.get("allowed-tools", "").split(",") if t.strip()}
        if not tools:
            fail(path, "missing allowed-tools")
        extra = tools - ALLOWED_TOOLS
        if extra:
            fail(path, f"allowed-tools outside the permitted set: {sorted(extra)}")
        if "Bash(moda:*)" not in tools:
            fail(path, "allowed-tools must include Bash(moda:*)")


def check_shared_blocks() -> None:
    for block_file in ["step0.md", "ux-rules.md"]:
        block = read(ROOT / "shared" / block_file).strip()
        for skill in SKILLS:
            path = skill_dir(skill) / "SKILL.md"
            if not path.exists():
                continue
            if block not in read(path):
                fail(path, f"shared block {block_file} is not embedded byte-identically")


def check_fanout() -> None:
    canonical_dir = ROOT / "shared" / "references"
    for skill, refs in EXPECTED_REFERENCES.items():
        ref_dir = skill_dir(skill) / "references"
        actual = sorted(p.stem for p in ref_dir.glob("*.md")) if ref_dir.exists() else []
        if actual != sorted(refs):
            fail(ref_dir, f"reference set mismatch: expected {sorted(refs)}, found {actual}")
            continue
        for ref in refs:
            canonical = canonical_dir / f"{ref}.md"
            copy = ref_dir / f"{ref}.md"
            if read(canonical) != read(copy):
                fail(copy, "drifted from canonical shared/references copy — re-run scripts/fanout.sh")


def check_links() -> None:
    for skill in SKILLS:
        path = skill_dir(skill) / "SKILL.md"
        if not path.exists():
            continue
        text = read(path)
        for ref in set(re.findall(r"references/([a-z-]+)\.md", text)):
            if not (skill_dir(skill) / "references" / f"{ref}.md").exists():
                fail(path, f"mentions references/{ref}.md which does not exist in this skill")


def iter_skill_texts():
    for pattern in SKILL_TEXT_GLOBS:
        for path in sorted(ROOT.glob(pattern)):
            if path.is_file():
                yield path


def check_banned() -> None:
    scan = list(iter_skill_texts()) + [ROOT / f for f in INSTALL_FILES if (ROOT / f).exists()]
    for path in scan:
        text = read(path)
        rel = path.relative_to(ROOT)
        is_skill_text = str(rel).startswith(("skills/", "shared/", "commands/"))
        if is_skill_text:
            for token in BANNED_TOKENS:
                for i, line in enumerate(text.splitlines(), 1):
                    if token in line:
                        fail(rel, f"line {i}: banned token {token!r}")
        for pattern, label in BANNED_PATTERNS:
            for i, line in enumerate(text.splitlines(), 1):
                if pattern.search(line) and "never" not in line.lower():
                    fail(rel, f"line {i}: banned pattern ({label})")


def extract_cli_invocations(text: str) -> set[str]:
    """All `moda ...` invocations inside inline code or fenced blocks."""
    spans: list[str] = re.findall(r"`([^`]+)`", text)
    fence = re.compile(r"^(?:```|~~~)")
    in_fence = False
    for line in text.splitlines():
        if fence.match(line.strip()):
            in_fence = not in_fence
            continue
        if in_fence:
            spans.append(line)
    invocations: set[str] = set()
    for span in spans:
        for m in re.finditer(r"\bmoda\s+([a-z][a-z-]*)(?:\s+([a-z][a-z-]*))?", span):
            one = f"moda {m.group(1)}"
            two = f"moda {m.group(1)} {m.group(2)}" if m.group(2) else None
            invocations.add(two or one)
    return invocations


def check_verb_parity() -> None:
    verb_map = json.loads(read(ROOT / "verb-map.json"))
    allowed: set[str] = set(verb_map["cli_invocations_allowed"])
    allowed_nouns = {" ".join(a.split()[:2]) for a in allowed if len(a.split()) > 2}
    used: set[str] = set()
    for path in iter_skill_texts():
        for inv in extract_cli_invocations(read(path)):
            words = inv.split()
            ok = (
                inv in allowed
                or " ".join(words[:2]) in allowed
                or inv in allowed_nouns  # noun prefix of a 3-word verb, e.g. `moda media *`
                or any(a.startswith(inv + " ") for a in allowed)
            )
            if not ok:
                fail(path.relative_to(ROOT), f"CLI invocation {inv!r} not in verb-map.json inventory")
            else:
                used.add(inv)

    cli_root = Path(os.environ.get("MODA_CLI_ROOT", str(ROOT.parent / "moda")))
    cli_src = None
    for candidate in [cli_root / "cli", cli_root / "src", cli_root]:
        if candidate.is_dir() and any(candidate.rglob("*.ts")):
            cli_src = candidate
            break
    if cli_src is None:
        print(f"note: no CLI source tree at {cli_root} — skipping CLI-tree verb cross-check")
        return
    # Strict mode is the M5 acceptance gate (CLI verb inventory frozen). While
    # the CLI is under construction, misses are warnings so the skills repo can
    # land ahead of the verb tree.
    strict = os.environ.get("MODA_CLI_STRICT") == "1"
    corpus = "\n".join(
        read(p) for p in cli_src.rglob("*.ts")
        if p.is_file() and "node_modules" not in p.parts
    )
    for inv in sorted(used):
        words = inv.split()
        if len(words) < 3:
            continue  # nouns/top-level verbs are structural; check leaf verbs only
        leaf = words[-1]
        if leaf not in corpus:
            msg = f"verb {inv!r} used in skills but leaf {leaf!r} not found in CLI tree {cli_src}"
            if strict:
                fail("verb-map.json", msg)
            else:
                print(f"warning (MODA_CLI_STRICT=0): {msg}")


def check_markup_elements() -> None:
    path = ROOT / "shared" / "references" / "markup.md"
    text = read(path)
    for element in MARKUP_ELEMENTS:
        if f"<{element}" not in text:
            fail(path.relative_to(ROOT), f"markup element <{element}> is not documented (23-element checklist)")


def check_budgets() -> None:
    for skill in SKILLS:
        path = skill_dir(skill) / "SKILL.md"
        if path.exists() and (n := len(read(path).splitlines())) > 150:
            fail(path.relative_to(ROOT), f"SKILL.md over budget: {n} lines > 150")
    for path in sorted((ROOT / "shared" / "references").glob("*.md")):
        if (n := len(read(path).splitlines())) > 350:
            fail(path.relative_to(ROOT), f"reference over budget: {n} lines > 350")


def check_payload_paths() -> None:
    """Installers ship skill DIRECTORIES only (Claude/Codex/Cursor payloads = skills/<name>/).
    Any .md path a skill's text references must therefore live inside that skill's own payload:
    references/<name>.md (existence via check_links), a bare sibling reference name, or
    SKILL.md itself. Repo-root pointers (INSTALL.md, docs/…, shared/…) do not survive
    `npx skills add` and are banned. Also: every skills-shipping manifest must list every skill."""
    # Regex self-check (negative case): an http(s) URL ending in .md must never be a candidate.
    assert [m.group(1) for m in re.finditer(r"https?://\S+|([A-Za-z0-9_./-]*\.md\b)",
            "see https://x.io/a.md and references/brand.md") if m.group(1)] == ["references/brand.md"]
    for skill in SKILLS:
        base = skill_dir(skill)
        for path in [base / "SKILL.md", *sorted((base / "references").glob("*.md"))]:
            if not path.exists():
                continue
            # URLs are consumed by the first alternative so an http(s) link ending in .md can
            # never register as a payload path; only group(1) matches are candidate tokens.
            for m in re.finditer(r"https?://\S+|([A-Za-z0-9_./-]*\.md\b)", read(path)):
                token = m.group(1)
                if token is None or token in ("SKILL.md",):
                    continue
                if token.startswith("references/") and (base / token).exists():
                    continue
                if "/" not in token and (base / "references" / token).exists():
                    continue
                fail(path.relative_to(ROOT), f"references '{token}', which does not ship in this skill's payload")
    for rel in [".codex-plugin/plugin.json", ".cursor-plugin/plugin.json"]:
        path = ROOT / rel
        if not path.exists():
            continue
        try:
            shipped = set(json.loads(read(path)).get("skills", []))
        except json.JSONDecodeError:
            continue  # check_manifests reports the parse failure
        missing = {f"skills/{s}" for s in SKILLS} - shipped
        if missing:
            fail(rel, f"manifest does not ship: {sorted(missing)}")


def check_install_block() -> None:
    """The README paste block's install command is EXTRACTED from step0's canonical pinned
    block, never forked. Canonical = the clean npm form; the private-registry wiring lives
    only in the README's one-time box (deleted at public release), never in step0."""
    step0 = read(ROOT / "shared" / "step0.md")
    readme = read(ROOT / "README.md")
    cmds = [m for m in re.findall(r"`([^`\n]+)`", step0) if m.startswith("npm i -g ")]
    if len(cmds) != 1:
        fail("shared/step0.md", f"expected exactly one pinned npm install command, found {len(cmds)}")
    for cmd in cmds:
        if cmd not in readme:
            fail("README.md", f"install command diverges from step0's canonical block: '{cmd}'")
    if "npm.pkg.github.com" in step0:
        fail("shared/step0.md", "registry wiring belongs in the README's one-time box, not the canonical block")


def check_routing_home() -> None:
    """moda-help mirrors the routing table at runtime — it must name every skill, so a new
    skill cannot ship without its routing-home row (pairs with docs/routing-table.md's
    update-both rule)."""
    text = read(ROOT / "skills" / "moda-help" / "SKILL.md")
    for skill in SKILLS:
        if skill not in text:
            fail("skills/moda-help/SKILL.md", f"routing home does not mention {skill}")


def check_manifests() -> None:
    names = set()
    for rel in [".claude-plugin/marketplace.json", ".claude-plugin/plugin.json",
                ".codex-plugin/plugin.json", ".cursor-plugin/plugin.json", "compatibility.json"]:
        path = ROOT / rel
        if not path.exists():
            fail(rel, "missing manifest")
            continue
        try:
            data = json.loads(read(path))
        except json.JSONDecodeError as err:
            fail(rel, f"invalid JSON: {err}")
            continue
        if "name" in data:
            names.add(data["name"])
    if names - {"moda"}:
        fail(".claude-plugin", f"manifest plugin names disagree: {sorted(names)}")


def main() -> int:
    check_frontmatter()
    check_shared_blocks()
    check_fanout()
    check_links()
    check_banned()
    check_verb_parity()
    check_markup_elements()
    check_budgets()
    check_payload_paths()
    check_install_block()
    check_routing_home()
    check_manifests()
    if findings:
        print(f"FAIL — {len(findings)} finding(s):")
        for f in findings:
            print(f"  - {f}")
        return 1
    print("validate-skills: all checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
