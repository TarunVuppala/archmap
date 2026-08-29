"""The initial archmap sync and impact commands."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Sequence

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


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="archmap", description="Evidence-backed Architecture Mapper")
    commands = parser.add_subparsers(dest="command", required=True)

    sync = commands.add_parser("sync", help="index or incrementally update a workspace")
    sync.add_argument("workspace", nargs="?", default=".")
    sync.add_argument("--db", help="SQLite path, relative to workspace by default")
    sync.add_argument("--force", action="store_true", help="reparse every discovered file")
    sync.add_argument("--json", action="store_true", help="emit the machine-readable JSON envelope")

    impact = commands.add_parser("impact", help="calculate a bounded graph impact report")
    impact.add_argument("id", help="stable graph node ID")
    impact.add_argument("--workspace", default=".")
    impact.add_argument("--db", help="SQLite path, relative to workspace by default")
    impact.add_argument("--direction", choices=("downstream", "upstream"), default="downstream")
    impact.add_argument("--depth", type=int, default=5)
    impact.add_argument("--max-paths", type=int, default=7)
    impact.add_argument("--json", action="store_true", help="emit the machine-readable JSON envelope")

    diff = commands.add_parser("diff", help="classify Git symbol changes and calculate impact")
    diff.add_argument("base", nargs="?", default="main")
    diff.add_argument("head", nargs="?", default="HEAD")
    diff.add_argument("--workspace", default=".")
    diff.add_argument("--db", help="SQLite path, relative to workspace by default")
    diff.add_argument("--json", action="store_true", help="emit the machine-readable JSON envelope")

    docs = commands.add_parser("docs", help="resolve official docs for a lockfile package")
    docs.add_argument("name")
    docs.add_argument("--version")
    docs.add_argument("--workspace", default=".")
    docs.add_argument("--db", help="SQLite path, relative to workspace by default")
    docs.add_argument("--no-fetch", action="store_true", help="only use an existing local docs cache")
    docs.add_argument("--json", action="store_true", help="emit the machine-readable JSON envelope")

    pin = commands.add_parser("pin", help="add a user-confirmed graph edge")
    pin.add_argument("--type", required=True)
    pin.add_argument("--from", dest="from_id", required=True)
    pin.add_argument("--to", dest="to_id", required=True)
    pin.add_argument("--note")
    pin.add_argument("--file")
    pin.add_argument("--line", type=int)
    pin.add_argument("--snippet")
    pin.add_argument("--workspace", default=".")
    pin.add_argument("--db", help="SQLite path, relative to workspace by default")
    pin.add_argument("--json", action="store_true", help="emit the machine-readable JSON envelope")

    health = commands.add_parser("health", help="report graph consistency and inference health")
    health.add_argument("--workspace", default=".")
    health.add_argument("--db", help="SQLite path, relative to workspace by default")
    health.add_argument("--json", action="store_true", help="emit the machine-readable JSON envelope")

    graph = commands.add_parser("graph", help="export the current graph view")
    graph.add_argument("--view", choices=("architecture", "galaxy"), default="architecture")
    graph.add_argument("--format", choices=("json", "mermaid"), default="json")
    graph.add_argument("--workspace", default=".")
    graph.add_argument("--db", help="SQLite path, relative to workspace by default")
    graph.add_argument("--json", action="store_true", help="emit the machine-readable JSON envelope")

    search = commands.add_parser("search", help="search graph-linked code and documentation chunks")
    search.add_argument("q")
    search.add_argument("--kind")
    search.add_argument("--limit", type=int, default=20)
    search.add_argument("--workspace", default=".")
    search.add_argument("--db")
    search.add_argument("--json", action="store_true")

    symbol_cmd = commands.add_parser("symbol", help="show a symbol and its neighbors")
    symbol_cmd.add_argument("id")
    symbol_cmd.add_argument("--workspace", default=".")
    symbol_cmd.add_argument("--db")
    symbol_cmd.add_argument("--json", action="store_true")

    neighbors = commands.add_parser("neighbors", help="show bounded graph neighbors")
    neighbors.add_argument("id")
    neighbors.add_argument("--direction", choices=("upstream", "downstream", "both"), default="both")
    neighbors.add_argument("--workspace", default=".")
    neighbors.add_argument("--db")
    neighbors.add_argument("--json", action="store_true")

    why = commands.add_parser("why_path", help="find evidence-backed paths between nodes")
    why.add_argument("from_id")
    why.add_argument("to_id")
    why.add_argument("--workspace", default=".")
    why.add_argument("--db")
    why.add_argument("--json", action="store_true")

    tests = commands.add_parser("tests_to_run", help="infer tests and commands for a symbol")
    tests.add_argument("id")
    tests.add_argument("--workspace", default=".")
    tests.add_argument("--db")
    tests.add_argument("--json", action="store_true")

    plan = commands.add_parser("plan_change", help="create a bounded change envelope")
    plan.add_argument("--id")
    plan.add_argument("--intent")
    plan.add_argument("--workspace", default=".")
    plan.add_argument("--db")
    plan.add_argument("--json", action="store_true")

    run = commands.add_parser("orchestrate", help="run a bounded plan and verification workflow")
    run.add_argument("task")
    run.add_argument("--id")
    run.add_argument("--intent")
    run.add_argument("--max-agents", type=int, default=2)
    run.add_argument("--workspace", default=".")
    run.add_argument("--db")
    run.add_argument("--json", action="store_true")

    event = commands.add_parser("record_event", help="record an allowlisted agent or runtime event")
    event.add_argument("event", choices=("incident", "coverage", "otel", "stack", "agent_run", "agent_usage", "decision", "verification"))
    event.add_argument("--payload", required=True, help="JSON object payload")
    event.add_argument("--workspace", default=".")
    event.add_argument("--db")
    event.add_argument("--json", action="store_true")

    usage = commands.add_parser("usage", help="summarize journaled agent usage")
    usage.add_argument("--workspace", default=".")
    usage.add_argument("--db")
    usage.add_argument("--json", action="store_true")

    route = commands.add_parser("route", help="select a capability-based model route")
    route.add_argument("task")
    route.add_argument("--complexity", choices=("auto", "simple", "cheap", "complex", "strong"), default="auto")
    route.add_argument("--context-tokens", type=int, default=0)
    route.add_argument("--security-sensitive", action="store_true")
    route.add_argument("--json", action="store_true")

    prompt = commands.add_parser("prompt", help="review and apply versioned prompt proposals")
    prompt_actions = prompt.add_subparsers(dest="prompt_action", required=True)
    prompt_list = prompt_actions.add_parser("list", help="list built-in prompt manifests")
    prompt_list.add_argument("--json", action="store_true")
    prompt_propose = prompt_actions.add_parser("propose", help="create a review-required prompt proposal")
    prompt_propose.add_argument("--name", required=True)
    prompt_propose.add_argument("--current-file", required=True)
    prompt_propose.add_argument("--proposed-file", required=True)
    prompt_propose.add_argument("--reason", required=True)
    prompt_propose.add_argument("--proposer", default="prompt-agent")
    prompt_propose.add_argument("--version", type=int, default=1)
    prompt_propose.add_argument("--workspace", default=".")
    prompt_propose.add_argument("--db")
    prompt_propose.add_argument("--json", action="store_true")
    prompt_review = prompt_actions.add_parser("review", help="approve or reject a prompt proposal")
    prompt_review.add_argument("--proposal-file", required=True)
    prompt_review.add_argument("--reviewer", required=True)
    prompt_review.add_argument("--approve", action="store_true")
    prompt_review.add_argument("--note", default="")
    prompt_review.add_argument("--workspace", default=".")
    prompt_review.add_argument("--db")
    prompt_review.add_argument("--json", action="store_true")
    prompt_apply = prompt_actions.add_parser("apply", help="apply an explicitly approved prompt proposal")
    prompt_apply.add_argument("--proposal-file", required=True)
    prompt_apply.add_argument("--target-file", required=True)
    prompt_apply.add_argument("--approver", required=True)
    prompt_apply.add_argument("--workspace", default=".")
    prompt_apply.add_argument("--db")
    prompt_apply.add_argument("--json", action="store_true")

    mcp = commands.add_parser("mcp", help="serve MCP tools over stdio")
    mcp.add_argument("--workspace", default=".")
    mcp.add_argument("--db", help="SQLite path, relative to workspace by default")

    serve = commands.add_parser("serve", help="start the localhost graph daemon")
    serve.add_argument("--workspace", default=".")
    serve.add_argument("--db", help="SQLite path, relative to workspace by default")
    serve.add_argument("--port", type=int, default=0)

    args = parser.parse_args(argv)
    try:
        if args.command == "mcp":
            from packages.mcp import run_stdio

            return run_stdio(args.workspace, args.db)
        if args.command == "serve":
            from packages.daemon import run_daemon

            run_daemon(args.workspace, args.db, args.port)
            return 0
        if args.command == "prompt" and args.prompt_action == "list":
            payload = {"ok": True, "nodes": [], "edges": [], "paths": [], "counts": {"prompts": len(prompt_catalog())}, "risk": [], "evidence_used": True, "prompts": prompt_catalog()}
            _emit(payload)
            return 0
        if args.command == "sync":
            payload = sync_workspace(args.workspace, args.db, args.force)
        elif args.command == "impact":
            root = Path(args.workspace).resolve()
            database = Path(args.db) if args.db and Path(args.db).is_absolute() else root / (args.db or ".archmap/index.db")
            with GraphStore(database, root) as store:
                payload = store.impact(args.id, args.direction, args.depth, args.max_paths)
        elif args.command == "docs":
            root = Path(args.workspace).resolve()
            payload = resolve_docs(root, args.db, args.name, args.version, not args.no_fetch)
        elif args.command == "pin":
            root = Path(args.workspace).resolve()
            database = Path(args.db) if args.db and Path(args.db).is_absolute() else root / (args.db or ".archmap/index.db")
            evidence = {"file": args.file, "line": args.line, "snippet": args.snippet} if args.file and args.line and args.snippet else None
            with GraphStore(database, root) as store:
                payload = {"ok": True, "nodes": [], "edges": [apply_pin(store, args.type, args.from_id, args.to_id, args.note, evidence)], "paths": [], "counts": {}, "risk": [], "evidence_used": True}
        elif args.command == "health":
            root = Path(args.workspace).resolve()
            database = Path(args.db) if args.db and Path(args.db).is_absolute() else root / (args.db or ".archmap/index.db")
            with GraphStore(database, root) as store:
                payload = health_report(store)
        elif args.command == "graph":
            root = Path(args.workspace).resolve()
            database = Path(args.db) if args.db and Path(args.db).is_absolute() else root / (args.db or ".archmap/index.db")
            with GraphStore(database, root) as store:
                payload = render_graph({"ok": True, "nodes": store.list_nodes(), "edges": store.list_edges(), "paths": [], "counts": {}, "risk": [], "evidence_used": True}, args.view, args.format)
        elif args.command == "route":
            payload = {"ok": True, "nodes": [], "edges": [], "paths": [], "counts": {}, "risk": [], "evidence_used": True, "route": route_task(args.task, complexity=args.complexity, context_tokens=args.context_tokens, security_sensitive=args.security_sensitive)}
        else:
            root = Path(args.workspace).resolve()
            database = Path(args.db) if args.db and Path(args.db).is_absolute() else root / (args.db or ".archmap/index.db")
            with GraphStore(database, root) as store:
                if args.command == "prompt" and args.prompt_action == "propose":
                    current_path = _workspace_path(root, args.current_file)
                    proposed_path = _workspace_path(root, args.proposed_file)
                    proposal = propose_prompt_change(args.name, current_path.read_text(encoding="utf-8"), proposed_path.read_text(encoding="utf-8"), args.reason, proposer=args.proposer, current_version=args.version, current_file=current_path.relative_to(root).as_posix())
                    payload = record_prompt_proposal(store, proposal)
                elif args.command == "prompt" and args.prompt_action == "review":
                    proposal = _load_proposal(args.proposal_file)
                    reviewed = review_prompt_proposal(proposal, args.reviewer, args.approve, args.note)
                    store.append_journal("prompt_review", {"proposal_id": reviewed["id"], "reviewer": reviewed["reviewer"], "approved": reviewed["approved"], "status": reviewed["status"]})
                    payload = {"ok": True, "nodes": [], "edges": [], "paths": [], "counts": {"prompt_reviews": 1}, "risk": [] if reviewed["approved"] else ["prompt_rejected"], "evidence_used": True, "proposal": reviewed}
                elif args.command == "prompt" and args.prompt_action == "apply":
                    proposal = _load_proposal(args.proposal_file)
                    payload = apply_prompt_proposal(root, proposal, args.target_file, args.approver, store=store)
                elif args.command == "search":
                    payload = search_symbols(store, args.q, args.kind, args.limit)
                elif args.command == "symbol":
                    payload = symbol(store, args.id)
                elif args.command == "neighbors":
                    payload = store.neighbors(args.id, args.direction)
                elif args.command == "why_path":
                    payload = why_path(store, args.from_id, args.to_id)
                elif args.command == "tests_to_run":
                    payload = tests_to_run(store, args.id)
                elif args.command == "plan_change":
                    payload = plan_change(store, args.id, args.intent)
                elif args.command == "orchestrate":
                    payload = orchestrate(store, args.task, args.id, args.intent, args.max_agents)
                elif args.command == "record_event":
                    event_payload = json.loads(args.payload)
                    if not isinstance(event_payload, dict):
                        raise ValueError("event payload must be a JSON object")
                    payload = record_event(store, args.event, event_payload)
                elif args.command == "usage":
                    payload = usage_summary(store)
                else:
                    payload = diff_impact(store, root, git_diff(root, args.base, args.head), args.base, args.head)
    except (GraphError, OSError, ValueError) as error:
        payload = {"ok": False, "error": str(error), "nodes": [], "edges": [], "paths": [], "counts": {}, "risk": [], "evidence_used": False}
        _emit(payload)
        return 2
    _emit(payload)
    return 0 if payload.get("ok", False) else 1


def _emit(payload: dict) -> None:
    print(json.dumps(payload, indent=2, sort_keys=True))


def _workspace_path(root: Path, value: str) -> Path:
    path = Path(value)
    path = path if path.is_absolute() else root / path
    path = path.resolve()
    try:
        path.relative_to(root)
    except ValueError as error:
        raise ValueError("prompt file must be inside workspace") from error
    if not path.is_file():
        raise ValueError(f"prompt file does not exist: {path}")
    return path


def _load_proposal(value: str) -> dict:
    proposal = json.loads(Path(value).read_text(encoding="utf-8"))
    if isinstance(proposal, dict) and "id" not in proposal and isinstance(proposal.get("proposal"), dict):
        proposal = proposal["proposal"]
    if not isinstance(proposal, dict):
        raise ValueError("prompt proposal must be a JSON object")
    return proposal
