#!/usr/bin/env python3
"""Project the CLI-flavored skills into the MCP-flavored claude.ai Agent Skills.

The nine skills under skills/ are authored against the moda CLI. The Moda
connector (MCP) exposes the same capabilities as tools, so claude.ai users can
run the same skills — uploaded via Customize > Skills — once every CLI verb
invocation is re-spoken as the corresponding connector tool call and every
filesystem step is replaced by link handoffs. This script is that projection,
maintained AS CODE (scripts/mcp_projection_rules.py), never by hand-editing
the output:

  build   regenerate dist/mcp-skills/** from skills-src + the rules
          (skill payloads, index.json, and verb-dispositions.json — the
          machine-readable VERB_DISPOSITION export for server-side consumers)
  check   regenerate in memory and fail on any drift from the committed
          output, dead rules, unmapped verbs, or banned-surface leaks
  zips    package dist/mcp-skills/<skill>/ into dist/<skill>.skill.zip
          (one skill folder per ZIP — the claude.ai upload format)
  table   print the CLI-verb → connector-tool mapping table (PR bodies)
  audit-server --studio-root PATH
          strict roster reconciliation against a nullframe-studio checkout's
          connector manifest (pending-server names included) — run when the
          connector surface-parity wave lands

Transform rules (see mcp_projection_rules.py):
  - PASSAGE rules: exact-match replacements with an expected occurrence
    count. Upstream edits to a covered passage make the rule miss → the
    build FAILS LOUDLY and someone re-decides the projection consciously.
  - GENERIC rules: bare-verb string swaps (e.g. `moda canvas read` →
    `canvas_read`) applied after passages; every entry must fire at least
    once (dead-rule audit).
  - Any surviving `moda <verb>`, CLI flag, exit-code language, or unknown
    tool name in the output fails the build. Nothing is dropped silently.
"""

from __future__ import annotations

import io
import json
import re
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

import mcp_projection_rules as rules  # noqa: E402

OUT_DIR = ROOT / "dist" / "mcp-skills"
ROSTER_PATH = ROOT / "mcp" / "connector-tools.json"

errors: list[str] = []


def fail(where: str, msg: str) -> None:
    errors.append(f"{where}: {msg}")


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


# ---------------------------------------------------------------- passages


def apply_passages(name: str, text: str, passages: list[tuple[str, str] | tuple[str, str, int]]) -> str:
    for entry in passages:
        old, new, count = (*entry, 1) if len(entry) == 2 else entry
        found = text.count(old)
        if found != count:
            fail(name, f"passage rule expected {count} occurrence(s), found {found}: {old[:90]!r}")
            continue
        text = text.replace(old, new)
    return text


def apply_generics(text: str, fired: set[str]) -> str:
    for old, new in rules.GENERIC:
        if old in text:
            fired.add(old)
            text = text.replace(old, new)
    return text


RESIDUAL_VERB = re.compile(
    r"\bmoda\s+(?:canvas|brand|media|task|site|web|file|drive|template|export|account|auth|org|doctor"
    r"|describe|last-error|docs|update|version|completion|context|ask)\b"
)


def scan_output(name: str, text: str, roster: set[str]) -> None:
    for i, line in enumerate(text.splitlines(), 1):
        m = RESIDUAL_VERB.search(line)
        if m:
            fail(name, f"line {i}: unprojected CLI invocation {m.group(0)!r} — add a rule (never drop silently)")
        for pattern, label in rules.OUTPUT_BANS:
            if pattern.search(line):
                fail(name, f"line {i}: banned on this surface ({label}): {line.strip()[:100]!r}")
        for tool in sorted(set(re.findall(r"\b(?:moda|canvas|media|brand|task|file|drive|template|website)_[a-z_]+\b", line))):
            if tool not in roster and tool not in rules.NON_TOOL_TOKENS:
                fail(name, f"line {i}: unknown connector tool {tool!r} (not in mcp/connector-tools.json)")
    # Second pass over the raw text: RESIDUAL_VERB's \s+ crosses newlines, so
    # an invocation wrapped across a line break can't slip past the line scan.
    for m in RESIDUAL_VERB.finditer(text):
        if "\n" in m.group(0):
            fail(name, f"unprojected CLI invocation wrapped across lines: {m.group(0)!r}")


