"""Dependency-free loader for the supported `.archmap/seed.yaml` subset."""

from __future__ import annotations

import ast
import hashlib
import re
from pathlib import Path
from typing import Any

from packages.graph import GraphError, GraphStore


def load_seed(path: str | Path) -> dict[str, Any]:
    """Load the documented seed shape without requiring a YAML dependency."""

    seed_path = Path(path)
    if not seed_path.is_file():
        return {}
    lines = seed_path.read_text(encoding="utf-8").splitlines()
    data: dict[str, Any] = {"project": {}, "services": [], "externals": [], "pins": [], "ignore_paths": [], "critical": []}
    section: str | None = None
    item: dict[str, Any] | None = None
    for raw in lines:
        line = raw.split("#", 1)[0].rstrip()
        if not line.strip():
            continue
        indent = len(line) - len(line.lstrip())
        stripped = line.strip()
        if indent == 0 and stripped.endswith(":"):
            section = stripped[:-1]
            item = None
            continue
        if indent == 0 and ":" in stripped:
            key, value = stripped.split(":", 1)
            data[key.strip()] = _value(value.strip())
            section = None
            item = None
            continue
        if section in {"services", "externals", "pins"} and stripped.startswith("-"):
            rest = stripped[1:].strip()
            if rest.startswith("{"):
                item = _value(rest)
            elif ":" in rest:
                key, value = rest.split(":", 1)
                item = {key.strip(): _value(value.strip())}
            else:
                item = {}
            if not isinstance(item, dict):
                raise ValueError(f"seed list item must be a mapping: {stripped}")
            data[section].append(item)
            continue
        if section and ":" in stripped:
            key, value = stripped.split(":", 1)
            if section == "project":
                data[section][key.strip()] = _value(value.strip())
            elif item is not None:
                item[key.strip()] = _value(value.strip())
    return data


def apply_seed(store: GraphStore, workspace: str | Path) -> dict[str, Any]:
    root = Path(workspace).resolve()
    seed_path = root / ".archmap" / "seed.yaml"
    seed = load_seed(seed_path)
    if not seed:
        return {"loaded": False, "services": 0, "externals": 0, "pins": 0, "critical": 0}
    services = seed.get("services") if isinstance(seed.get("services"), list) else []
    externals = seed.get("externals") if isinstance(seed.get("externals"), list) else []
    pins = seed.get("pins") if isinstance(seed.get("pins"), list) else []
    critical = seed.get("critical") if isinstance(seed.get("critical"), list) else []
    project = seed.get("project") if isinstance(seed.get("project"), dict) else {}
    with_graph = store
    repo_name = project.get("name")
    if repo_name:
        with_graph.upsert_node({"id": f"repo:{repo_name}", "kind": "Repo", "name": repo_name, "extra": {"seed": True}})
    for service in services:
        service_id = str(service.get("id", "")).strip()
        if not service_id:
            continue
        service_node = with_graph.upsert_node({
            "id": f"svc:{service_id}",
            "kind": "Service",
            "name": service_id,
            "extra": {"paths": service.get("paths", []), "owns_tables": service.get("owns_tables", []), "owns_routes": service.get("owns_routes", [])},
        })
        for table in _as_strings(service.get("owns_tables")):
            table_id = f"table:{table}"
            with_graph.upsert_node({"id": table_id, "kind": "Table", "name": table})
            _upsert_user_edge(with_graph, "CONTAINS", service_node["id"], table_id, f"seed.yaml services.{service_id}.owns_tables")
        for route in _as_strings(service.get("owns_routes")):
            method, _, path = route.partition(" ")
            api_id = f"api:{method.upper()}:{path}" if path else f"api:GET:{method}"
            with_graph.upsert_node({"id": api_id, "kind": "API", "name": route, "extra": {"method": method.upper(), "path": path or method}})
            _upsert_user_edge(with_graph, "EXPOSES", service_node["id"], api_id, f"seed.yaml services.{service_id}.owns_routes")
    for external in externals:
        external_id = str(external.get("id", "")).strip()
        if not external_id:
            continue
        node_id = f"ext:{external_id}"
        with_graph.upsert_node({"id": node_id, "kind": "External", "name": external_id, "extra": {"seed": True}})
        for route in _as_strings(external.get("consumes")):
            method, _, path = route.partition(" ")
            api_id = f"api:{method.upper()}:{path}" if path else f"api:GET:{method}"
            with_graph.upsert_node({"id": api_id, "kind": "API", "name": route, "extra": {"method": method.upper(), "path": path or method}})
            _upsert_user_edge(with_graph, "CONSUMES", node_id, api_id, f"seed.yaml externals.{external_id}.consumes")
    for index, pin in enumerate(pins):
        if isinstance(pin, dict) and pin.get("type") and pin.get("from") and pin.get("to"):
            apply_pin(with_graph, str(pin["type"]), str(pin["from"]), str(pin["to"]), note=f"seed.yaml pins[{index}]")
    critical_count = 0
    for node_id in _as_strings(critical):
        if with_graph.get_node(node_id):
            with_graph.mark_critical(node_id)
            critical_count += 1
    return {"loaded": True, "services": len(services), "externals": len(externals), "pins": len(pins), "critical": critical_count}


def apply_pin(store: GraphStore, edge_type: str, from_id: str, to_id: str, note: str | None = None, evidence: dict | None = None) -> dict:
    if not from_id or not to_id or not edge_type:
        raise GraphError("pin type, from, and to are required")
    for node_id in (from_id, to_id):
        if not store.get_node(node_id):
            raise GraphError(f"unknown node: {node_id}")
    edge_id = "e_" + hashlib.sha1(f"{edge_type}\0{from_id}\0{to_id}".encode()).hexdigest()[:16]
    return store.upsert_edge({
        "id": edge_id,
        "type": edge_type,
        "from": from_id,
        "to": to_id,
        "evidence": evidence or {"pin": note or "user pin"},
        "sources": ["user"],
        "confidence": 1.0,
    })


def _upsert_user_edge(store: GraphStore, edge_type: str, from_id: str, to_id: str, note: str) -> None:
    apply_pin(store, edge_type, from_id, to_id, note=note)


def _as_strings(value: Any) -> list[str]:
    if isinstance(value, str):
        return [value]
    return [str(item) for item in value] if isinstance(value, list) else []


def _value(value: str) -> Any:
    if not value:
        return None
    if value in {"true", "false"}:
        return value == "true"
    if value in {"never", "stuck"}:
        return value
    if value.startswith("[") or value.startswith("{"):
        try:
            return ast.literal_eval(value)
        except (SyntaxError, ValueError):
            if value.startswith("{"):
                parsed: dict[str, Any] = {}
                for part in value[1:-1].split(","):
                    if ":" not in part:
                        continue
                    key, item = part.split(":", 1)
                    parsed[key.strip().strip("'\"")] = item.strip().strip("'\"")
                return parsed
            return [item.strip().strip("'\"") for item in value[1:-1].split(",") if item.strip()]
    return value.strip("'\"")
