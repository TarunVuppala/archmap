"""Deterministic symbol diffs and graph impact reports."""

from __future__ import annotations

import re
import subprocess
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

from packages.graph import GraphStore
from packages.parse import ParseResult, parse_source


@dataclass
class FileDiff:
    old_path: str | None
    new_path: str | None
    old_lines: set[int] = field(default_factory=set)
    new_lines: set[int] = field(default_factory=set)

    @property
    def path(self) -> str:
        return self.new_path or self.old_path or ""


def parse_unified_diff(text: str) -> list[FileDiff]:
    """Parse changed line numbers from a zero- or regular-context unified diff."""

    files: list[FileDiff] = []
    current: FileDiff | None = None
    old_line = new_line = 0
    hunk_re = re.compile(r"^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@")
    for line in text.splitlines():
        if line.startswith("diff --git "):
            current = None
            continue
        if line.startswith("--- "):
            old_path = _diff_path(line[4:])
            current = FileDiff(old_path=old_path, new_path=None)
            files.append(current)
            continue
        if line.startswith("+++ "):
            if current is None:
                continue
            current.new_path = _diff_path(line[4:])
            continue
        match = hunk_re.match(line)
        if match:
            old_line = int(match.group(1))
            new_line = int(match.group(3))
            continue
        if current is None or not (old_line or new_line):
            continue
        if line.startswith("+") and not line.startswith("+++"):
            current.new_lines.add(new_line)
            new_line += 1
        elif line.startswith("-") and not line.startswith("---"):
            current.old_lines.add(old_line)
            old_line += 1
        elif line.startswith(" "):
            old_line += 1
            new_line += 1
    return _merge_file_diffs(files)


def diff_impact(
    store: GraphStore,
    workspace: str | Path,
    diff_text: str,
    base: str = "main",
    head: str = "HEAD",
    source_loader: Callable[[str | None, str], str] | None = None,
) -> dict:
    """Classify changed symbols and compute their union blast radius."""

    root = Path(workspace).resolve()
    loader = source_loader or _git_source_loader(root)
    categories = {"added": [], "removed": [], "signature_changed": [], "body_only": []}
    changed_ids: list[str] = []
    files: list[str] = []
    contract_deltas: list[dict[str, str]] = []

    for file_diff in parse_unified_diff(diff_text):
        if not file_diff.path:
            continue
        files.append(file_diff.path)
        delta_kind = _delta_kind(file_diff.path)
        if delta_kind:
            contract_deltas.append({"path": file_diff.path, "kind": delta_kind})
        old_text = loader(base, file_diff.old_path) if file_diff.old_path else ""
        new_text = loader(head, file_diff.new_path) if file_diff.new_path else ""
        old_result = parse_source(file_diff.old_path or file_diff.path, old_text)
        new_result = parse_source(file_diff.new_path or file_diff.path, new_text)
        old_symbols = _symbols(old_result)
        new_symbols = _symbols(new_result)
        old_touched = _touched(old_symbols, file_diff.old_lines)
        new_touched = _touched(new_symbols, file_diff.new_lines)
        if not old_touched and not new_touched:
            old_touched = {f"mod:{file_diff.old_path or file_diff.path}"} if file_diff.old_path else set()
            new_touched = {f"mod:{file_diff.new_path or file_diff.path}"} if file_diff.new_path else set()

        for symbol_id in sorted(old_touched | new_touched):
            old_symbol = old_symbols.get(symbol_id)
            new_symbol = new_symbols.get(symbol_id)
            if old_symbol is None and new_symbol is not None:
                category = "added"
                changed_ids.append(symbol_id)
                detail = _symbol_detail(new_symbol, file_diff.new_path or file_diff.path, category)
            elif new_symbol is None and old_symbol is not None:
                category = "removed"
                detail = _symbol_detail(old_symbol, file_diff.old_path or file_diff.path, category)
            elif old_symbol is not None and new_symbol is not None:
                old_signature = _source_signature(old_text, old_symbol)
                new_signature = _source_signature(new_text, new_symbol)
                category = "signature_changed" if old_signature != new_signature else "body_only"
                changed_ids.append(symbol_id)
                detail = _symbol_detail(new_symbol, file_diff.new_path or file_diff.path, category)
                detail["old_signature"] = old_signature
                detail["new_signature"] = new_signature
            else:
                continue
            categories[category].append(detail)

    changed_ids = list(dict.fromkeys(changed_ids))
    existing_changed_ids = [node_id for node_id in changed_ids if store.get_node(node_id)]
    if existing_changed_ids:
        report = store.impact(existing_changed_ids, direction="downstream", depth=5, max_paths=7)
    else:
        report = {
            "ok": True,
            "nodes": [],
            "edges": [],
            "paths": [],
            "counts": {},
            "risk": [],
            "tests_to_run": [],
            "docs": [],
            "suggested_reviewers": [],
            "evidence_used": True,
        }
    report.update(
        {
            "diff": {"base": base, "head": head, "files": sorted(set(files))},
            "changed_symbols": categories,
            "changed_symbol_ids": changed_ids,
            "unresolved_symbols": [node_id for node_id in changed_ids if node_id not in existing_changed_ids],
            "contract_deltas": contract_deltas,
        }
    )
    return report