# ---------------------------------------------------------------- frontmatter


def project_frontmatter(skill: str, text: str) -> tuple[str, str, str]:
    """Return (frontmatter_block, description, body). Drops CLI-only keys."""
    if not text.startswith("---\n"):
        fail(skill, "missing frontmatter")
        return "", "", text
    end = text.find("\n---\n", 4)
    if end == -1:
        fail(skill, "unterminated frontmatter")
        return "", "", text
    block, body = text[4:end], text[end + 5 :]
    fields: dict[str, str] = {}
    key = None
    for line in block.splitlines():
        m = re.match(r"^([a-z-]+):\s*(.*)$", line)
        if m:
            key = m.group(1)
            fields[key] = m.group(2).strip()
        elif key and line.startswith((" ", "\t")):
            fields[key] = (fields[key] + " " + line.strip()).strip()
    desc = fields.get("description", "").removeprefix(">-").removeprefix(">").strip()
    desc = apply_passages(f"{skill} (description)", desc, rules.DESCRIPTION_RULES.get(skill, []))
    if len(desc) > 1024:
        fail(skill, f"projected description too long ({len(desc)} chars > 1024)")
    wrapped: list[str] = []
    line = " "
    for word in desc.split():
        if len(line) + 1 + len(word) > 78:
            wrapped.append(line)
            line = "  " + word
        else:
            line = f"{line} {word}"
    wrapped.append(line)
    fm = "---\nname: " + fields.get("name", skill) + "\ndescription: >-\n" + "\n".join(wrapped) + "\n---\n"
    return fm, desc, body


# ---------------------------------------------------------------- build


