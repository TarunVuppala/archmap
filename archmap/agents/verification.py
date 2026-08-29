"""Independent deterministic verification for agent proposals and plans."""

from __future__ import annotations

from typing import Any, Mapping

from packages.graph import GraphStore
from .contracts import validate_contract


def verify_plan(store: GraphStore, plan: Mapping[str, Any]) -> dict[str, Any]:
    issues: list[str] = []
    contract = plan.get("contract")
    if not isinstance(contract, Mapping):
        issues.append("plan is missing a prompt contract")
    else:
        try:
            validate_contract(contract)
        except ValueError as error:
            issues.append(str(error))
    target = plan.get("target", {})
    target_id = target.get("id") if isinstance(target, Mapping) else None
    if target_id and not store.get_node(str(target_id)):
        issues.append(f"target node does not exist: {target_id}")
    for node in plan.get("impacted", []) if isinstance(plan.get("impacted"), list) else []:
        if isinstance(node, Mapping) and not store.get_node(str(node.get("id", ""))):
            issues.append(f"impacted node does not exist: {node.get('id')}")
    for path in plan.get("paths", []) if isinstance(plan.get("paths"), list) else []:
        if not isinstance(path, Mapping):
            issues.append("path is not an object")
            continue
        node_ids = path.get("nodes", [])
        if not all(store.get_node(str(node_id)) for node_id in node_ids):
            issues.append("path references a missing node")
        for edge in path.get("edges", []):
            if not isinstance(edge, Mapping) or not edge.get("evidence"):
                issues.append("path edge is missing evidence")
    allowed_files = plan.get("allowed_files", [])
    allowed = set(str(path) for path in allowed_files) if isinstance(allowed_files, list) else set()
    forbidden = {".env", "AGENTS.md"}
    if allowed.intersection(forbidden):
        issues.append("mutation envelope includes a protected file")
    return {"ok": not issues, "nodes": [], "edges": [], "paths": [], "counts": {"checks": 4, "issues": len(issues)}, "risk": ["verification_failed"] if issues else [], "evidence_used": True, "verified": not issues, "issues": issues}


def verification_loop(store: GraphStore, proposal: Mapping[str, Any], max_attempts: int = 3) -> dict[str, Any]:
    attempts = max(1, min(int(max_attempts), 3))
    results = []
    for attempt in range(1, attempts + 1):
        result = verify_plan(store, proposal)
        result["attempt"] = attempt
        results.append(result)
        if result["ok"]:
            break
    final = results[-1]
    store.append_journal("verification", {"attempts": len(results), "ok": final["ok"], "issues": final["issues"]})
    return {**final, "attempts": results}
