"""Evidence-backed SQLite graph storage and bounded impact traversal."""

from __future__ import annotations

import json
import sqlite3
from collections import deque
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Mapping


class GraphError(ValueError):
    """Raised when a graph mutation or query violates the graph contract."""


NODE_KINDS = frozenset(
    {
        "Repo",
        "File",
        "Module",
        "Package",
        "Class",
        "Interface",
        "Function",
        "Method",
        "Service",
        "API",
        "Route",
        "Table",
        "Column",
        "Event",
        "Job",
        "Test",
        "External",
        "Infra",
        "Doc",
        "Contract",
        "ConfigKey",
    }
)

EDGE_TYPES = frozenset(
    {
        "CONTAINS",
        "IMPORTS",
        "CALLS",
        "IMPLEMENTS",
        "EXPOSES",
        "CONSUMES",
        "READS",
        "WRITES",
        "PUBLISHES",
        "SUBSCRIBES",
        "TESTS",
        "DEPENDS_ON",
        "DOCUMENTS",
        "CONSTRAINED_BY",
        "CO_CHANGED",
        "BROKE_BEFORE",
        "USES_CONFIG",
    }
)

EDGE_SOURCES = frozenset(
    {
        "parser",
        "git",
        "openapi",
        "lockfile",
        "coverage",
        "infra",
        "runtime",
        "user",
        "agent",
        "llm",
    }
)

DOWNSTREAM = {
    "CALLS": "inverse",
    "EXPOSES": "forward",
    "CONSUMES": "inverse",
    "WRITES": "inverse",
    "PUBLISHES": "forward",
    "TESTS": "inverse",
    "DEPENDS_ON": "inverse",
}

UPSTREAM = {
    "CALLS": "forward",
    "IMPORTS": "forward",
    "READS": "forward",
    "CONSUMES": "forward",
    "DEPENDS_ON": "forward",
}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"))


def _load_json(value: str) -> Any:
    return json.loads(value)