def build_outputs() -> dict[str, str]:
    """Path (relative to dist/mcp-skills) → content. Fails via `errors`."""
    fired: set[str] = set()
    roster_doc = json.loads(read(ROSTER_PATH))
    roster = set(roster_doc["live"]) | set(roster_doc["pending_server"])

    step0_cli = read(ROOT / "shared" / "step0.md").strip()
    ux_cli = read(ROOT / "shared" / "ux-rules.md").strip()
    step0_mcp = read(ROOT / "mcp" / "step0.md").strip()
    ux_mcp = apply_generics(apply_passages("shared/ux-rules.md", ux_cli, rules.PASSAGES["shared/ux-rules.md"]), fired)

    outputs: dict[str, str] = {}

    # Shared references, projected once, fanned per skill below.
    projected_refs: dict[str, str] = {}
    for ref, passages in rules.REFERENCE_PASSAGES.items():
        src = read(ROOT / "shared" / "references" / f"{ref}.md")
        text = apply_generics(apply_passages(f"shared/references/{ref}.md", src, passages), fired)
        projected_refs[ref] = text

    for skill in rules.SKILLS:
        override = ROOT / "mcp" / "overrides" / f"{skill}.SKILL.md"
        if override.exists():
            text = read(override)
            for marker, replacement in [("<!--MCP:STEP0-->", step0_mcp), ("<!--MCP:UX-RULES-->", ux_mcp)]:
                if text.count(marker) != 1:
                    fail(str(override), f"expected exactly one {marker} marker, found {text.count(marker)}")
                text = text.replace(marker, replacement)
            if "<!--" in text:
                fail(str(override), "unresolved MCP marker")
            fm, _, body = project_frontmatter(skill, text)
        else:
            src = read(ROOT / "skills" / skill / "SKILL.md")
            if src.count(step0_cli) != 1 or src.count(ux_cli) != 1:
                fail(f"skills/{skill}/SKILL.md", "shared Step-0/UX block not embedded byte-identically exactly once — run validate.py first")
                continue
            src = src.replace(step0_cli, step0_mcp).replace(ux_cli, ux_mcp)
            fm, _, body = project_frontmatter(skill, src)
            body = apply_generics(apply_passages(f"skills/{skill}/SKILL.md", body, rules.PASSAGES.get(f"skills/{skill}/SKILL.md", [])), fired)
        outputs[f"{skill}/SKILL.md"] = fm + body
        for ref in rules.MCP_REFERENCES[skill]:
            if ref not in projected_refs:
                fail(skill, f"reference {ref!r} has no projection (add it to REFERENCE_PASSAGES or drop it from MCP_REFERENCES)")
                continue
            outputs[f"{skill}/references/{ref}.md"] = projected_refs[ref]

    # Post-transform validation.
    for name, text in sorted(outputs.items()):
        scan_output(f"dist/mcp-skills/{name}", text, roster)
        if name.endswith("SKILL.md"):
            skill = name.split("/")[0]
            for ref in sorted(set(re.findall(r"references/([a-z-]+)\.md", text))):
                if f"{skill}/references/{ref}.md" not in outputs:
                    fail(f"dist/mcp-skills/{name}", f"mentions references/{ref}.md which does not ship in this skill's payload")
    for skill in rules.SKILLS:
        for ref in rules.MCP_REFERENCES[skill]:
            text = outputs.get(f"{skill}/references/{ref}.md", "")
            for mention in sorted(set(re.findall(r"references/([a-z-]+)\.md", text))):
                if f"{skill}/references/{mention}.md" not in outputs:
                    fail(
                        f"dist/mcp-skills/{skill}/references/{ref}.md",
                        f"mentions references/{mention}.md which does not ship in {skill}'s payload",
                    )

    dead = [old for old, _ in rules.GENERIC if old not in fired]
    for d in dead:
        fail("mcp_projection_rules.GENERIC", f"dead rule (never fired): {d!r}")

    # Source-coverage audit: every CLI invocation in skills-src is consumed.
    audit_source_coverage()

    index = {
        "comment": "Machine-readable manifest of the connector-flavored skills projection — stable per-skill paths for server-side consumption (e.g. registering these skills into the studio connector's load_skill registry). Regenerate with scripts/project-mcp.py build.",
        "format": "claude-agent-skill",
        "skills": [
            {
                "name": skill,
                "description": _description_of(outputs[f"{skill}/SKILL.md"]),
                "files": [f"{skill}/SKILL.md"] + [f"{skill}/references/{r}.md" for r in rules.MCP_REFERENCES[skill]],
            }
            for skill in rules.SKILLS
        ],
    }
    outputs["index.json"] = json.dumps(index, indent=2, ensure_ascii=False) + "\n"
    scan_output("dist/mcp-skills/index.json", outputs["index.json"], roster)

    # The bilingual dictionary export (stable schema v1 — documented in the
    # mcp_projection_rules.py module docstring): VERB_DISPOSITION, verbatim, for
    # server-side consumers (the studio advisory `ask` service). Deliberately NOT
    # run through scan_output — CLI verbs are this file's keys by design; it
    # exists to translate them.
    for verb, (_, status) in sorted(rules.VERB_DISPOSITION.items()):
        if status not in rules.DISPOSITION_STATUSES:
            fail("mcp_projection_rules.VERB_DISPOSITION", f"unknown status {status!r} on {verb!r} — add it to DISPOSITION_STATUSES")
    dispositions = {
        "comment": "Bilingual CLI↔connector verb dictionary: every `moda <verb>` used in skills-src, mapped to its connector equivalent or authored prose remedy (backticks mark code tokens). Verbatim export of VERB_DISPOSITION in scripts/mcp_projection_rules.py — schema documented there; stable within schema_version 1. Regenerate with scripts/project-mcp.py build.",
        "schema_version": 1,
        "statuses": rules.DISPOSITION_STATUSES,
        "dispositions": {
            verb: {"target": target, "status": status}
            for verb, (target, status) in sorted(rules.VERB_DISPOSITION.items())
        },
    }
    outputs["verb-dispositions.json"] = json.dumps(dispositions, indent=2, ensure_ascii=False) + "\n"
    return outputs


