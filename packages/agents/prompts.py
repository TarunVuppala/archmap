"""Versioned prompt proposals with explicit review and safe application."""

from __future__ import annotations

import difflib
import hashlib
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping

from packages.graph import GraphError, GraphStore


PROTECTED_TERMS = (
    "evidence",
    "verification",
    "AGENTS.md",
    "security",
    "allowed_tools",
    "allowed_files",
)
FORBIDDEN_PATTERNS = (
    "ignore previous instructions",
    "override agents.md",
    "disable verification",
    "invent edges",
    "upload the whole repository",
)


def prompt_catalog() -> list[dict[str, Any]]:
    """Return the built-in prompt manifest without exposing mutable state."""

    return [
        _manifest("impact-analyzer", "Explain bounded impact using only graph evidence.", 1),
        _manifest("change-planner", "Create a bounded implementation envelope from verified graph paths.", 1),
        _manifest("independent-verifier", "Reject agent output that cannot be checked against repository state.", 1),
    ]


def propose_prompt_change(
    name: str,
    current: str,
    proposed: str,
    reason: str,
    *,
    proposer: str = "prompt-agent",
    current_version: int = 1,
    current_file: str | None = None,
) -> dict[str, Any]:
    current = str(current)
    proposed = str(proposed)
    if not name.strip() or not current.strip() or not proposed.strip() or not reason.strip():
        raise GraphError("prompt name, current content, proposed content, and reason are required")
    issues = _safety_issues(current, proposed)
    current_hash = _hash(current)
    proposed_hash = _hash(proposed)
    proposal_id = "prompt_" + hashlib.sha256(f"{name}\0{current_hash}\0{proposed_hash}".encode()).hexdigest()[:16]
    diff = "".join(difflib.unified_diff(current.splitlines(True), proposed.splitlines(True), fromfile="current", tofile="proposed"))
    return {
        "id": proposal_id,
        "name": name.strip(),
        "from_version": max(1, int(current_version)),
        "to_version": max(1, int(current_version)) + 1,
        "current_hash": current_hash,
        "proposed_hash": proposed_hash,
        "proposed_content": proposed,
        "current_file": current_file,
        "reason": reason.strip()[:2000],
        "proposer": proposer.strip() or "prompt-agent",
        "diff": diff[:30000],
        "safety_issues": issues,
        "status": "rejected" if issues else "needs_review",
        "approval_required": True,
        "approved": False,
        "created_at": _now(),
    }


def review_prompt_proposal(proposal: Mapping[str, Any], reviewer: str, approved: bool, note: str = "") -> dict[str, Any]:
    """Review a proposal; a proposer cannot approve their own change."""

    result = dict(proposal)
    _validate_proposal(result)
    reviewer = str(reviewer).strip()
    if not reviewer:
        raise GraphError("reviewer is required")
    if reviewer == result.get("proposer"):
        raise GraphError("proposal requires an independent reviewer")
    if result.get("safety_issues"):
        approved = False
    result.update({
        "reviewer": reviewer,
        "review_note": str(note)[:2000],
        "approved": bool(approved),
        "status": "approved" if approved else "rejected",
        "reviewed_at": _now(),
    })
    return result


