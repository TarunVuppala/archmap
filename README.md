# Architecture Mapper

Architecture Mapper is a local-first tool for building an evidence-backed graph of a software workspace. It exposes the same operations through the CLI, MCP, and localhost HTTP daemon so developers and AI agents can inspect change impact safely.

## Requirements

- Python 3.10 or newer
- Git for `diff` and change-history features
- Node.js and npm only when building the VS Code webview

No Python dependency installation is required for the current core implementation.

## Quick start

Run commands from this repository root:

```bash
./archmap sync . --json
./archmap health --workspace . --json
./archmap impact fn:path/to/file.py:function_name --json
```

The index is stored locally in `.archmap/index.db`. Generated index, vector, cache, journal, and daemon files are gitignored.

## Common commands

```bash
./archmap sync [workspace] --json       # Parse or incrementally update a workspace
./archmap diff [base] [head] --json     # Report Git symbol and impact changes
./archmap graph --format mermaid --json # Export a bounded graph view
./archmap search <query> --json         # Search graph-linked code and docs
./archmap plan_change --id <node> --json # Create an edit envelope
./archmap orchestrate "review change" --id <node> --json
./archmap pin --type CALLS --from ... --to ... --json
./archmap docs <package> --no-fetch --json
./archmap usage --json                   # Show journaled agent usage/cost
./archmap prompt list --json              # List versioned prompt manifests
./archmap serve                         # Start the localhost daemon
./archmap mcp                           # Run the MCP server over stdio
```

For another workspace, pass `--workspace /absolute/path` to commands that support it. `.mcp.json` provides the portable MCP configuration.

## Optional seed configuration

Create `.archmap/seed.yaml` when automatic identification is incomplete. Use it for service ownership, external consumers, critical nodes, ignored paths, or confirmed relationship pins. Seed entries are upserted into the same graph; they are not a separate data store.

## VS Code package

The extension starts the local daemon, registers MCP, syncs the workspace, and provides CodeLens plus Map, Impact, Docs, and Health views:

```bash
cd packages/vscode
npm install
npm run build
```

## Tests

Run the full test suite from the root:

```bash
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tests -v
```

## Prompt change safety

Prompt changes use a proposal → independent review → explicit approval → apply workflow. Proposals include a unified diff, version transition, content hashes, and safety checks. Applying a proposal requires the recorded reviewer and an unchanged target file; `AGENTS.md`, secrets, and protected paths cannot be prompt targets.

```bash
./archmap prompt propose --name change-planner \
  --current-file prompts/current.md --proposed-file prompts/proposed.md \
  --reason "clarify output requirements" --json
```

Read [AGENTS.md](AGENTS.md) before changing architecture, graph behavior, APIs, or contributor workflows.