def _description_of(skill_md: str) -> str:
    end = skill_md.find("\n---\n", 4)
    block = skill_md[4:end]
    desc_lines: list[str] = []
    in_desc = False
    for line in block.splitlines():
        if line.startswith("description:"):
            in_desc = True
            continue
        if in_desc and line.startswith((" ", "\t")):
            desc_lines.append(line.strip())
        elif in_desc:
            break
    return " ".join(desc_lines)


def audit_source_coverage() -> None:
    """Every `moda <verb>` in skills-src must be mapped or explicitly exempted."""
    known = set(rules.VERB_DISPOSITION)
    seen: set[str] = set()
    for pattern in ["skills/*/SKILL.md", "shared/*.md", "shared/references/*.md"]:
        for path in sorted(ROOT.glob(pattern)):
            for m in re.finditer(r"\bmoda\s+([a-z][a-z-]*)(?:\s+([a-z][a-z-]*))?", read(path)):
                two = f"moda {m.group(1)}" + (f" {m.group(2)}" if m.group(2) else "")
                one = f"moda {m.group(1)}"
                inv = two if two in known else one
                if inv not in known:
                    fail(str(path.relative_to(ROOT)), f"CLI invocation {two!r} has no disposition in mcp_projection_rules.VERB_DISPOSITION")
                else:
                    seen.add(inv)
    for verb in sorted(known - seen):
        fail("mcp_projection_rules.VERB_DISPOSITION", f"dead disposition (verb no longer appears in skills-src): {verb!r}")


# ---------------------------------------------------------------- commands


def cmd_build() -> int:
    outputs = build_outputs()
    if errors:
        return report()
    if OUT_DIR.exists():
        for path in sorted(OUT_DIR.rglob("*"), reverse=True):
            path.unlink() if path.is_file() else path.rmdir()
    for name, text in outputs.items():
        dest = OUT_DIR / name
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_text(text, encoding="utf-8")
    print(f"project-mcp: wrote {len(outputs)} files to dist/mcp-skills/")
    return 0


def cmd_check() -> int:
    outputs = build_outputs()
    committed = {str(p.relative_to(OUT_DIR)): read(p) for p in sorted(OUT_DIR.rglob("*")) if p.is_file()} if OUT_DIR.exists() else {}
    for name in sorted(set(outputs) | set(committed)):
        if name not in committed:
            fail(f"dist/mcp-skills/{name}", "missing from the committed projection — run: python3 scripts/project-mcp.py build")
        elif name not in outputs:
            fail(f"dist/mcp-skills/{name}", "stale committed file no longer produced — run: python3 scripts/project-mcp.py build")
        elif outputs[name] != committed[name]:
            fail(f"dist/mcp-skills/{name}", "drifted from the regenerated projection — run: python3 scripts/project-mcp.py build")
    roster_warnings()
    if errors:
        return report()
    print("project-mcp check: projection in sync, all rules live, no surface leaks")
    return 0


def roster_warnings() -> None:
    """Soft cross-check against a local studio checkout (validate.py's MODA_CLI_ROOT pattern)."""
    import os

    studio = Path(os.environ.get("MODA_STUDIO_ROOT", str(ROOT.parent / "studio")))
    manifest = studio / "backend" / "moda_connector" / "tools" / "__init__.py"
    if not manifest.exists():
        print(f"note: no studio checkout at {studio} — skipping connector-roster cross-check")
        return
    names = set(re.findall(r'name="([a-z_]+)"', read(manifest)))
    doc = json.loads(read(ROSTER_PATH))
    # Warnings only: the local checkout can be on any branch, so a mismatch
    # here must not redden `check` (CI has no studio checkout at all). The
    # hard gate is `audit-server`, run against the intended manifest.
    for tool in doc["live"]:
        if tool not in names:
            print(f"warning: live tool {tool!r} missing from the local studio manifest — verify against studio origin/main (audit-server is the hard gate)")
    for tool in doc["pending_server"]:
        if tool not in names:
            print(f"warning: pending-server tool {tool!r} not in the studio manifest yet (run audit-server when the parity wave lands)")


