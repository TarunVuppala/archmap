# Architecture Mapper

`archmap` is a single, install-once command that maps any codebase into one
evidence-backed knowledge graph and answers:

> If I change this piece of code, what else is affected, and why?

It is a pure TypeScript/Node npm package. The CLI, MCP server, localhost HTTP
daemon, and the visualizer are all thin clients over one Core — they never
reimplement graph or impact logic. Everything works deterministically with no
AI configured; an optional, provider-neutral LLM only ever narrates or names.

## Install

```bash
npm install -g archmap     # global `archmap` command
# or, no install:
npx archmap <command>
```

Requires Node.js 18+. Uses `better-sqlite3` for the local graph and prebuilt
`tree-sitter` WASM grammars for parsing (no native build step).

## Quick start

```bash
cd /path/to/any/repo
archmap init                 # create .archmap/, index the repo, write
                             #   .gitignore entries + .mcp.json + seed.yaml
archmap impact fn:src/service.ts:processPayment --json
archmap ui                   # open the visualizer on http://127.0.0.1:4173
```

## Commands

Every command supports `--json`. Common flags: `--workspace <path>`, `--db <path>`.

| Command | What it does |
|---|---|
| `init [path]` | one-shot: index the repo + write `.archmap/`, `.gitignore`, `.mcp.json`, `seed.yaml` (`--daemon` to also hint the daemon) |
| `sync [path]` | re-index the workspace (also used by the optional git hook) |
| `impact <id>` | bounded blast radius + evidence-backed why-paths + risk chips |
| `diff [base] [head]` | symbol-level diff impact |
| `flow <id>` | reconstruct an ordered, evidence-backed flow |
| `graph` | export a bounded graph view (JSON) |
| `search <q>` | graph + RAG lexical search |
| `symbol <id>` / `neighbors <id>` | a node and its neighbors |
| `why_path <from> <to>` | evidence-backed paths between two nodes |
| `tests_to_run <id>` | tests reachable from a change + an inferred command |
| `health` / `validate_graph` | graph consistency and inference health |
| `evaluate_policy <id>` | built-in policy warnings for a change |
| `plan_change <id>` | bounded mutation envelope (allowed files, impacted, tests, policies) |
| `orchestrate <id>` | deterministic plan → verify workflow |
| `route <task>` | capability/cost tier selection (provider-neutral) |
| `narrate <id>` | impact narration (LLM if configured, else deterministic) |
| `pin --type T --from A --to B` | add a user-confirmed edge |
| `hook` | install a git pre-commit hook that runs `archmap sync` |
| `ui` | serve the localhost visualizer (height / depth / flow views, Mermaid) |
| `mcp` | run the MCP server over stdio |
| `serve` | run the localhost HTTP daemon (`/v1/<operation>`) |

## How it works

- **One graph of record** — SQLite at `.archmap/index.db`. Nodes (File,
  Function, Class, API, Table, External, Test, …) and edges (CALLS, IMPORTS,
  EXPOSES, CONSUMES, READS/WRITES, DEPENDS_ON, …). Every edge carries evidence
  (file, line, snippet) or an explicit user/agent pin. Logical edges stay a
  single row; conflicting writers set `conflict: true` and keep both blobs.
- **Layered parser** — tree-sitter gives rich extraction (symbols, calls,
  imports, routes, SQL) for TS/JS, Python, and Java; any other language falls
  back to universal structural parsing so nothing is a dead end. Manifests feed
  External/Doc nodes.
- **Bounded, explainable impact** — impact is paths + evidence (depth ≤ 5, ≤ 7
  why-paths) with counts and risk chips, never just a file list.
- **Optional LLM** — set `ARCHMAP_LLM_BASE_URL` + `ARCHMAP_LLM_MODEL` (and
  optionally `ARCHMAP_LLM_API_KEY`) to enable narration against any
  OpenAI-compatible endpoint (local or cloud). Impact, flows, and search work
  fully without it.

## Develop

```bash
npm install
npm run build      # tsc -> dist/
npm test           # tsx --test test/**/*.test.ts
```

See [AGENTS.md](AGENTS.md) for the authoritative specification and constraints.
