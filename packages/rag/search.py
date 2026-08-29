"""Dependency-free lexical retrieval over chunks stored beside graph nodes."""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any, Iterable

from packages.graph import GraphError, GraphStore


_TOKEN_RE = re.compile(r"[A-Za-z0-9_@./:-]+")


def index_code_chunks(store: GraphStore, relative_path: str, source: str, nodes: Iterable[dict[str, Any]]) -> int:
    """Create bounded code chunks for parsed nodes in the one graph."""

    lines = source.splitlines()
    count = 0
    for node in nodes:
        node_id = node.get("id")
        if not node_id or not store.get_node(str(node_id)):
            continue
        start = node.get("start_line")
        end = node.get("end_line")
        if isinstance(start, int) and start > 0:
            end_line = end if isinstance(end, int) and end >= start else start
            text = "\n".join(lines[start - 1 : end_line])
        else:
            text = source
        text = text.strip()[:12000]
        if not text:
            continue
        store.upsert_chunk({
            "id": f"chunk:{node_id}",
            "node_id": str(node_id),
            "kind": "code",
            "text": text,
        })
        count += 1
    return count


def search(store: GraphStore, query: str, kind: str | None = None, limit: int = 20) -> dict[str, Any]:
    """Return ranked chunks and their graph nodes using deterministic lexical scoring."""

    query = str(query).strip()
    if not query:
        raise GraphError("query is required")
    limit = max(1, min(int(limit), 50))
    query_tokens = _tokens(query)
    if not query_tokens:
        raise GraphError("query must contain searchable characters")
    candidates = []
    for chunk in store.list_chunks(1000):
        if kind and chunk.get("kind") != kind:
            continue
        node = store.get_node(chunk["node_id"])
        if not node:
            continue
        haystack = f"{node['id']} {node['name']} {chunk['text']}".lower()
        tokens = set(_tokens(haystack))
        overlap = len(tokens.intersection(query_tokens))
        phrase = query.lower() in haystack
        if overlap == 0 and not phrase:
            continue
        score = overlap / len(query_tokens)
        if phrase:
            score += 0.75
        if node["id"].lower() == query.lower() or node["name"].lower() == query.lower():
            score += 1.0
        candidates.append((score, chunk, node))
    candidates.sort(key=lambda item: (-item[0], item[2]["kind"], item[2]["id"]))
    results = [
        {"score": round(score, 4), "chunk": chunk, "node": node}
        for score, chunk, node in candidates[:limit]
    ]
    nodes = []
    seen = set()
    for result in results:
        node = result["node"]
        if node["id"] not in seen:
            nodes.append(node)
            seen.add(node["id"])
    return {
        "ok": True,
        "nodes": nodes,
        "edges": [],
        "paths": [],
        "counts": {"results": len(results), "nodes": len(nodes)},
        "risk": [],
        "evidence_used": True,
        "query": query,
        "results": results,
    }


def _tokens(value: str) -> list[str]:
    return [token.lower() for token in _TOKEN_RE.findall(value)]