def cmd_audit_server(studio_root: str | None) -> int:
    import os

    if studio_root:
        os.environ["MODA_STUDIO_ROOT"] = studio_root
    studio = Path(os.environ.get("MODA_STUDIO_ROOT", str(ROOT.parent / "studio")))
    manifest = studio / "backend" / "moda_connector" / "tools" / "__init__.py"
    if not manifest.exists():
        fail("audit-server", f"no connector manifest at {manifest}")
        return report()
    names = set(re.findall(r'name="([a-z_]+)"', read(manifest)))
    doc = json.loads(read(ROSTER_PATH))
    for bucket in ("live", "pending_server"):
        for tool in doc[bucket]:
            if tool not in names:
                fail(
                    "mcp/connector-tools.json",
                    f"{bucket} tool {tool!r} not in the studio manifest — the server landed a different name; "
                    "reconcile the roster, mcp_projection_rules.py, and the projected text in one commit",
                )
    if errors:
        return report()
    print(f"audit-server: all {len(doc['live']) + len(doc['pending_server'])} roster names exist in {manifest}")
    return 0


def cmd_zips(out_dir: Path) -> int:
    if not OUT_DIR.exists():
        fail("zips", "dist/mcp-skills missing — run build first")
        return report()
    out_dir.mkdir(parents=True, exist_ok=True)
    built = []
    for skill in rules.SKILLS:
        skill_dir = OUT_DIR / skill
        files = sorted(p for p in skill_dir.rglob("*") if p.is_file())
        if not (skill_dir / "SKILL.md").exists():
            fail("zips", f"{skill}: no SKILL.md in the committed projection")
            continue
        dest = out_dir / f"{skill}.skill.zip"
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
            for path in files:
                # Deterministic timestamps so re-releases of identical content hash identically.
                info = zipfile.ZipInfo(f"{skill}/{path.relative_to(skill_dir)}", date_time=(2026, 1, 1, 0, 0, 0))
                info.external_attr = 0o644 << 16
                info.compress_type = zipfile.ZIP_DEFLATED
                zf.writestr(info, read(path))
        dest.write_bytes(buf.getvalue())
        built.append(dest.name)
    if errors:
        return report()
    print(f"project-mcp zips: {', '.join(built)} → {out_dir}")
    return 0


def cmd_table() -> int:
    print("| CLI verb | Connector projection | Status |")
    print("|---|---|---|")
    for verb, (target, status) in sorted(rules.VERB_DISPOSITION.items()):
        print(f"| `{verb}` | {target} | {status} |")
    return 0


def report() -> int:
    print(f"project-mcp FAIL — {len(errors)} finding(s):")
    for e in errors:
        print(f"  - {e}")
    return 1


def _flag_value(args: list[str], flag: str) -> str | None:
    """Value of `flag` in args; unknown flags and a missing value fail loudly."""
    value = None
    rest = args[1:]
    while rest:
        token = rest.pop(0)
        if token == flag:
            if not rest:
                print(f"project-mcp: {flag} requires a value")
                raise SystemExit(2)
            value = rest.pop(0)
        else:
            print(f"project-mcp: unknown argument {token!r} for {args[0]}")
            raise SystemExit(2)
    return value


def main() -> int:
    args = sys.argv[1:]
    cmd = args[0] if args else "check"
    if cmd in ("build", "check", "table") and len(args) > 1:
        print(f"project-mcp: {cmd} takes no arguments")
        return 2
    if cmd == "build":
        return cmd_build()
    if cmd == "check":
        return cmd_check()
    if cmd == "zips":
        out = _flag_value(args, "--out")
        return cmd_zips(Path(out) if out else ROOT / "dist")
    if cmd == "table":
        return cmd_table()
    if cmd == "audit-server":
        return cmd_audit_server(_flag_value(args, "--studio-root"))
    print(__doc__)
    return 2


if __name__ == "__main__":
    sys.exit(main())