class GraphStore:
    """Owns the single SQLite graph and all canonical graph mutations."""

    def __init__(self, database: str | Path, workspace_root: str | Path | None = None):
        self.database = Path(database)
        if str(self.database) != ":memory:":
            self.database.parent.mkdir(parents=True, exist_ok=True)
        self.workspace_root = Path(workspace_root).resolve() if workspace_root else None
        self.connection = sqlite3.connect(str(self.database))
        self.connection.row_factory = sqlite3.Row
        self.connection.execute("PRAGMA foreign_keys = ON")
        schema = Path(__file__).with_name("schema.sql").read_text(encoding="utf-8")
        self.connection.executescript(schema)

    def close(self) -> None:
        self.connection.close()

    def __enter__(self) -> "GraphStore":
        return self

    def __exit__(self, *_: object) -> None:
        self.close()

    def upsert_node(self, node: Mapping[str, Any]) -> dict[str, Any]:
        node_id = str(node.get("id", "")).strip()
        kind = str(node.get("kind", "")).strip()
        name = str(node.get("name", "")).strip()
        if not node_id or not name:
            raise GraphError("node id and name are required")
        if kind not in NODE_KINDS:
            raise GraphError(f"unsupported node kind: {kind}")

        extra = node.get("extra", {})
        if not isinstance(extra, (dict, list)):
            raise GraphError("node extra must be JSON object or array")
        values = (
            node_id,
            kind,
            name,
            node.get("repo"),
            node.get("path"),
            node.get("start_line"),
            node.get("end_line"),
            node.get("signature"),
            node.get("summary"),
            _json(extra),
            int(bool(node.get("critical", False))),
            node.get("updated_at") or _now(),
        )
        self.connection.execute(
            """
            INSERT INTO nodes
              (id, kind, name, repo, path, start_line, end_line, signature,
               summary, extra, critical, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
              kind=excluded.kind,
              name=excluded.name,
              repo=excluded.repo,
              path=excluded.path,
              start_line=excluded.start_line,
              end_line=excluded.end_line,
              signature=excluded.signature,
              summary=excluded.summary,
              extra=excluded.extra,
              critical=excluded.critical,
              updated_at=excluded.updated_at
            """,
            values,
        )
        self.connection.commit()
        return self.get_node(node_id)  # type: ignore[return-value]

    def get_node(self, node_id: str) -> dict[str, Any] | None:
        row = self.connection.execute("SELECT * FROM nodes WHERE id = ?", (node_id,)).fetchone()
        return self._node_dict(row) if row else None

    def list_file_nodes(self) -> list[dict[str, Any]]:
        rows = self.connection.execute("SELECT * FROM nodes WHERE kind = 'File' ORDER BY path, id").fetchall()
        return [self._node_dict(row) for row in rows]

    def list_nodes(self, limit: int = 50) -> list[dict[str, Any]]:
        limit = max(1, min(limit, 50))
        rows = self.connection.execute(
            "SELECT * FROM nodes ORDER BY kind, id LIMIT ?", (limit,)
        ).fetchall()
        return [self._node_dict(row) for row in rows]

    def list_edges(self, limit: int = 100) -> list[dict[str, Any]]:
        limit = max(1, min(limit, 100))
        rows = self.connection.execute(
            "SELECT * FROM edges ORDER BY id LIMIT ?", (limit,)
        ).fetchall()
        return [self._edge_dict(row) for row in rows]

    def remove_file(self, relative_path: str) -> None:
        """Remove symbols and parser edges owned by one file.

        Edges with evidence from other files remain one canonical row; only the
        replaced file's evidence is removed from those shared edges.
        """

        node_rows = self.connection.execute(
            "SELECT id FROM nodes WHERE path = ?", (relative_path,)
        ).fetchall()
        owned_ids = {row["id"] for row in node_rows}
        edge_rows = self.connection.execute("SELECT * FROM edges").fetchall()
        for row in edge_rows:
            if row["from_id"] in owned_ids or row["to_id"] in owned_ids:
                self.connection.execute("DELETE FROM edges WHERE id = ?", (row["id"],))
                continue
            current = self._edge_dict(row)
            evidence = current["evidence"] if isinstance(current["evidence"], list) else [current["evidence"]]
            kept = [item for item in evidence if not self._evidence_mentions_file(item, relative_path)]
            if len(kept) == len(evidence):
                continue
            if not kept:
                self.connection.execute("DELETE FROM edges WHERE id = ?", (row["id"],))
            else:
                self.connection.execute(
                    "UPDATE edges SET evidence = ?, updated_at = ? WHERE id = ?",
                    (_json(kept[0] if len(kept) == 1 else kept), _now(), row["id"]),
                )
        if owned_ids:
            placeholders = ",".join("?" for _ in owned_ids)
            self.connection.execute(f"DELETE FROM nodes WHERE id IN ({placeholders})", tuple(owned_ids))
        self.connection.commit()

    def append_journal(self, event: str, payload: Mapping[str, Any]) -> None:
        self.connection.execute(
            "INSERT INTO journal (ts, event, payload) VALUES (?, ?, ?)",
            (_now(), event, _json(dict(payload))),
        )
        self.connection.commit()

    def set_health(self, key: str, value: Any) -> None:
        self.connection.execute(
            """
            INSERT INTO health (key, value, updated_at) VALUES (?, ?, ?)
            ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
            """,
            (key, _json(value), _now()),
        )
        self.connection.commit()

    def get_health(self, key: str) -> Any | None:
        row = self.connection.execute("SELECT value FROM health WHERE key = ?", (key,)).fetchone()
        return _load_json(row["value"]) if row else None

    def list_health(self) -> dict[str, Any]:
        rows = self.connection.execute("SELECT key, value FROM health ORDER BY key").fetchall()
        return {row["key"]: _load_json(row["value"]) for row in rows}

    def mark_critical(self, node_id: str) -> dict[str, Any]:
        node = self.get_node(node_id)
        if not node:
            raise GraphError(f"unknown node: {node_id}")
        node["critical"] = True
        return self.upsert_node(node)

    @staticmethod
    def _evidence_mentions_file(evidence: Any, relative_path: str) -> bool:
        if not isinstance(evidence, dict):
            return False
        if evidence.get("file") == relative_path:
            return True
        nested = evidence.get("evidence")
        return isinstance(nested, dict) and nested.get("file") == relative_path

    def upsert_edge(self, edge: Mapping[str, Any]) -> dict[str, Any]:
        edge_id = str(edge.get("id", "")).strip()
        edge_type = str(edge.get("type", "")).strip()
        from_id = str(edge.get("from", edge.get("from_id", ""))).strip()
        to_id = str(edge.get("to", edge.get("to_id", ""))).strip()
        sources = self._sources(edge.get("sources", []))
        evidence = edge.get("evidence")
        if not edge_id or not edge_type or not from_id or not to_id:
            raise GraphError("edge id, type, from, and to are required")
        if edge_type not in EDGE_TYPES:
            raise GraphError(f"unsupported edge type: {edge_type}")
        if not self.get_node(from_id) or not self.get_node(to_id):
            raise GraphError("edge endpoints must already exist as nodes")
        self._validate_evidence(evidence, sources)

        existing = self.connection.execute(
            "SELECT * FROM edges WHERE id = ?", (edge_id,)
        ).fetchone()
        if existing:
            return self._merge_existing_edge(existing, edge_type, from_id, to_id, evidence, sources, edge)

        logical = self.connection.execute(
            "SELECT * FROM edges WHERE type = ? AND from_id = ? AND to_id = ?",
            (edge_type, from_id, to_id),
        ).fetchone()
        if logical:
            return self._merge_existing_edge(logical, edge_type, from_id, to_id, evidence, sources, edge)

        self.connection.execute(
            """
            INSERT INTO edges
              (id, type, from_id, to_id, evidence, sources, confidence, conflict, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                edge_id,
                edge_type,
                from_id,
                to_id,
                _json(evidence),
                _json(sources),
                edge.get("confidence"),
                int(bool(edge.get("conflict", False))),
                edge.get("updated_at") or _now(),
            ),
        )
        self.connection.commit()
        return self.get_edge(edge_id)  # type: ignore[return-value]

    def get_edge(self, edge_id: str) -> dict[str, Any] | None:
        row = self.connection.execute("SELECT * FROM edges WHERE id = ?", (edge_id,)).fetchone()
        return self._edge_dict(row) if row else None

    def impact(
        self,
        start_ids: str | Iterable[str],
        direction: str = "downstream",
        depth: int = 5,
        max_paths: int = 7,
    ) -> dict[str, Any]:
        starts = [start_ids] if isinstance(start_ids, str) else list(start_ids)
        starts = list(dict.fromkeys(str(item) for item in starts if str(item).strip()))
        if not starts:
            raise GraphError("at least one start node is required")
        if direction not in {"downstream", "upstream"}:
            raise GraphError("direction must be downstream or upstream")
        if depth < 0:
            raise GraphError("depth must be non-negative")
        depth = min(depth, 5)
        max_paths = max(1, min(max_paths, 7))
        missing = [node_id for node_id in starts if not self.get_node(node_id)]
        if missing:
            raise GraphError(f"unknown start node: {missing[0]}")

        rules = DOWNSTREAM if direction == "downstream" else UPSTREAM
        queue = deque((node_id, [node_id], []) for node_id in starts)
        best_depth = {node_id: 0 for node_id in starts}
        discovered = set(starts)
        path_results: list[dict[str, Any]] = []
        edge_results: dict[str, dict[str, Any]] = {}

        while queue and len(path_results) < max_paths:
            current, path_nodes, path_edges = queue.popleft()
            current_depth = len(path_edges)
            if current_depth >= depth:
                continue
            for edge_row, next_id in self._neighbors(current, rules):
                if next_id in path_nodes:
                    continue
                next_edge = self._edge_dict(edge_row)
                next_path_edges = [*path_edges, next_edge]
                next_path_nodes = [*path_nodes, next_id]
                discovered.add(next_id)
                edge_results[next_edge["id"]] = next_edge
                path_results.append({"nodes": next_path_nodes, "edges": next_path_edges})
                if len(path_results) >= max_paths:
                    break
                next_depth = current_depth + 1
                if next_depth >= best_depth.get(next_id, 10**9):
                    continue
                best_depth[next_id] = next_depth
                queue.append((next_id, next_path_nodes, next_path_edges))

        node_results = [self.get_node(node_id) for node_id in sorted(discovered)]
        nodes = [node for node in node_results if node is not None]
        impacted = [node for node in nodes if node["id"] not in starts]
        counts: dict[str, int] = {}
        for node in impacted:
            counts[node["kind"]] = counts.get(node["kind"], 0) + 1

        risks: list[str] = []
        if impacted:
            risks.append("downstream")
        if any(node["critical"] for node in nodes):
            risks.append("critical")
        if any(edge["type"] == "WRITES" for edge in edge_results.values()):
            risks.append("db_write")
        if any(node["kind"] == "External" for node in impacted):
            risks.append("external")
        if any(edge["conflict"] for edge in edge_results.values()):
            risks.append("conflict")
        if any(self._degree(node["id"]) >= 10 for node in impacted):
            risks.append("high_degree")
        relevant = {"Function", "Method", "Class", "Service", "API", "Table"}
        if any(node["kind"] in relevant for node in impacted) and not any(
            node["kind"] == "Test" for node in impacted
        ):
            risks.append("untested")

        return {
            "ok": True,
            "nodes": nodes,
            "edges": list(edge_results.values()),
            "paths": path_results,
            "counts": counts,
            "risk": risks,
            "tests_to_run": [node for node in impacted if node["kind"] == "Test"],
            "docs": [node for node in impacted if node["kind"] == "Doc"],
            "suggested_reviewers": [],
            "evidence_used": all(edge["evidence"] for edge in edge_results.values()),
        }

    def _merge_existing_edge(
        self,
        row: sqlite3.Row,
        incoming_type: str,
        incoming_from: str,
        incoming_to: str,
        incoming_evidence: Any,
        incoming_sources: list[str],
        incoming: Mapping[str, Any],
    ) -> dict[str, Any]:
        current = self._edge_dict(row)
        conflict = bool(current["conflict"])
        evidence_items = current["evidence"] if isinstance(current["evidence"], list) else [current["evidence"]]
        same_identity = (
            current["type"] == incoming_type
            and current["from"] == incoming_from
            and current["to"] == incoming_to
        )
        candidate = incoming_evidence
        if not same_identity:
            conflict = True
            candidate = {
                "edge_candidate": {
                    "type": incoming_type,
                    "from": incoming_from,
                    "to": incoming_to,
                },
                "evidence": incoming_evidence,
            }
        if _json(candidate) not in {_json(item) for item in evidence_items}:
            evidence_items.append(candidate)
        sources = list(dict.fromkeys([*current["sources"], *incoming_sources]))
        confidence_values = [value for value in (current["confidence"], incoming.get("confidence")) if value is not None]
        confidence = max(confidence_values) if confidence_values else None
        self.connection.execute(
            """
            UPDATE edges
            SET evidence = ?, sources = ?, confidence = ?, conflict = ?, updated_at = ?
            WHERE id = ?
            """,
            (_json(evidence_items[0] if len(evidence_items) == 1 else evidence_items), _json(sources), confidence, int(conflict), incoming.get("updated_at") or _now(), current["id"]),
        )
        self.connection.commit()
        return self.get_edge(current["id"])  # type: ignore[return-value]

    def _neighbors(self, node_id: str, rules: Mapping[str, str]) -> list[tuple[sqlite3.Row, str]]:
        rows = self.connection.execute(
            "SELECT * FROM edges WHERE from_id = ? OR to_id = ? ORDER BY id",
            (node_id, node_id),
        ).fetchall()
        result = []
        for row in rows:
            mode = rules.get(row["type"])
            if mode == "forward" and row["from_id"] == node_id:
                result.append((row, row["to_id"]))
            elif mode == "inverse" and row["to_id"] == node_id:
                result.append((row, row["from_id"]))
        return result

    def _degree(self, node_id: str) -> int:
        row = self.connection.execute(
            "SELECT COUNT(*) AS degree FROM edges WHERE from_id = ? OR to_id = ?",
            (node_id, node_id),
        ).fetchone()
        return int(row["degree"])

    @staticmethod
    def _sources(value: Any) -> list[str]:
        if isinstance(value, str):
            value = [value]
        if not isinstance(value, list) or not value:
            raise GraphError("edge sources must be a non-empty list")
        sources = list(dict.fromkeys(str(source) for source in value))
        invalid = [source for source in sources if source not in EDGE_SOURCES]
        if invalid:
            raise GraphError(f"unsupported edge source: {invalid[0]}")
        return sources

    def _validate_evidence(self, evidence: Any, sources: list[str]) -> None:
        if not isinstance(evidence, (dict, list)) or not evidence:
            raise GraphError("every edge requires evidence")
        if all(source in {"user", "agent"} for source in sources):
            return
        records = evidence if isinstance(evidence, list) else [evidence]
        for record in records:
            if not isinstance(record, dict):
                raise GraphError("edge evidence entries must be JSON objects")
            if not record.get("file") or not isinstance(record.get("line"), int) or not record.get("snippet"):
                raise GraphError("automated edge evidence requires file, integer line, and snippet")
            if "llm" in sources:
                self._verify_snippet(record)

    def _verify_snippet(self, evidence: Mapping[str, Any]) -> None:
        if not self.workspace_root:
            raise GraphError("LLM evidence verification requires workspace_root")
        file_path = (self.workspace_root / str(evidence["file"])).resolve()
        try:
            file_path.relative_to(self.workspace_root)
        except ValueError as error:
            raise GraphError("evidence file must be inside workspace_root") from error
        if not file_path.is_file():
            raise GraphError(f"evidence file does not exist: {evidence['file']}")
        text = file_path.read_text(encoding="utf-8")
        if str(evidence["snippet"]) not in text:
            raise GraphError("LLM evidence snippet does not exist in cited file")

    @staticmethod
    def _node_dict(row: sqlite3.Row) -> dict[str, Any]:
        result = dict(row)
        result["extra"] = _load_json(result["extra"])
        result["critical"] = bool(result["critical"])
        return result

    @staticmethod
    def _edge_dict(row: sqlite3.Row) -> dict[str, Any]:
        result = dict(row)
        result["from"] = result.pop("from_id")
        result["to"] = result.pop("to_id")
        result["evidence"] = _load_json(result["evidence"])
        result["sources"] = _load_json(result["sources"])
        result["conflict"] = bool(result["conflict"])
        return result
