"""Provider-neutral capability and cost routing."""

from __future__ import annotations

from typing import Any


MODEL_PROFILES = {
    "deterministic": {"provider": "local", "model": "deterministic", "input_rate": 0.0, "output_rate": 0.0},
    "cheap": {"provider": "local", "model": "cheap", "input_rate": 0.15, "output_rate": 0.60},
    "strong": {"provider": "local", "model": "strong", "input_rate": 3.0, "output_rate": 12.0},
    "independent_verifier": {"provider": "local", "model": "independent-verifier", "input_rate": 0.50, "output_rate": 2.0},
}


def route_task(
    task: str,
    *,
    complexity: str = "auto",
    context_tokens: int = 0,
    security_sensitive: bool = False,
    input_tokens: int | None = None,
    output_tokens: int = 0,
) -> dict[str, Any]:
    task_name = str(task).lower()
    if security_sensitive or "verif" in task_name:
        capability = "independent_verifier"
        reason = "independent verification is required"
    elif complexity in {"strong", "complex"} or "plan" in task_name or "architecture" in task_name:
        capability = "strong"
        reason = "planning or architecture uncertainty warrants stronger reasoning"
    elif complexity in {"cheap", "simple"} or "summary" in task_name or "route" in task_name:
        capability = "cheap"
        reason = "a bounded classification or summary task is sufficient"
    else:
        capability = "deterministic"
        reason = "graph, parsing, and validation should run without a model"
    profile = MODEL_PROFILES[capability]
    input_count = max(0, int(input_tokens if input_tokens is not None else context_tokens))
    output_count = max(0, int(output_tokens))
    estimated_cost = (input_count * profile["input_rate"] + output_count * profile["output_rate"]) / 1_000_000
    return {
        "capability": capability,
        "provider": profile["provider"],
        "model": profile["model"],
        "reason": reason,
        "estimated_cost": round(estimated_cost, 8),
        "pricing_known": True,
        "context_tokens": input_count,
        "output_tokens": output_count,
    }
