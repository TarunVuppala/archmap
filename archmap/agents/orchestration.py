"""Bounded orchestration and collaboration-room records."""

from __future__ import annotations

import hashlib
from datetime import datetime, timezone
from typing import Any, Mapping

from packages.graph import GraphStore
from .plan import plan_change
from .router import route_task
from .telemetry import record_usage
from .verification import verification_loop


class CollaborationRoom:
    """A journal-friendly room; graph and repository remain authoritative."""

    def __init__(self, task: str, participants: list[str] | None = None):
        self.task = task
        self.participants = participants or ["orchestrator", "independent-verifier"]
        self.proposals: list[dict[str, Any]] = []
        self.decisions: list[dict[str, Any]] = []

    def add_proposal(self, agent: str, proposal: Mapping[str, Any]) -> None:
        self.proposals.append({"agent": agent, "proposal": dict(proposal)})

    def decide(self, reason: str, selected: int = 0) -> dict[str, Any]:
        if not self.proposals:
            raise ValueError("room has no proposals")
        decision = {"selected": selected, "reason": reason, "evidence": self.proposals[selected].get("proposal", {}).get("paths", [])}
        self.decisions.append(decision)
        return decision

    def as_dict(self) -> dict[str, Any]:
        return {"task": self.task, "participants": self.participants, "proposals": self.proposals, "decisions": self.decisions}


def orchestrate(store: GraphStore, task: str, identifier: str | None = None, intent: str | None = None, max_agents: int = 2) -> dict[str, Any]:
    max_agents = max(1, min(int(max_agents), 8))
    run_id = "run_" + hashlib.sha1(f"{task}:{identifier}:{intent}".encode()).hexdigest()[:16]
    room = CollaborationRoom(task)
    route = route_task(task, complexity="strong" if "plan" in task else "auto")
    proposal = plan_change(store, identifier, intent)
    room.add_proposal("change-planner", proposal)
    decision = room.decide("deterministic graph evidence is sufficient for the bounded plan")
    verification = verification_loop(store, proposal, 3)
    usage = {"agent_count": min(max_agents, 2), "model_calls": 0, "input_tokens": 0, "output_tokens": 0, "tool_calls": 4, "latency_ms": 0, "estimated_cost": 0.0}
    record_usage(store, run_id=run_id, task=task, provider=route["provider"], model=route["model"], tool_calls=usage["tool_calls"])
    result = {"ok": verification["ok"], "nodes": proposal["nodes"], "edges": proposal["edges"], "paths": proposal["paths"], "counts": proposal["counts"], "risk": proposal["risk"] + ([] if verification["ok"] else ["verification_failed"]), "evidence_used": proposal["evidence_used"], "run_id": run_id, "room": room.as_dict(), "decision": decision, "verification": verification, "model_route": route, "usage": usage, "status": "completed" if verification["ok"] else "blocked", "updated_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")}
    store.append_journal("agent_run", {"run_id": run_id, "role": "orchestrator", "task": task, "inputs": [identifier or intent], "outputs": ["plan_change"], "evidence": proposal["paths"], "decisions": room.decisions, "verification": verification, "model": route["model"], "usage": usage, "status": result["status"]})
    return result


def debate(room: CollaborationRoom, proposals: list[Mapping[str, Any]]) -> dict[str, Any]:
    """Select the first proposal with graph paths and evidence, then record why."""

    for index, proposal in enumerate(proposals):
        if proposal.get("paths") and proposal.get("evidence_used"):
            room.add_proposal(f"proposal-{index + 1}", proposal)
    if not room.proposals:
        raise ValueError("no evidence-backed proposal available")
    return room.decide("selected the first proposal with verifiable graph paths")
