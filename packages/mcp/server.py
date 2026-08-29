"""Minimal dependency-free MCP stdio server.

The server deliberately delegates to the same Python operations used by the
CLI. MCP clients therefore receive the same graph IDs and JSON payloads.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any, TextIO

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


PROTOCOL_VERSION = "2024-11-05"
SERVER_INFO = {"name": "architecture-mapper", "version": "0.1.0"}
TOOL_DEFINITIONS = [
    {
        "name": "sync",
        "description": "Synchronize workspace source files into the Architecture Mapper graph.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "workspace": {"type": "string", "description": "Workspace path; defaults to the server workspace."},
                "db": {"type": "string", "description": "SQLite path, relative to workspace by default."},
                "force": {"type": "boolean"},
            },
        },
    },
    {
        "name": "blast_radius",
        "description": "Calculate bounded, evidence-backed downstream or upstream graph impact.",
        "inputSchema": {
            "type": "object",
            "required": ["id"],
            "properties": {
                "id": {"type": "string"},
                "workspace": {"type": "string"},
                "db": {"type": "string"},
                "direction": {"type": "string", "enum": ["downstream", "upstream"]},
                "depth": {"type": "integer", "minimum": 0, "maximum": 5},
                "max_paths": {"type": "integer", "minimum": 1, "maximum": 7},
            },
        },
    },
    {
        "name": "diff_impact",
        "description": "Classify Git symbol changes and calculate their union impact.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "workspace": {"type": "string"},
                "db": {"type": "string"},
                "base": {"type": "string", "default": "main"},
                "head": {"type": "string", "default": "HEAD"},
                "diff_text": {"type": "string", "description": "Optional unified diff for callers that already have one."},
            },
        },
    },
    {
        "name": "docs_for",
        "description": "Resolve official versioned documentation for a lockfile package.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "name": {"type": "string"},
                "id": {"type": "string"},
                "version": {"type": "string"},
                "workspace": {"type": "string"},
                "db": {"type": "string"},
                "fetch": {"type": "boolean", "default": True},
            },
        },
    },
    {
        "name": "pin",
        "description": "Add a user-confirmed edge to the single graph.",
        "inputSchema": {
            "type": "object",
            "required": ["type", "from", "to"],
            "properties": {
                "type": {"type": "string"},
                "from": {"type": "string"},
                "to": {"type": "string"},
                "note": {"type": "string"},
                "workspace": {"type": "string"},
                "db": {"type": "string"},
            },
        },
    },
    {
        "name": "health",
        "description": "Report graph consistency and inference health.",
        "inputSchema": {"type": "object", "properties": {"workspace": {"type": "string"}, "db": {"type": "string"}}},
    },
    {
        "name": "search",
        "description": "Search graph-linked code and documentation chunks.",
        "inputSchema": {"type": "object", "required": ["q"], "properties": {"q": {"type": "string"}, "kind": {"type": "string"}, "limit": {"type": "integer"}, "workspace": {"type": "string"}, "db": {"type": "string"}}},
    },
    {
        "name": "symbol",
        "description": "Return a symbol and its bounded graph neighbors.",
        "inputSchema": {"type": "object", "required": ["id"], "properties": {"id": {"type": "string"}, "workspace": {"type": "string"}, "db": {"type": "string"}}},
    },
    {
        "name": "neighbors",
        "description": "Return bounded graph neighbors for a node.",
        "inputSchema": {"type": "object", "required": ["id"], "properties": {"id": {"type": "string"}, "direction": {"type": "string"}, "workspace": {"type": "string"}, "db": {"type": "string"}}},
    },
    {
        "name": "why_path",
        "description": "Find evidence-backed paths between two graph nodes.",
        "inputSchema": {"type": "object", "required": ["from", "to"], "properties": {"from": {"type": "string"}, "to": {"type": "string"}, "workspace": {"type": "string"}, "db": {"type": "string"}}},
    },
    {
        "name": "tests_to_run",
        "description": "Find tests and inferred commands for a graph node.",
        "inputSchema": {"type": "object", "required": ["id"], "properties": {"id": {"type": "string"}, "workspace": {"type": "string"}, "db": {"type": "string"}}},
    },
    {
        "name": "plan_change",
        "description": "Create a bounded, evidence-backed change envelope.",
        "inputSchema": {"type": "object", "properties": {"id": {"type": "string"}, "intent": {"type": "string"}, "workspace": {"type": "string"}, "db": {"type": "string"}}},
    },
    {
        "name": "record_event",
        "description": "Record an allowlisted incident, agent, verification, or usage event.",
        "inputSchema": {"type": "object", "required": ["event", "payload"], "properties": {"event": {"type": "string"}, "payload": {"type": "object"}, "workspace": {"type": "string"}, "db": {"type": "string"}}},
    },
    {
        "name": "usage",
        "description": "Summarize journaled agent usage and estimated cost.",
        "inputSchema": {"type": "object", "properties": {"workspace": {"type": "string"}, "db": {"type": "string"}}},
    },
    {
        "name": "route",
        "description": "Select the cheapest capable provider-neutral model route.",
        "inputSchema": {"type": "object", "required": ["task"], "properties": {"task": {"type": "string"}, "complexity": {"type": "string"}, "context_tokens": {"type": "integer"}, "security_sensitive": {"type": "boolean"}}},
    },
    {
        "name": "orchestrate",
        "description": "Run a bounded plan, collaboration decision, and independent verification workflow.",
        "inputSchema": {"type": "object", "required": ["task"], "properties": {"task": {"type": "string"}, "id": {"type": "string"}, "intent": {"type": "string"}, "max_agents": {"type": "integer"}, "workspace": {"type": "string"}, "db": {"type": "string"}}},
    },
    {
        "name": "open_graph",
        "description": "Request IDE focus for a graph node when an editor is attached.",
        "inputSchema": {"type": "object", "required": ["id"], "properties": {"id": {"type": "string"}, "workspace": {"type": "string"}, "db": {"type": "string"}}},
    },
    {
        "name": "prompt_catalog",
        "description": "List versioned built-in prompt manifests.",
        "inputSchema": {"type": "object", "properties": {}},
    },
    {
        "name": "prompt_propose",
        "description": "Create a safety-checked prompt change requiring independent review.",
        "inputSchema": {"type": "object", "required": ["name", "current", "proposed", "reason"], "properties": {"name": {"type": "string"}, "current": {"type": "string"}, "proposed": {"type": "string"}, "reason": {"type": "string"}, "proposer": {"type": "string"}, "current_version": {"type": "integer"}, "current_file": {"type": "string"}, "workspace": {"type": "string"}, "db": {"type": "string"}}},
    },
    {
        "name": "prompt_review",
        "description": "Approve or reject a prompt proposal without applying it.",
        "inputSchema": {"type": "object", "required": ["proposal", "reviewer", "approved"], "properties": {"proposal": {"type": "object"}, "reviewer": {"type": "string"}, "approved": {"type": "boolean"}, "note": {"type": "string"}, "workspace": {"type": "string"}, "db": {"type": "string"}}},
    },
    {
        "name": "prompt_apply",
        "description": "Apply an approved prompt proposal after a hash and path safety check.",
        "inputSchema": {"type": "object", "required": ["proposal", "target_file", "approver"], "properties": {"proposal": {"type": "object"}, "target_file": {"type": "string"}, "approver": {"type": "string"}, "workspace": {"type": "string"}, "db": {"type": "string"}}},
    },
]


class McpServer:
    """Handle MCP JSON-RPC requests against one workspace graph."""

    def __init__(self, workspace: str | Path = ".", database: str | Path | None = None):
        self.workspace = Path(workspace).resolve()
        self.database = database

    def handle(self, message: dict[str, Any]) -> dict[str, Any] | None:
        request_id = message.get("id")
        method = message.get("method")
        if not isinstance(method, str):
            return self._error(request_id, -32600, "method is required")
        if method == "notifications/initialized":
            return None
        if method == "initialize":
            params = message.get("params") or {}
            return self._response(
                request_id,
                {
                    "protocolVersion": params.get("protocolVersion", PROTOCOL_VERSION),
                    "capabilities": {"tools": {}},
                    "serverInfo": SERVER_INFO,
                    "instructions": "Use sync before graph queries when the workspace has changed.",
                },
            )
        if method == "ping":
            return self._response(request_id, {})
        if method == "tools/list":
            return self._response(request_id, {"tools": TOOL_DEFINITIONS})
        if method == "tools/call":
            return self._call_tool(request_id, message.get("params") or {})
        return self._error(request_id, -32601, f"method not found: {method}")

    def _call_tool(self, request_id: Any, params: dict[str, Any]) -> dict[str, Any]:
        name = params.get("name")
        arguments = params.get("arguments") or {}
        if name not in {tool["name"] for tool in TOOL_DEFINITIONS}:
            payload = _error_payload(f"unknown tool: {name}")
            return self._tool_response(request_id, payload)
        if not isinstance(arguments, dict):
            payload = _error_payload("tool arguments must be an object")
            return self._tool_response(request_id, payload)
        try:
            payload = self._dispatch(name, arguments)
        except (GraphError, KeyError, OSError, TypeError, ValueError) as error:
            payload = _error_payload(str(error))
        return self._tool_response(request_id, payload)

    def _dispatch(self, name: str, arguments: dict[str, Any]) -> dict:
        workspace_arg = Path(arguments.get("workspace", self.workspace))
        workspace = (self.workspace / workspace_arg).resolve() if not workspace_arg.is_absolute() else workspace_arg.resolve()
        database = _database_path(workspace, arguments.get("db", self.database))
        if name == "sync":
            return sync_workspace(workspace, database, bool(arguments.get("force", False)))
        if name == "docs_for":
            return resolve_docs(
                workspace,
                database,
                arguments.get("name") or arguments.get("id"),
                arguments.get("version"),
                bool(arguments.get("fetch", True)),
            )
        if name == "health":
            with GraphStore(database, workspace) as store:
                return health_report(store)
        if name == "pin":
            with GraphStore(database, workspace) as store:
                edge = apply_pin(store, arguments.get("type"), arguments.get("from"), arguments.get("to"), arguments.get("note"))
            return {"ok": True, "nodes": [], "edges": [edge], "paths": [], "counts": {}, "risk": [], "evidence_used": True}
        if name == "route":
            return {"ok": True, "nodes": [], "edges": [], "paths": [], "counts": {}, "risk": [], "evidence_used": True, "route": route_task(arguments.get("task", ""), complexity=arguments.get("complexity", "auto"), context_tokens=int(arguments.get("context_tokens", 0)), security_sensitive=bool(arguments.get("security_sensitive", False)))}
        if name == "orchestrate":
            with GraphStore(database, workspace) as store:
                return orchestrate(store, arguments.get("task", ""), arguments.get("id"), arguments.get("intent"), int(arguments.get("max_agents", 2)))
        if name == "open_graph":
            return {"ok": False, "error": "IDE is not attached", "nodes": [], "edges": [], "paths": [], "counts": {}, "risk": [], "evidence_used": True, "id": arguments.get("id")}
        if name == "prompt_catalog":
            return {"ok": True, "nodes": [], "edges": [], "paths": [], "counts": {"prompts": len(prompt_catalog())}, "risk": [], "evidence_used": True, "prompts": prompt_catalog()}
        if name == "prompt_propose":
            proposal = propose_prompt_change(arguments.get("name", ""), arguments.get("current", ""), arguments.get("proposed", ""), arguments.get("reason", ""), proposer=arguments.get("proposer", "prompt-agent"), current_version=int(arguments.get("current_version", 1)), current_file=arguments.get("current_file"))
            with GraphStore(database, workspace) as store:
                return record_prompt_proposal(store, proposal)
        if name == "prompt_review":
            proposal = arguments.get("proposal")
            if not isinstance(proposal, dict):
                raise GraphError("proposal must be an object")
            reviewed = review_prompt_proposal(proposal, arguments.get("reviewer", ""), bool(arguments.get("approved", False)), arguments.get("note", ""))
            with GraphStore(database, workspace) as store:
                store.append_journal("prompt_review", {"proposal_id": reviewed["id"], "reviewer": reviewed["reviewer"], "approved": reviewed["approved"], "status": reviewed["status"]})
            return {"ok": True, "nodes": [], "edges": [], "paths": [], "counts": {"prompt_reviews": 1}, "risk": [] if reviewed["approved"] else ["prompt_rejected"], "evidence_used": True, "proposal": reviewed}
        if name == "prompt_apply":
            proposal = arguments.get("proposal")
            if not isinstance(proposal, dict):
                raise GraphError("proposal must be an object")
            with GraphStore(database, workspace) as store:
                return apply_prompt_proposal(workspace, proposal, arguments.get("target_file", ""), arguments.get("approver", ""), store=store)
        if name == "record_event":
            payload = arguments.get("payload")
            if not isinstance(payload, dict):
                raise GraphError("payload must be an object")
            with GraphStore(database, workspace) as store:
                return record_event(store, arguments.get("event"), payload)
        if name == "usage":
            with GraphStore(database, workspace) as store:
                return usage_summary(store)
        with GraphStore(database, workspace) as store:
            if name == "search":
                return search_symbols(store, arguments.get("q", ""), arguments.get("kind"), int(arguments.get("limit", 20)))
            if name == "symbol":
                return symbol(store, arguments.get("id", ""))
            if name == "neighbors":
                return store.neighbors(arguments.get("id", ""), arguments.get("direction", "both"))
            if name == "why_path":
                return why_path(store, arguments.get("from", ""), arguments.get("to", ""))
            if name == "tests_to_run":
                return tests_to_run(store, arguments.get("id", ""))
            if name == "plan_change":
                return plan_change(store, arguments.get("id"), arguments.get("intent"))
            if name == "blast_radius":
                if not arguments.get("id"):
                    raise GraphError("id is required")
                return store.impact(
                    arguments["id"],
                    arguments.get("direction", "downstream"),
                    int(arguments.get("depth", 5)),
                    int(arguments.get("max_paths", 7)),
                )
            base = arguments.get("base", "main")
            head = arguments.get("head", "HEAD")
            diff_text = arguments.get("diff_text")
            if diff_text is None:
                diff_text = git_diff(workspace, base, head)
            return diff_impact(store, workspace, diff_text, base, head)

    @staticmethod
    def _response(request_id: Any, result: dict[str, Any]) -> dict[str, Any]:
        return {"jsonrpc": "2.0", "id": request_id, "result": result}

    def _tool_response(self, request_id: Any, payload: dict) -> dict[str, Any]:
        content = {"type": "text", "text": json.dumps(payload, sort_keys=True)}
        return self._response(
            request_id,
            {
                "content": [content],
                "structuredContent": payload,
                "isError": not payload.get("ok", False),
            },
        )

    @staticmethod
    def _error(request_id: Any, code: int, message: str) -> dict[str, Any]:
        return {"jsonrpc": "2.0", "id": request_id, "error": {"code": code, "message": message}}


def run_stdio(
    workspace: str | Path = ".",
    database: str | Path | None = None,
    input_stream: TextIO | None = None,
    output_stream: TextIO | None = None,
) -> int:
    """Serve newline-delimited MCP JSON-RPC messages over stdin/stdout."""

    input_stream = input_stream or sys.stdin
    output_stream = output_stream or sys.stdout
    server = McpServer(workspace, database)
    while True:
        message = _read_message(input_stream)
        if message is None:
            return 0
        try:
            request = json.loads(message)
            response = server.handle(request)
        except json.JSONDecodeError as error:
            response = server._error(None, -32700, f"invalid JSON: {error.msg}")
        if response is not None:
            output_stream.write(json.dumps(response, sort_keys=True) + "\n")
            output_stream.flush()


def _read_message(input_stream: TextIO) -> str | None:
    first_line = input_stream.readline()
    if not first_line:
        return None
    if first_line.lower().startswith("content-length:"):
        length = int(first_line.split(":", 1)[1].strip())
        while True:
            header = input_stream.readline()
            if not header or header in {"\n", "\r\n"}:
                break
        return input_stream.read(length)
    return first_line.strip()


def _database_path(workspace: Path, database: str | Path | None) -> Path:
    if database is None:
        return workspace / ".archmap" / "index.db"
    candidate = Path(database)
    return candidate if candidate.is_absolute() else workspace / candidate


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
