"""Resolve lockfile packages to versioned official documentation.

Network access is intentionally injectable. The default fetcher only performs
HTTPS requests to package registries or URLs selected from their metadata.
"""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Iterable
from urllib.parse import quote
from urllib.request import Request, urlopen

from packages.graph import GraphStore


Fetcher = Callable[[str], str]


@dataclass(frozen=True)
class PackageRef:
    name: str
    version: str
    manager: str
    lockfile: str
    line: int
    snippet: str


def discover_packages(workspace: str | Path) -> list[PackageRef]:
    """Discover pinned packages from supported lockfiles."""

    root = Path(workspace).resolve()
    refs: list[PackageRef] = []
    package_lock = root / "package-lock.json"
    if package_lock.is_file():
        refs.extend(_package_lock_refs(package_lock))
    for path in sorted(root.glob("pnpm-lock.y*ml")):
        refs.extend(_pnpm_refs(path))
    for path in sorted(root.glob("yarn.lock")):
        refs.extend(_yarn_refs(path))
    for path in sorted(root.glob("requirements*.txt")):
        refs.extend(_requirements_refs(path))
    poetry = root / "poetry.lock"
    if poetry.is_file():
        refs.extend(_poetry_refs(poetry))
    unique: dict[tuple[str, str, str], PackageRef] = {}
    for ref in refs:
        unique.setdefault((ref.manager, ref.name, ref.version), ref)
    return sorted(unique.values(), key=lambda ref: (ref.name.lower(), ref.version, ref.manager))


def resolve_docs(
    workspace: str | Path,
    database: str | Path | None = None,
    name: str | None = None,
    version: str | None = None,
    fetch: bool = True,
    fetcher: Fetcher | None = None,
) -> dict:
    """Resolve selected or all lockfile packages into the one graph."""

    root = Path(workspace).resolve()
    if not root.is_dir():
        raise ValueError(f"workspace is not a directory: {workspace}")
    db_path = _database_path(root, database)
    refs = [
        ref for ref in discover_packages(root)
        if (name is None or ref.name == name) and (version is None or ref.version == version)
    ]
    docs: list[dict] = []
    diagnostics: list[str] = []
    fetcher = fetcher or _fetch_url
    with GraphStore(db_path, root) as store:
        for ref in refs:
            external_id = f"ext:{ref.name}"
            store.upsert_node({
                "id": external_id,
                "kind": "External",
                "name": ref.name,
                "extra": {"manager": ref.manager, "version": ref.version},
            })
            official_url = _official_url(ref)
            cache_path = _cache_path(root, ref, official_url)
            content = ""
            status = "not_fetched"
            try:
                if cache_path.is_file():
                    content = cache_path.read_text(encoding="utf-8")
                    status = "cached"
                elif fetch:
                    content = _resolve_content(ref, fetcher)
                    cache_path.parent.mkdir(parents=True, exist_ok=True)
                    cache_path.write_text(content, encoding="utf-8")
                    status = "fetched"
                else:
                    status = "available"
            except (OSError, ValueError, UnicodeError) as error:
                diagnostics.append(f"{ref.name}@{ref.version}: {error}")
                status = "error"

            doc_id = f"doc:{official_url}"
            cache_relative = cache_path.relative_to(root).as_posix()
            store.upsert_node({
                "id": doc_id,
                "kind": "Doc",
                "name": official_url,
                "path": cache_relative,
                "extra": {
                    "url": official_url,
                    "package": ref.name,
                    "version": ref.version,
                    "manager": ref.manager,
                    "status": status,
                    "excerpt": _excerpt(content),
                },
            })
            store.upsert_edge({
                "id": _edge_id(external_id, doc_id),
                "type": "DOCUMENTS",
                "from": external_id,
                "to": doc_id,
                "evidence": {"file": ref.lockfile, "line": ref.line, "snippet": ref.snippet},
                "sources": ["lockfile"],
                "confidence": 1.0,
            })
            docs.append({
                "id": doc_id,
                "package": ref.name,
                "version": ref.version,
                "manager": ref.manager,
                "url": official_url,
                "cache_path": cache_relative,
                "status": status,
                "excerpt": _excerpt(content),
            })
        store.append_journal("docs_resolve", {
            "workspace": str(root),
            "package": name,
            "version": version,
            "resolved": len(docs),
            "diagnostic_count": len(diagnostics),
        })
    return {
        "ok": not diagnostics,
        "nodes": [{"id": item["id"], "kind": "Doc", "name": item["url"]} for item in docs],
        "edges": [],
        "paths": [],
        "counts": {"Doc": len(docs)},
        "risk": [],
        "evidence_used": True,
        "docs": docs,
        "diagnostics": diagnostics,
    }


def _package_lock_refs(path: Path) -> list[PackageRef]:
    text = path.read_text(encoding="utf-8")
    data = json.loads(text)
    refs: list[PackageRef] = []
    packages = data.get("packages", {})
    if isinstance(packages, dict):
        for package_path, metadata in packages.items():
            if not package_path or not isinstance(metadata, dict) or not metadata.get("version"):
                continue
            marker = "node_modules/"
            if marker not in package_path:
                continue
            name = package_path.rsplit(marker, 1)[-1]
            line, snippet = _find_line(text, [f'"{package_path}"', f'"version": "{metadata["version"]}"'])
            refs.append(PackageRef(name, str(metadata["version"]), "npm", path.name, line, snippet))
    if not refs and isinstance(data.get("dependencies"), dict):
        for name, metadata in data["dependencies"].items():
            if isinstance(metadata, dict) and metadata.get("version"):
                line, snippet = _find_line(text, [f'"{name}"', f'"version": "{metadata["version"]}"'])
                refs.append(PackageRef(name, str(metadata["version"]), "npm", path.name, line, snippet))
    return refs


