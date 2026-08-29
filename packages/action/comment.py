"""Render a diff impact JSON report as a compact sticky PR comment."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

from packages.visualize import to_mermaid


MARKER = "<!-- architecture-mapper -->"


def render_comment(report: dict[str, Any]) -> str:
    counts = report.get("counts") or {}
    risk = report.get("risk") or []
    changed = report.get("changed_symbols") or {}
    lines = [MARKER, "## Architecture Mapper", ""]
    if risk:
        lines.extend([f"**Risk:** {', '.join(f'`{item}`' for item in risk)}", ""])
    lines.append("### Impact counts")
    lines.append(" | ".join(f"`{key}`: {value}" for key, value in sorted(counts.items())) or "No downstream nodes found.")
    lines.append("")
    lines.append("### Changed symbols")
    changes = []
    for category in ("added", "removed", "signature_changed", "body_only"):
        for item in changed.get(category, []):
            changes.append(f"- `{category}`: `{item.get('id')}`")
    lines.extend(changes or ["No symbol-level changes identified."])
    if report.get("contract_deltas"):
        lines.extend(["", "### Contract/schema/infra deltas"])
        lines.extend(f"- `{item['kind']}`: `{item['path']}`" for item in report["contract_deltas"])
    tests = report.get("tests_to_run") or []
    lines.extend(["", "### Tests to run"])
    lines.extend(f"- `{item.get('name') or item.get('id')}`" for item in tests) if tests else lines.append("No impacted tests were identified.")
    paths = report.get("paths") or []
    if paths:
        lines.extend(["", "### Why path", "```mermaid", to_mermaid({"nodes": report.get("nodes", []), "edges": paths[0].get("edges", [])}), "```"])
    if report.get("unresolved_symbols"):
        lines.extend(["", "Unresolved changed symbols: " + ", ".join(f"`{item}`" for item in report["unresolved_symbols"])])
    return "\n".join(lines) + "\n"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="architecture-mapper-comment")
    parser.add_argument("report", nargs="?", help="diff impact JSON path; stdin when omitted")
    args = parser.parse_args(argv)
    text = Path(args.report).read_text(encoding="utf-8") if args.report else sys.stdin.read()
    print(render_comment(json.loads(text)), end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
