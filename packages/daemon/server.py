"""Localhost HTTP transport over the same operations used by CLI and MCP."""

from __future__ import annotations

import json
import os
import signal
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

from packages.agents import orchestrate, plan_change, route_task, usage_summary
from packages.agents.queries import search_symbols, symbol, tests_to_run, why_path
from packages.agents.prompts import apply_prompt_proposal, prompt_catalog, propose_prompt_change, record_prompt_proposal, review_prompt_proposal
from packages.agents.telemetry import record_event
from packages.diff.impact import diff_impact, git_diff
from packages.docs import resolve_docs
from packages.graph import GraphError, GraphStore
from packages.seed import apply_pin
from packages.seed.health import health_report
from packages.sync import sync_workspace
from packages.visualize import render_graph


class ArchitectureHTTPServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, address, workspace: Path, database: Path):
        self.workspace = workspace
        self.database = database
        super().__init__(address, _RequestHandler)

    def dispatch(self, operation: str, arguments: dict[str, Any]) -> dict[str, Any]:
        workspace_arg = Path(arguments.get("workspace", self.workspace))
        workspace = (self.workspace / workspace_arg).resolve() if not workspace_arg.is_absolute() else workspace_arg.resolve()
        database_arg = arguments.get("db")
        if database_arg is None:
            database = self.database if workspace == self.workspace else workspace / ".archmap" / "index.db"
        else:
            database_path = Path(database_arg)
            database = database_path if database_path.is_absolute() else workspace / database_path

        if operation == "sync":
            return sync_workspace(workspace, database, bool(arguments.get("force", False)))
        if operation == "docs_for":
            return resolve_docs(
                workspace,
                database,
                arguments.get("name") or arguments.get("id"),
                arguments.get("version"),
                bool(arguments.get("fetch", True)),
            )
        if operation == "health":
            with GraphStore(database, workspace) as store:
                return health_report(store)
        if operation == "pin":
            with GraphStore(database, workspace) as store:
                edge = apply_pin(store, arguments.get("type"), arguments.get("from"), arguments.get("to"), arguments.get("note"))
            return {"ok": True, "nodes": [], "edges": [edge], "paths": [], "counts": {}, "risk": [], "evidence_used": True}
        if operation == "route":
            return {"ok": True, "nodes": [], "edges": [], "paths": [], "counts": {}, "risk": [], "evidence_used": True, "route": route_task(arguments.get("task", ""), complexity=arguments.get("complexity", "auto"), context_tokens=int(arguments.get("context_tokens", 0)), security_sensitive=bool(arguments.get("security_sensitive", False)))}
        if operation == "open_graph":
            return {"ok": False, "error": "IDE is not attached", "nodes": [], "edges": [], "paths": [], "counts": {}, "risk": [], "evidence_used": True, "id": arguments.get("id")}
        if operation == "prompt_catalog":
            return {"ok": True, "nodes": [], "edges": [], "paths": [], "counts": {"prompts": len(prompt_catalog())}, "risk": [], "evidence_used": True, "prompts": prompt_catalog()}
        if operation == "prompt_propose":
            proposal = propose_prompt_change(arguments.get("name", ""), arguments.get("current", ""), arguments.get("proposed", ""), arguments.get("reason", ""), proposer=arguments.get("proposer", "prompt-agent"), current_version=int(arguments.get("current_version", 1)), current_file=arguments.get("current_file"))
            with GraphStore(database, workspace) as store:
                return record_prompt_proposal(store, proposal)
        if operation == "prompt_review":
            proposal = arguments.get("proposal")
            if not isinstance(proposal, dict):
                raise GraphError("proposal must be an object")
            reviewed = review_prompt_proposal(proposal, arguments.get("reviewer", ""), bool(arguments.get("approved", False)), arguments.get("note", ""))
            with GraphStore(database, workspace) as store:
                store.append_journal("prompt_review", {"proposal_id": reviewed["id"], "reviewer": reviewed["reviewer"], "approved": reviewed["approved"], "status": reviewed["status"]})
            return {"ok": True, "nodes": [], "edges": [], "paths": [], "counts": {"prompt_reviews": 1}, "risk": [] if reviewed["approved"] else ["prompt_rejected"], "evidence_used": True, "proposal": reviewed}
        if operation == "prompt_apply":
            proposal = arguments.get("proposal")
            if not isinstance(proposal, dict):
                raise GraphError("proposal must be an object")
            with GraphStore(database, workspace) as store:
                return apply_prompt_proposal(workspace, proposal, arguments.get("target_file", ""), arguments.get("approver", ""), store=store)
        with GraphStore(database, workspace) as store:
            if operation == "search":
                return search_symbols(store, arguments.get("q", ""), arguments.get("kind"), int(arguments.get("limit", 20)))
            if operation == "symbol":
                return symbol(store, arguments.get("id", ""))
            if operation == "neighbors":
                return store.neighbors(arguments.get("id", ""), arguments.get("direction", "both"))
            if operation == "why_path":
                return why_path(store, arguments.get("from", ""), arguments.get("to", ""))
            if operation == "tests_to_run":
                return tests_to_run(store, arguments.get("id", ""))
            if operation == "plan_change":
                return plan_change(store, arguments.get("id"), arguments.get("intent"))
            if operation == "orchestrate":
                return orchestrate(store, arguments.get("task", ""), arguments.get("id"), arguments.get("intent"), int(arguments.get("max_agents", 2)))
            if operation == "record_event":
                payload = arguments.get("payload")
                if not isinstance(payload, dict):
                    raise GraphError("payload must be an object")
                return record_event(store, arguments.get("event"), payload)
            if operation == "usage":
                return usage_summary(store)
            if operation == "graph":
                payload = {
                    "ok": True,
                    "nodes": store.list_nodes(int(arguments.get("node_limit", 50))),
                    "edges": store.list_edges(int(arguments.get("edge_limit", 100))),
                    "paths": [],
                    "counts": {},
                    "risk": [],
                    "evidence_used": True,
                }
                return render_graph(payload, arguments.get("view", "architecture"), arguments.get("format", "json"))
            if operation == "blast_radius":
                if not arguments.get("id"):
                    raise GraphError("id is required")
                return store.impact(
                    arguments["id"],
                    arguments.get("direction", "downstream"),
                    int(arguments.get("depth", 5)),
                    int(arguments.get("max_paths", 7)),
                )
            if operation == "diff_impact":
                base = arguments.get("base", "main")
                head = arguments.get("head", "HEAD")
                diff_text = arguments.get("diff_text")
                if diff_text is None:
                    diff_text = git_diff(workspace, base, head)
                return diff_impact(store, workspace, diff_text, base, head)
        raise GraphError(f"unknown operation: {operation}")


