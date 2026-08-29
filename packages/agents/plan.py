"""Deterministic, bounded change-plan envelopes."""

from __future__ import annotations

from pathlib import PurePosixPath
from typing import Any

from packages.graph import GraphError, GraphStore
from packages.seed.health import health_report
from .contracts import context_pack, prompt_contract
from .queries import search_symbols
from .router import route_task


def plan_change(store: GraphStore, identifier: str | None = None, intent: str | None = None, depth: int = 5) -> dict[str, Any]:
    if not identifier and not intent:
        raise GraphError("id or intent is required")
    target = store.get_node(identifier) if identifier else None
    search_result = None
    if target is None and identifier:
        search_result = search_symbols(store, identifier, limit=1)
        target = search_result["nodes"][0] if search_result["nodes"] else None
    if target is None and intent:
        search_result = search_symbols(store, intent, limit=1)
        target = search_result["nodes"][0] if search_result["nodes"] else None
    if target is None:
        raise GraphError("could not resolve a target node from id or intent")
    impact = store.impact(target["id"], "downstream", depth, 7)
    impacted = [node for node in impact["nodes"] if node["id"] != target["id"]]
    allowed_files = sorted({node["path"] for node in [target, *impacted] if node.get("path") and _safe_path(node["path"])})
    health = health_report(store)
    contract = prompt_contract(
        task="plan_change",
        role="change-planner",
        goal=f"Produce a safe implementation envelope for {target['id']}",
        context=context_pack(intent or target["name"], facts=[target], evidence=impact["paths"], constraints=["use_only_graph_evidence", "do_not_expand_scope"]),
        evidence=impact["paths"],
        constraints=["do_not_invent_edges", "edit_only_allowed_files", "stop_on_conflict_or_policy_block"],
        allowed_tools=["search", "symbol", "blast_radius", "docs_for", "tests_to_run", "sync", "diff_impact"],
        allowed_files=allowed_files,
        forbidden_actions=["edit_outside_envelope", "modify_AGENTS.md", "upload_source_without_permission"],
        output_schema={"allowed_files": "array", "impacted": "array", "tests_to_run": "array", "policies": "array"},
        success_criteria=["all impacted nodes exist", "all paths have evidence", "verification passes"],
        verification={"independent": True, "method": "graph_and_schema_checks"},
        budget={"max_agents": 2, "max_depth": 3, "max_model_calls": 0, "max_runtime_seconds": 30},
    )
    route = route_task("plan_change", complexity="strong", context_tokens=len(allowed_files) * 40)
    policies = [{"key": issue["key"], "status": "warn"} for issue in health.get("issues", [])]
    result = {
        "ok": True,
        "nodes": [target, *impacted],
        "edges": impact["edges"],
        "paths": impact["paths"],
        "counts": impact["counts"],
        "risk": impact["risk"],
        "evidence_used": impact["evidence_used"],
        "target": target,
        "intent": intent,
        "allowed_files": allowed_files,
        "forbidden_files": ["AGENTS.md", "**/.env", "**/secrets/**", "**/generated/**"],
        "impacted": impacted,
        "tests_to_run": impact["tests_to_run"],
        "docs": impact["docs"],
        "policies": policies,
        "model_route": route,
        "contract": contract,
    }
    store.append_journal("agent_run", {"role": "change-planner", "task": "plan_change", "target": target["id"], "evidence": impact["paths"], "status": "completed"})
    return result


def _safe_path(path: str) -> bool:
    normalized = PurePosixPath(str(path))
    return not any(part in {".git", ".archmap", "generated", "vendor", "node_modules"} for part in normalized.parts) and not normalized.name.startswith(".env")