def apply_prompt_proposal(
    workspace: str | Path,
    proposal: Mapping[str, Any],
    target_file: str | Path,
    approver: str,
    *,
    store: GraphStore | None = None,
) -> dict[str, Any]:
    """Apply only an approved, hash-matching prompt update inside the workspace."""

    result = dict(proposal)
    _validate_proposal(result)
    if result.get("status") != "approved" or not result.get("approved"):
        raise GraphError("prompt proposal requires explicit approval before application")
    if str(approver).strip() != result.get("reviewer"):
        raise GraphError("application approver must match the recorded reviewer")
    root = Path(workspace).resolve()
    path = Path(target_file)
    if not path.is_absolute():
        path = root / path
    path = path.resolve()
    try:
        relative = path.relative_to(root).as_posix()
    except ValueError as error:
        raise GraphError("prompt target must be inside workspace") from error
    _validate_target(relative)
    if result.get("current_file") and result["current_file"] != relative:
        raise GraphError("prompt target does not match the proposed current_file")
    if not path.is_file():
        raise GraphError(f"prompt target does not exist: {relative}")
    current = path.read_text(encoding="utf-8")
    if _hash(current) != result["current_hash"]:
        raise GraphError("prompt target changed since proposal; create a new proposal")
    proposed = _content_from_diff_or_proposal(result)
    safety_issues = _safety_issues(current, proposed)
    if safety_issues:
        raise GraphError("prompt proposal fails safety checks: " + "; ".join(safety_issues))
    if _hash(proposed) != result["proposed_hash"]:
        raise GraphError("proposal content hash does not match the approved proposal")
    path.write_text(proposed, encoding="utf-8")
    update = {"proposal_id": result["id"], "name": result["name"], "target_file": relative, "from_version": result["from_version"], "to_version": result["to_version"], "current_hash": result["current_hash"], "proposed_hash": result["proposed_hash"], "reviewer": result["reviewer"], "status": "applied"}
    if store is not None:
        store.append_journal("prompt_update", update)
    return {"ok": True, "nodes": [], "edges": [], "paths": [], "counts": {"prompt_updates": 1}, "risk": [], "evidence_used": True, "update": update}


def record_prompt_proposal(store: GraphStore, proposal: Mapping[str, Any]) -> dict[str, Any]:
    _validate_proposal(proposal)
    payload = {key: value for key, value in proposal.items() if key not in {"diff", "proposed_content"}}
    payload["diff_hash"] = _hash(str(proposal.get("diff", "")))
    store.append_journal("prompt_proposal", payload)
    return {"ok": True, "nodes": [], "edges": [], "paths": [], "counts": {"prompt_proposals": 1}, "risk": ["prompt_review_required"], "evidence_used": True, "proposal": dict(proposal)}


def _validate_proposal(proposal: Mapping[str, Any]) -> None:
    required = {"id", "name", "from_version", "to_version", "current_hash", "proposed_hash", "diff", "safety_issues", "status", "proposer"}
    missing = sorted(required.difference(proposal))
    if missing:
        raise GraphError(f"prompt proposal missing fields: {', '.join(missing)}")
    if proposal["status"] not in {"needs_review", "approved", "rejected", "applied"}:
        raise GraphError("invalid prompt proposal status")
    if not isinstance(proposal["safety_issues"], list):
        raise GraphError("prompt safety_issues must be a list")
    if "proposed_content" in proposal and _hash(str(proposal["proposed_content"])) != proposal["proposed_hash"]:
        raise GraphError("prompt proposed_content hash does not match proposal")


def _safety_issues(current: str, proposed: str) -> list[str]:
    lowered = proposed.lower()
    issues = [f"forbidden phrase: {pattern}" for pattern in FORBIDDEN_PATTERNS if pattern in lowered]
    for term in PROTECTED_TERMS:
        if term.lower() in current.lower() and term.lower() not in lowered:
            issues.append(f"protected constraint removed: {term}")
    return issues


def _validate_target(relative: str) -> None:
    parts = Path(relative).parts
    if Path(relative).name == "AGENTS.md" or ".git" in parts or any(part in {"secrets", ".archmap"} for part in parts):
        raise GraphError("protected prompt target")
    if Path(relative).name.startswith(".env"):
        raise GraphError("secret-like prompt target")


def _content_from_diff_or_proposal(proposal: Mapping[str, Any]) -> str:
    content = proposal.get("proposed_content")
    if not isinstance(content, str) or not content:
        raise GraphError("approved proposal must include proposed_content before application")
    return content


def _manifest(name: str, description: str, version: int) -> dict[str, Any]:
    content = description + "\nUse only verified repository evidence.\n"
    return {"name": name, "version": version, "description": description, "content_hash": _hash(content), "approval_required": True}


def _hash(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
