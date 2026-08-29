"""The initial archmap sync and impact commands."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Sequence

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
        else:
            root = Path(args.workspace).resolve()
            database = Path(args.db) if args.db and Path(args.db).is_absolute() else root / (args.db or ".archmap/index.db")
            with GraphStore(database, root) as store:
                payload = diff_impact(store, root, git_diff(root, args.base, args.head), args.base, args.head)
    except (GraphError, OSError, ValueError) as error:
        payload = {"ok": False, "error": str(error), "nodes": [], "edges": [], "paths": [], "counts": {}, "risk": [], "evidence_used": False}
        _emit(payload)
        return 2
    _emit(payload)
    return 0 if payload.get("ok", False) else 1


def _emit(payload: dict) -> None:
    print(json.dumps(payload, indent=2, sort_keys=True))
