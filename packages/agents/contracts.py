"""Structured prompt and context contracts for agent work."""

from __future__ import annotations

from typing import Any, Iterable, Mapping


CONTRACT_FIELDS = (
    "task",
    "role",
    "goal",
    "context",
    "evidence",
    "constraints",
    "allowed_tools",
    "allowed_files",
    "forbidden_actions",
    "output_schema",
    "success_criteria",
    "verification",
    "budget",
)


def prompt_contract(
    *,
    task: str,
    role: str,
    goal: str,
    context: Mapping[str, Any] | None = None,
    evidence: Iterable[Any] = (),
    constraints: Iterable[str] = (),
    allowed_tools: Iterable[str] = (),
    allowed_files: Iterable[str] = (),
    forbidden_actions: Iterable[str] = (),
    output_schema: Mapping[str, Any] | None = None,
    success_criteria: Iterable[str] = (),
    verification: Mapping[str, Any] | None = None,
    budget: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    contract = {
        "task": str(task),
        "role": str(role),
        "goal": str(goal),
        "context": dict(context or {}),
        "evidence": list(evidence),
        "constraints": list(constraints),
        "allowed_tools": list(allowed_tools),
        "allowed_files": sorted(set(str(path) for path in allowed_files)),
        "forbidden_actions": list(forbidden_actions),
        "output_schema": dict(output_schema or {}),
        "success_criteria": list(success_criteria),
        "verification": dict(verification or {}),
        "budget": dict(budget or {}),
    }
    return validate_contract(contract)


def validate_contract(contract: Mapping[str, Any]) -> dict[str, Any]:
    missing = [field for field in CONTRACT_FIELDS if field not in contract]
    if missing:
        raise ValueError(f"prompt contract missing fields: {', '.join(missing)}")
    result = dict(contract)
    for field in ("evidence", "constraints", "allowed_tools", "allowed_files", "forbidden_actions", "success_criteria"):
        if not isinstance(result[field], list):
            raise ValueError(f"prompt contract field must be a list: {field}")
    for field in ("context", "output_schema", "verification", "budget"):
        if not isinstance(result[field], dict):
            raise ValueError(f"prompt contract field must be an object: {field}")
    if not result["task"] or not result["role"] or not result["goal"]:
        raise ValueError("prompt contract task, role, and goal are required")
    return result


def context_pack(
    task: str,
    *,
    facts: Iterable[Any] = (),
    evidence: Iterable[Any] = (),
    constraints: Iterable[str] = (),
    open_questions: Iterable[str] = (),
    artifacts: Iterable[Any] = (),
) -> dict[str, Any]:
    """Build a compact, provenance-preserving context pack."""

    return {
        "task": str(task),
        "facts": list(facts),
        "evidence": list(evidence),
        "constraints": list(constraints),
        "open_questions": list(open_questions),
        "artifacts": list(artifacts),
    }