def _symbols(result: ParseResult) -> dict[str, dict]:
    return {
        node["id"]: node
        for node in result.nodes
        if node["kind"] not in {"File", "External", "API", "Route", "Table", "Column", "Doc"}
    }


def _touched(symbols: dict[str, dict], lines: set[int]) -> set[str]:
    return {
        symbol_id
        for symbol_id, symbol in symbols.items()
        if symbol.get("start_line") is not None
        and any(symbol["start_line"] <= line <= (symbol.get("end_line") or symbol["start_line"]) for line in lines)
    }


def _source_signature(text: str, symbol: dict) -> str:
    lines = text.splitlines()
    start = symbol.get("start_line")
    if not start or start > len(lines):
        return ""
    return lines[start - 1].strip()


def _symbol_detail(symbol: dict, path: str, category: str) -> dict:
    return {
        "id": symbol["id"],
        "kind": symbol["kind"],
        "name": symbol["name"],
        "path": path,
        "start_line": symbol.get("start_line"),
        "end_line": symbol.get("end_line"),
        "change": category,
    }


def _delta_kind(path: str) -> str | None:
    lower = path.lower()
    name = Path(path).name.lower()
    if any(token in name for token in ("openapi", "asyncapi")) or lower.endswith((".proto", ".graphql")):
        return "contract"
    if lower.endswith((".sql", ".prisma")) or "/migrations/" in lower:
        return "schema"
    if lower.endswith((".tf", ".hcl")) or any(token in name for token in ("compose", "helm")):
        return "infra"
    return None


def _diff_path(value: str) -> str | None:
    value = value.split("\t", 1)[0]
    if value == "/dev/null":
        return None
    return value[2:] if len(value) > 2 and value[1] == "/" and value[0] in {"a", "b"} else value


def _merge_file_diffs(files: list[FileDiff]) -> list[FileDiff]:
    merged: dict[tuple[str | None, str | None], FileDiff] = {}
    for item in files:
        key = (item.old_path, item.new_path)
        if key not in merged:
            merged[key] = item
        else:
            merged[key].old_lines.update(item.old_lines)
            merged[key].new_lines.update(item.new_lines)
    return list(merged.values())


def _git_source_loader(root: Path) -> Callable[[str | None, str], str]:
    def load(ref: str | None, path: str) -> str:
        if ref == "HEAD" and (root / path).is_file():
            return (root / path).read_text(encoding="utf-8")
        if not ref:
            return ""
        try:
            completed = subprocess.run(
                ["git", "-C", str(root), "show", f"{ref}:{path}"],
                check=True,
                capture_output=True,
                text=True,
                encoding="utf-8",
            )
        except subprocess.CalledProcessError as error:
            message = error.stderr.strip() or f"unable to read {ref}:{path}"
            raise ValueError(message) from error
        return completed.stdout

    return load


def git_diff(workspace: str | Path, base: str = "main", head: str = "HEAD") -> str:
    """Return committed base-to-head changes plus the current dirty diff."""

    root = Path(workspace).resolve()
    try:
        committed = subprocess.run(
            ["git", "-C", str(root), "diff", "--no-ext-diff", "--unified=0", f"{base}...{head}", "--"],
            check=True,
            capture_output=True,
            text=True,
            encoding="utf-8",
        ).stdout
        dirty = subprocess.run(
            ["git", "-C", str(root), "diff", "--no-ext-diff", "--unified=0", "HEAD", "--"],
            check=True,
            capture_output=True,
            text=True,
            encoding="utf-8",
        ).stdout
    except subprocess.CalledProcessError as error:
        message = error.stderr.strip() or f"unable to diff {base}...{head}"
        raise ValueError(message) from error
    return committed + ("\n" if committed and dirty else "") + dirty
