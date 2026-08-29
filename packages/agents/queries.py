"""Bounded graph queries used by agent-facing operations."""

from __future__ import annotations

from collections import deque
from typing import Any

from packages.graph import GraphError, GraphStore
from packages.rag import search


def symbol(store: GraphStore, identifier: str, limit: int = 50) -> dict[str, Any]:
    identifier = str(identifier).strip()
    node = store.get_node(identifier)
    if node is None:
        matches = store.find_nodes(identifier, limit=1)
        node = matches[0] if matches else None
    if node is None:
        raise GraphError(f"unknown symbol: {identifier}")
    neighbors = store.neighbors(node["id"], "both", limit)
    return {"ok": True, "nodes": [node], "edges": neighbors["edges"], "paths": [], "counts": {"neighbors": len(neighbors["edges"])}, "risk": [], "evidence_used": neighbors["evidence_used"], "symbol": node, "neighbors": neighbors}


def why_path(store: GraphStore, from_id: str, to_id: str, max_depth: int = 5, max_paths: int = 7) -> dict[str, Any]:
    if not store.get_node(from_id) or not store.get_node(to_id):
        raise GraphError("both why_path endpoints must exist")
    max_depth = max(0, min(int(max_depth), 5))
    max_paths = max(1, min(int(max_paths), 7))
    edges = store.list_edges(100)
    outgoing: dict[str, list[dict[str, Any]]] = {}
    for edge in edges:
        outgoing.setdefault(edge["from"], []).append(edge)
    queue = deque([(from_id, [from_id], [])])
    paths = []
    while queue and len(paths) < max_paths:
        current, node_path, edge_path = queue.popleft()
        if current == to_id:
            paths.append({"nodes": node_path, "edges": edge_path})
            continue
        if len(edge_path) >= max_depth:
            continue
        for edge in outgoing.get(current, []):
            if edge["to"] in node_path:
                continue
            queue.append((edge["to"], [*node_path, edge["to"]], [*edge_path, edge]))
    node_ids = {node_id for path in paths for node_id in path["nodes"]}
    nodes = [node for node_id in sorted(node_ids) if (node := store.get_node(node_id)) is not None]
    return {"ok": True, "nodes": nodes, "edges": [edge for path in paths for edge in path["edges"]], "paths": paths, "counts": {"paths": len(paths)}, "risk": [], "evidence_used": all(edge["evidence"] for path in paths for edge in path["edges"])}


def tests_to_run(store: GraphStore, identifier: str) -> dict[str, Any]:
    target = store.get_node(identifier)
    if target is None:
        matches = store.find_nodes(identifier, limit=1)
        target = matches[0] if matches else None
    if target is None:
        raise GraphError(f"unknown symbol: {identifier}")
    impact = store.impact(target["id"], "downstream")
    tests = impact.get("tests_to_run", [])
    paths = [node.get("path") for node in tests if node.get("path")]
    commands = ["python3 -m unittest discover -s tests -v"] if any(str(path).endswith((".py", ".pyw")) for path in paths) else []
    if any(str(path).endswith((".ts", ".tsx", ".js", ".jsx")) for path in paths):
        commands.append("npm test")
    return {"ok": True, "nodes": tests, "edges": impact["edges"], "paths": impact["paths"], "counts": {"tests": len(tests)}, "risk": impact["risk"], "evidence_used": impact["evidence_used"], "tests": tests, "commands": commands}


def search_symbols(store: GraphStore, query: str, kind: str | None = None, limit: int = 20) -> dict[str, Any]:
    return search(store, query, kind, limit)
