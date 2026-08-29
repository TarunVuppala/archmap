"""Incremental workspace indexing for the graph daemon and CLI."""

from __future__ import annotations

import hashlib
import json
import re
from fnmatch import fnmatch
from pathlib import Path
from typing import Iterable

from packages.graph import GraphStore
from packages.parse import parse_file
from packages.seed import apply_seed
from packages.seed.health import health_report


INDEXABLE_SUFFIXES = {
    ".cjs",
    ".graphql",
    ".hcl",
    ".js",
    ".jsx",
    ".json",
    ".lock",
    ".mjs",
    ".md",
    ".prisma",
    ".proto",
    ".py",
    ".pyw",
    ".sql",
    ".tf",
    ".toml",
    ".ts",
    ".tsx",
    ".yaml",
    ".yml",
}
INDEXABLE_NAMES = {".mcp.json", "Dockerfile", "docker-compose.yml", "docker-compose.yaml"}
IGNORED_PARTS = {".archmap", ".git", ".venv", "build", "dist", "generated", "node_modules", "vendor"}
MARKER_NAMES = {
    "asyncapi",
    "compose",
    "docker-compose",
    "helm",
    "lock",
    "openapi",
    "proto",
    "terraform",
}


def sync_workspace(workspace: str | Path, database: str | Path | None = None, force: bool = False) -> dict:
    """Synchronize parseable workspace files and return the CLI JSON envelope."""

    root = Path(workspace).resolve()
    if not root.is_dir():
        raise ValueError(f"workspace is not a directory: {workspace}")
    db_path = _database_path(root, database)
    ignore_patterns = _seed_ignore_patterns(root)
    paths = _discover_files(root, ignore_patterns)
    fingerprint = _fingerprint(root, paths)
    changed_files: list[str] = []
    skipped_files: list[str] = []
    deleted_files: list[str] = []
    diagnostics: list[str] = []

    with GraphStore(db_path, root) as store:
        existing = {node["path"]: node for node in store.list_file_nodes() if node.get("path")}
        seen: set[str] = set()
        for path in paths:
            relative = path.relative_to(root).as_posix()
            seen.add(relative)
            digest = _sha256(path)
            old_digest = (existing.get(relative, {}).get("extra") or {}).get("sha256")
            if not force and old_digest == digest:
                skipped_files.append(relative)
                continue
            try:
                parsed = parse_file(path, root)
            except (OSError, UnicodeError, ValueError) as error:
                diagnostics.append(f"{relative}: {error}")
                continue
            store.remove_file(relative)
            for node in parsed.nodes:
                if node["id"] == f"file:{relative}":
                    node = {
                        **node,
                        "extra": {
                            **(node.get("extra") or {}),
                            "sha256": digest,
                            "parser_mode": parsed.mode,
                        },
                    }
                store.upsert_node(node)
            for edge in parsed.edges:
                store.upsert_edge(edge)
            changed_files.append(relative)
            diagnostics.extend(f"{relative}: {item}" for item in parsed.diagnostics)

        for relative in sorted(set(existing) - seen):
            store.remove_file(relative)
            deleted_files.append(relative)

        seed_result = apply_seed(store, root)
        previous = store.get_health("workspace_fingerprint")
        fingerprint_changed = not isinstance(previous, dict) or previous.get("value") != fingerprint
        store.set_health("workspace_fingerprint", {"value": fingerprint, "changed": fingerprint_changed})
        health = health_report(store)
        payload = {
            "workspace": str(root),
            "fingerprint": fingerprint,
            "fingerprint_changed": fingerprint_changed,
            "changed_files": changed_files,
            "skipped_files": skipped_files,
            "deleted_files": deleted_files,
            "diagnostics": diagnostics,
            "seed": seed_result,
            "health": health,
        }
        store.append_journal("sync", {
            "workspace": str(root),
            "fingerprint": fingerprint,
            "fingerprint_changed": fingerprint_changed,
            "changed_files": changed_files,
            "deleted_files": deleted_files,
            "diagnostic_count": len(diagnostics),
        })
        payload.update(
            {
                "ok": not diagnostics,
                "counts": {
                    "changed_files": len(changed_files),
                    "skipped_files": len(skipped_files),
                    "deleted_files": len(deleted_files),
                },
            }
        )
        return payload


def _database_path(root: Path, database: str | Path | None) -> Path:
    if database is None:
        return root / ".archmap" / "index.db"
    candidate = Path(database)
    return candidate if candidate.is_absolute() else root / candidate


def _discover_files(root: Path, ignore_patterns: Iterable[str]) -> list[Path]:
    paths: list[Path] = []
    for path in root.rglob("*"):
        if not path.is_file():
            continue
        relative = path.relative_to(root).as_posix()
        if any(part in IGNORED_PARTS for part in path.relative_to(root).parts):
            continue
        if any(fnmatch(relative, pattern) or relative.startswith(pattern.rstrip("/") + "/") for pattern in ignore_patterns):
            continue
        if path.name in INDEXABLE_NAMES or path.suffix.lower() in INDEXABLE_SUFFIXES:
            if not any(part.startswith(".") and part not in {".github", ".vscode"} for part in path.relative_to(root).parts[:-1]):
                paths.append(path)
    return sorted(paths, key=lambda item: item.relative_to(root).as_posix())


def _seed_ignore_patterns(root: Path) -> list[str]:
    seed = root / ".archmap" / "seed.yaml"
    if not seed.is_file():
        return []
    text = seed.read_text(encoding="utf-8")
    match = re.search(r"^\s*ignore_paths\s*:\s*\[(.*?)\]", text, re.MULTILINE)
    if not match:
        return []
    return [item.strip().strip("'\"") for item in match.group(1).split(",") if item.strip()]


def _fingerprint(root: Path, paths: Iterable[Path]) -> str:
    relative_paths = [path.relative_to(root).as_posix() for path in paths]
    folders = sorted({str(Path(path).parent.as_posix()) for path in relative_paths})
    markers = sorted(
        path
        for path in relative_paths
        if any(marker in Path(path).name.lower() for marker in MARKER_NAMES)
    )
    remotes = _git_remotes(root)
    seed = root / ".archmap" / "seed.yaml"
    fingerprint_input = {
        "folders": folders,
        "git_remotes": remotes,
        "markers": markers,
        "seed": seed.read_text(encoding="utf-8") if seed.is_file() else None,
    }
    return hashlib.sha256(json.dumps(fingerprint_input, sort_keys=True).encode()).hexdigest()


def _git_remotes(root: Path) -> list[str]:
    config = root / ".git" / "config"
    if not config.is_file():
        return []
    return sorted(re.findall(r"^\s*url\s*=\s*(\S+)\s*$", config.read_text(encoding="utf-8"), re.MULTILINE))


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()
