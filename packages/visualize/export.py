"""Render the same graph query result for different consumers."""

from __future__ import annotations

import re
from typing import Any


def render_graph(payload: dict[str, Any], view: str = "architecture", output: str = "json") -> dict[str, Any]:
    """Attach renderer metadata without creating a second graph projection."""

    if view not in {"architecture", "galaxy"}:
        raise ValueError("view must be architecture or galaxy")
    if output not in {"json", "mermaid"}:
        raise ValueError("output must be json or mermaid")
    result = dict(payload)
    result["view"] = view
    result["renderer"] = "cosmograph" if view == "galaxy" else "react-flow"
    result["layout"] = "force" if view == "galaxy" else "hierarchical"
    if output == "mermaid":
        result["mermaid"] = to_mermaid(result)
    return result


def to_mermaid(payload: dict[str, Any], max_nodes: int = 50, max_edges: int = 100) -> str:
    """Export a bounded graph payload as a Mermaid flowchart."""

    nodes = list(payload.get("nodes") or [])[:max_nodes]
    allowed = {str(node.get("id")) for node in nodes}
    edges = [
        edge for edge in (payload.get("edges") or [])
        if str(edge.get("from")) in allowed and str(edge.get("to")) in allowed
    ][:max_edges]
    aliases = {node_id: f"n{index}" for index, node_id in enumerate(sorted(allowed))}
    lines = ["flowchart LR"]
    for node in sorted(nodes, key=lambda item: str(item.get("id"))):
        node_id = str(node.get("id"))
        label = _label(node)
        lines.append(f'    {aliases[node_id]}["{label}"]')
    for edge in edges:
        edge_type = _escape(str(edge.get("type", "")))
        lines.append(f"    {aliases[str(edge['from'])]} -->|{edge_type}| {aliases[str(edge['to'])]}")
    return "\n".join(lines)


def _label(node: dict[str, Any]) -> str:
    kind = _escape(str(node.get("kind", "")))
    name = _escape(str(node.get("name") or node.get("id", "")))
    return f"{kind}: {name}"


def _escape(value: str) -> str:
    return re.sub(r"[\"`<>]", "", value).replace("|", "/")
