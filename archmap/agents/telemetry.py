"""Safe journal-backed events and model usage telemetry."""

from __future__ import annotations

from collections import defaultdict
from typing import Any, Mapping

from packages.graph import GraphError, GraphStore
from .router import MODEL_PROFILES, route_task


ALLOWED_EVENTS = {"incident", "coverage", "otel", "stack", "agent_run", "agent_usage", "decision", "verification", "prompt_proposal", "prompt_review", "prompt_update"}


def record_event(store: GraphStore, event: str, payload: Mapping[str, Any]) -> dict[str, Any]:
    event = str(event).strip()
    if event not in ALLOWED_EVENTS:
        raise GraphError(f"unsupported event: {event}")
    clean = _bounded(dict(payload))
    store.append_journal(event, clean)
    return {"ok": True, "nodes": [], "edges": [], "paths": [], "counts": {"events": 1}, "risk": [], "evidence_used": True, "event": event, "payload": clean}


def record_usage(
    store: GraphStore,
    *,
    run_id: str,
    task: str,
    provider: str,
    model: str,
    input_tokens: int = 0,
    output_tokens: int = 0,
    cached_input_tokens: int = 0,
    tool_calls: int = 0,
    latency_ms: int = 0,
    verification_cost: float = 0.0,
) -> dict[str, Any]:
    route = route_task(task, input_tokens=input_tokens, output_tokens=output_tokens)
    pricing_known = any(profile["provider"] == provider and profile["model"] == model for profile in MODEL_PROFILES.values())
    usage = {
        "run_id": str(run_id),
        "task": str(task),
        "provider": str(provider),
        "model": str(model),
        "input_tokens": max(0, int(input_tokens)),
        "output_tokens": max(0, int(output_tokens)),
        "cached_input_tokens": max(0, int(cached_input_tokens)),
        "tool_calls": max(0, int(tool_calls)),
        "latency_ms": max(0, int(latency_ms)),
        "verification_cost": max(0.0, float(verification_cost)),
        "estimated_cost": (route["estimated_cost"] if pricing_known else 0.0) + max(0.0, float(verification_cost)),
        "pricing_known": pricing_known,
    }
    record_event(store, "agent_usage", usage)
    return usage


def usage_summary(store: GraphStore) -> dict[str, Any]:
    rows = store.list_journal(event="agent_usage", limit=1000)
    totals: dict[str, Any] = {"runs": 0, "input_tokens": 0, "output_tokens": 0, "cached_input_tokens": 0, "tool_calls": 0, "latency_ms": 0, "estimated_cost": 0.0}
    by_model: dict[str, dict[str, Any]] = defaultdict(lambda: {"runs": 0, "input_tokens": 0, "output_tokens": 0, "estimated_cost": 0.0})
    for row in rows:
        payload = row["payload"]
        totals["runs"] += 1
        for key in ("input_tokens", "output_tokens", "cached_input_tokens", "tool_calls", "latency_ms"):
            totals[key] += int(payload.get(key, 0))
        totals["estimated_cost"] += float(payload.get("estimated_cost", 0.0))
        model = f"{payload.get('provider', 'unknown')}/{payload.get('model', 'unknown')}"
        bucket = by_model[model]
        bucket["runs"] += 1
        bucket["input_tokens"] += int(payload.get("input_tokens", 0))
        bucket["output_tokens"] += int(payload.get("output_tokens", 0))
        bucket["estimated_cost"] += float(payload.get("estimated_cost", 0.0))
    totals["estimated_cost"] = round(totals["estimated_cost"], 8)
    for bucket in by_model.values():
        bucket["estimated_cost"] = round(bucket["estimated_cost"], 8)
    return {"ok": True, "nodes": [], "edges": [], "paths": [], "counts": {"agent_runs": totals["runs"]}, "risk": [], "evidence_used": True, "usage": {**totals, "by_model": dict(by_model)}}


def _bounded(value: Any, depth: int = 0) -> Any:
    if depth > 3:
        return "[truncated]"
    if isinstance(value, Mapping):
        return {str(key): _bounded(item, depth + 1) for key, item in list(value.items())[:50]}
    if isinstance(value, list):
        return [_bounded(item, depth + 1) for item in value[:50]]
    if isinstance(value, str):
        return value[:4000]
    if isinstance(value, (int, float, bool)) or value is None:
        return value
    return str(value)[:4000]