class _RequestHandler(BaseHTTPRequestHandler):
    server: ArchitectureHTTPServer

    def do_GET(self) -> None:  # noqa: N802
        if self.path != "/health":
            self._write(404, {"ok": False, "error": "not found"})
            return
        self._write(200, {"ok": True, "service": "architecture-mapper", "port": self.server.server_port})

    def do_POST(self) -> None:  # noqa: N802
        if not self.path.startswith("/v1/"):
            self._write(404, {"ok": False, "error": "not found"})
            return
        operation = self.path.removeprefix("/v1/").rstrip("/")
        try:
            length = int(self.headers.get("Content-Length", "0"))
            arguments = json.loads(self.rfile.read(length) or b"{}")
            if not isinstance(arguments, dict):
                raise ValueError("request body must be a JSON object")
            payload = self.server.dispatch(operation, arguments)
            self._write(200, payload)
        except (GraphError, OSError, TypeError, ValueError) as error:
            self._write(400, _error_payload(str(error)))

    def log_message(self, *_: object) -> None:
        return

    def _write(self, status: int, payload: dict[str, Any]) -> None:
        body = json.dumps(payload, sort_keys=True).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def create_server(workspace: str | Path = ".", database: str | Path | None = None, port: int = 0) -> ArchitectureHTTPServer:
    root = Path(workspace).resolve()
    if not root.is_dir():
        raise ValueError(f"workspace is not a directory: {workspace}")
    if database is None:
        db_path = root / ".archmap" / "index.db"
    else:
        candidate = Path(database)
        db_path = candidate if candidate.is_absolute() else root / candidate
    return ArchitectureHTTPServer(("127.0.0.1", port), root, db_path)


def run_daemon(workspace: str | Path = ".", database: str | Path | None = None, port: int = 0) -> None:
    server = create_server(workspace, database, port)
    def stop(_signum, _frame):
        threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    state_path = server.workspace / ".archmap" / "daemon.json"
    state_path.parent.mkdir(parents=True, exist_ok=True)
    state = {"pid": os.getpid(), "port": server.server_port}
    state_path.write_text(json.dumps(state, indent=2) + "\n", encoding="utf-8")
    try:
        server.serve_forever()
    finally:
        server.server_close()
        try:
            current = json.loads(state_path.read_text(encoding="utf-8"))
            if current == state:
                state_path.unlink()
        except (FileNotFoundError, OSError, ValueError):
            pass


def _error_payload(message: str) -> dict[str, Any]:
    return {
        "ok": False,
        "error": message,
        "nodes": [],
        "edges": [],
        "paths": [],
        "counts": {},
        "risk": [],
        "evidence_used": False,
    }
