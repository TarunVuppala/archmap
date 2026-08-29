"""Built-in skill manifests with explicit authority and verification contracts."""

from __future__ import annotations

from typing import Any


SKILLS: dict[str, dict[str, Any]] = {
    "impact-analyzer": {
        "name": "impact-analyzer",
        "description": "Explain bounded downstream impact from graph evidence.",
        "inputs": {"id": "graph node ID"},
        "outputs": {"counts": "object", "paths": "array", "risk": "array"},
        "allowed_tools": ["symbol", "neighbors", "blast_radius", "why_path"],
        "required_evidence": ["edge evidence with file, line, and snippet"],
        "verification": "all returned nodes and edges exist in the graph",
        "max_tokens": 8000,
        "max_runtime": 30,
        "side_effects": [],
    },
    "change-planner": {
        "name": "change-planner",
        "description": "Create a bounded implementation envelope.",
        "inputs": {"id_or_intent": "string"},
        "outputs": {"allowed_files": "array", "impacted": "array", "tests_to_run": "array"},
        "allowed_tools": ["search", "blast_radius", "docs_for", "tests_to_run", "sync", "diff_impact"],
        "required_evidence": ["graph paths and source evidence"],
        "verification": "independent graph and schema checks",
        "max_tokens": 12000,
        "max_runtime": 30,
        "side_effects": [],
    },
    "independent-verifier": {
        "name": "independent-verifier",
        "description": "Check a proposed plan against graph state and contracts.",
        "inputs": {"plan": "structured plan envelope"},
        "outputs": {"verified": "boolean", "issues": "array"},
        "allowed_tools": ["symbol", "neighbors", "health"],
        "required_evidence": ["repository and graph state"],
        "verification": "deterministic checks independent of proposal generation",
        "max_tokens": 8000,
        "max_runtime": 30,
        "side_effects": ["journal verification event"],
    },
}


def list_skills() -> list[dict[str, Any]]:
    return [dict(skill) for skill in SKILLS.values()]


def get_skill(name: str) -> dict[str, Any]:
    if name not in SKILLS:
        raise ValueError(f"unknown skill: {name}")
    return dict(SKILLS[name])
