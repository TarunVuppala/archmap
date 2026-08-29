"""Deterministic graph health checks and inference circuit breaker."""

from __future__ import annotations

import hashlib
import json
from typing import Iterable

from packages.graph import GraphStore


def health_report(store: GraphStore) -> dict:
    conflict_count = store.connection.execute("SELECT COUNT(*) FROM edges WHERE conflict = 1").fetchone()[0]
    orphan_count = store.connection.execute(
        """
        SELECT COUNT(*) FROM edges e
        WHERE NOT EXISTS (SELECT 1 FROM nodes n WHERE n.id = e.from_id)
           OR NOT EXISTS (SELECT 1 FROM nodes n WHERE n.id = e.to_id)
        """
    ).fetchone()[0]
    issues = []
    if conflict_count:
        issues.append({"key": "conflict_edges", "count": conflict_count})
    if orphan_count:
        issues.append({"key": "orphan_edges", "count": orphan_count})
    state = store.list_health()
    paused = state.get("inference_paused", False)
    if paused:
        issues.append({"key": "inference_paused", "value": paused})
    return {
        "ok": not issues,
        "nodes": [],
        "edges": [],
        "paths": [],
        "counts": {"conflict_edges": conflict_count, "orphan_edges": orphan_count},
        "risk": [item["key"] for item in issues],
        "evidence_used": True,
        "health": state,
        "issues": issues,
    }


def record_identity_observation(store: GraphStore, fingerprint: str, service_ids: Iterable[str]) -> dict:
    identity_hash = hashlib.sha256(json.dumps(sorted(service_ids)).encode()).hexdigest()
    previous = store.get_health("identity_observation") or {}
    thrash_count = 0
    if previous.get("fingerprint") == fingerprint and previous.get("identity_hash") != identity_hash:
        thrash_count = int(previous.get("thrash_count", 0)) + 1
    observation = {"fingerprint": fingerprint, "identity_hash": identity_hash, "thrash_count": thrash_count}
    store.set_health("identity_observation", observation)
    paused = bool(store.get_health("inference_paused")) or thrash_count >= 3
    store.set_health("inference_paused", paused)
    if paused:
        store.append_journal("health", {"key": "inference_paused", "fingerprint": fingerprint, "thrash_count": thrash_count})
    return {"paused": paused, **observation}