def _pnpm_refs(path: Path) -> list[PackageRef]:
    text = path.read_text(encoding="utf-8")
    refs: list[PackageRef] = []
    pattern = re.compile(r"^\s{2,}(?:/)?(?P<name>@[^@:/\s]+/[^@:/\s]+|[^@:/\s]+)@(?P<version>\d[^\s:(]+)")
    for line_number, line in enumerate(text.splitlines(), 1):
        match = pattern.match(line)
        if match:
            refs.append(PackageRef(match.group("name"), match.group("version"), "pnpm", path.name, line_number, line.strip()))
    return refs


def _yarn_refs(path: Path) -> list[PackageRef]:
    lines = path.read_text(encoding="utf-8").splitlines()
    refs: list[PackageRef] = []
    current: tuple[str, int, str] | None = None
    for line_number, line in enumerate(lines, 1):
        selector = re.match(r'^\s*"?((?:@[^@]+/)?[^@:\s]+)@[^:]+:?"?\s*:\s*$', line)
        if selector:
            current = (selector.group(1), line_number, line.strip())
            continue
        version_match = re.match(r'^\s+version\s+["\']([^"\']+)', line)
        if current and version_match:
            refs.append(PackageRef(current[0], version_match.group(1), "yarn", path.name, current[1], current[2]))
            current = None
    return refs


def _requirements_refs(path: Path) -> list[PackageRef]:
    refs: list[PackageRef] = []
    for line_number, raw_line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        line = raw_line.strip()
        match = re.match(r"^([A-Za-z0-9_.-]+)\s*===?\s*([^\s;]+)", line)
        if match:
            refs.append(PackageRef(match.group(1), match.group(2), "pypi", path.name, line_number, line))
    return refs


def _poetry_refs(path: Path) -> list[PackageRef]:
    lines = path.read_text(encoding="utf-8").splitlines()
    refs: list[PackageRef] = []
    name: str | None = None
    line_number = 0
    snippet = ""
    for index, line in enumerate(lines, 1):
        name_match = re.match(r'^name\s*=\s*["\']([^"\']+)', line)
        version_match = re.match(r'^version\s*=\s*["\']([^"\']+)', line)
        if name_match:
            name, line_number, snippet = name_match.group(1), index, line.strip()
        elif version_match and name:
            refs.append(PackageRef(name, version_match.group(1), "pypi", path.name, line_number, snippet))
            name = None
    return refs


def _resolve_content(ref: PackageRef, fetcher: Fetcher) -> str:
    if ref.manager == "npm":
        raw = fetcher(f"https://registry.npmjs.org/{quote(ref.name, safe='@/')}/{quote(ref.version)}")
        metadata = json.loads(raw)
        readme = metadata.get("readme")
        if isinstance(readme, str) and readme.strip():
            return readme
        homepage = metadata.get("homepage") or metadata.get("repository", {}).get("url")
        return f"{ref.name}@{ref.version}\nOfficial documentation: {homepage or _official_url(ref)}\n"
    raw = fetcher(f"https://pypi.org/pypi/{quote(ref.name)}/{quote(ref.version)}/json")
    metadata = json.loads(raw)
    info = metadata.get("info", {})
    docs_url = info.get("docs_url") or info.get("home_page") or _official_url(ref)
    summary = info.get("summary") or ""
    return f"{ref.name} {ref.version}\nOfficial documentation: {docs_url}\n\n{summary}\n"


def _official_url(ref: PackageRef) -> str:
    if ref.manager == "npm":
        return f"https://www.npmjs.com/package/{quote(ref.name, safe='@/')}/v/{quote(ref.version)}"
    return f"https://pypi.org/project/{quote(ref.name)}/{quote(ref.version)}/"


def _fetch_url(url: str) -> str:
    request = Request(url, headers={"User-Agent": "architecture-mapper/0.1"})
    with urlopen(request, timeout=10) as response:  # nosec B310 - URLs are fixed official registries/metadata.
        body = response.read(2 * 1024 * 1024)
    return body.decode("utf-8", errors="replace")


def _cache_path(root: Path, ref: PackageRef, url: str) -> Path:
    key = hashlib.sha256(f"{ref.name}@{ref.version}:{url}".encode()).hexdigest()[:20]
    return root / ".archmap" / "cache" / "docs" / f"{key}.txt"


def _database_path(root: Path, database: str | Path | None) -> Path:
    if database is None:
        return root / ".archmap" / "index.db"
    candidate = Path(database)
    return candidate if candidate.is_absolute() else root / candidate


def _edge_id(from_id: str, to_id: str) -> str:
    return "e_" + hashlib.sha1(f"DOCUMENTS\0{from_id}\0{to_id}".encode()).hexdigest()[:16]


def _find_line(text: str, tokens: Iterable[str]) -> tuple[int, str]:
    for line_number, line in enumerate(text.splitlines(), 1):
        if any(token in line for token in tokens):
            return line_number, line.strip()
    return 1, text.splitlines()[0].strip() if text.splitlines() else "lockfile package"


def _excerpt(content: str, limit: int = 500) -> str:
    return " ".join(content.split())[:limit]
