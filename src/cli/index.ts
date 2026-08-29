#!/usr/bin/env node
/**
 * The single `archmap` command. Every subcommand is a thin client over the
 * Core dispatch (or the bootstrap indexer for init/sync). All support --json.
 */

import { resolve } from "node:path";
import { dispatch, resolvePaths, type DispatchArgs } from "../core/operations.js";
import { errorEnvelope, type Envelope } from "../core/contracts.js";
import { initWorkspace } from "../index/init.js";
import { syncWorkspace } from "../index/indexer.js";

interface ParsedArgs {
  positionals: string[];
  flags: Record<string, string | boolean>;
}

function parse(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!;
    if (token.startsWith("--")) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i += 1;
      } else {
        flags[key] = true;
      }
    } else {
      positionals.push(token);
    }
  }
  return { positionals, flags };
}

function flagStr(flags: Record<string, string | boolean>, key: string): string | undefined {
  const v = flags[key];
  return typeof v === "string" ? v : undefined;
}

export type Writer = (text: string) => void;

function emit(write: Writer, payload: Envelope): void {
  write(JSON.stringify(payload, null, 2) + "\n");
}

const HELP = `archmap - evidence-backed architecture mapping

Usage: archmap <command> [args] [--json]

Commands:
  init [path]                 create .archmap/, index repo, write .gitignore/.mcp.json/seed.yaml
  sync [path]                 re-index the workspace
  impact <id>                 bounded blast radius + why-paths
  diff [base] [head]          symbol-level diff impact
  graph                       export a bounded graph view
  search <query>              graph + RAG search
  symbol <id>                 node + neighbors
  neighbors <id>              adjacent edges/nodes
  why_path <from> <to>        evidence-backed paths
  tests_to_run <id>           tests + inferred command
  health                      graph consistency + inference health
  validate_graph              graph consistency checks
  evaluate_policy <id>        policy warnings for a change
  pin --type T --from A --to B  add a user-confirmed edge
  flow <id>                   reconstruct a flow (coming with parsers)
  plan_change <id>            bounded mutation envelope (coming)
  orchestrate <task>          bounded agent workflow (coming)
  route <task>                model route (coming)
  ui | mcp | serve            surfaces (coming)

Common flags: --workspace <path>  --db <path>  --json
`;

export async function main(argv: string[] = process.argv.slice(2), write: Writer = (t) => process.stdout.write(t)): Promise<number> {
  const { positionals, flags } = parse(argv);
  const command = positionals[0];

  if (!command || command === "help" || flags.help) {
    write(HELP);
    return command ? 0 : 1;
  }

  const workspaceFlag = flagStr(flags, "workspace");
  const defaultWorkspace = resolve(workspaceFlag ?? positionals[1] ?? ".");
  const baseArgs: DispatchArgs = { workspace: workspaceFlag ?? ".", db: flagStr(flags, "db") };

  try {
    let payload: Envelope;
    switch (command) {
      case "init": {
        const ws = resolve(workspaceFlag ?? positionals[1] ?? ".");
        const { database } = resolvePaths(ws, { workspace: ws, db: flagStr(flags, "db") });
        payload = await initWorkspace(ws, database);
        if (flags.daemon) {
          (payload as Envelope).daemon_note = "start with: archmap serve";
        }
        break;
      }
      case "sync": {
        const ws = resolve(workspaceFlag ?? positionals[1] ?? ".");
        const { database } = resolvePaths(ws, { workspace: ws, db: flagStr(flags, "db") });
        payload = await syncWorkspace(ws, database, Boolean(flags.force));
        break;
      }
      case "impact":
        payload = dispatch("blast_radius", { ...baseArgs, id: positionals[1], direction: flagStr(flags, "direction") ?? "downstream", depth: flags.depth, max_paths: flags["max-paths"] }, defaultWorkspace);
        break;
      case "diff":
        payload = dispatch("diff_impact", { ...baseArgs, base: positionals[1] ?? "main", head: positionals[2] ?? "HEAD", changes: [] }, defaultWorkspace);
        break;
      case "graph":
        payload = dispatch("graph", { ...baseArgs, view: flagStr(flags, "view") ?? "architecture", format: flagStr(flags, "format") ?? "json" }, defaultWorkspace);
        break;
      case "search":
        payload = dispatch("search", { ...baseArgs, q: positionals.slice(1).join(" "), kind: flagStr(flags, "kind"), limit: flags.limit }, defaultWorkspace);
        break;
      case "symbol":
        payload = dispatch("symbol", { ...baseArgs, id: positionals[1] }, defaultWorkspace);
        break;
      case "neighbors":
        payload = dispatch("neighbors", { ...baseArgs, id: positionals[1], direction: flagStr(flags, "direction") ?? "both" }, defaultWorkspace);
        break;
      case "why_path":
        payload = dispatch("why_path", { ...baseArgs, from: positionals[1], to: positionals[2] }, defaultWorkspace);
        break;
      case "tests_to_run":
        payload = dispatch("tests_to_run", { ...baseArgs, id: positionals[1] }, defaultWorkspace);
        break;
      case "health":
        payload = dispatch("health", baseArgs, defaultWorkspace);
        break;
      case "validate_graph":
        payload = dispatch("validate_graph", baseArgs, defaultWorkspace);
        break;
      case "evaluate_policy":
        payload = dispatch("evaluate_policy", { ...baseArgs, id: positionals[1] }, defaultWorkspace);
        break;
      case "pin":
        payload = dispatch("pin", { ...baseArgs, type: flagStr(flags, "type"), from: flagStr(flags, "from"), to: flagStr(flags, "to"), note: flagStr(flags, "note") }, defaultWorkspace);
        break;
      case "hook": {
        const ws = resolve(workspaceFlag ?? ".");
        const { installPreCommitHook } = await import("../index/hook.js");
        payload = installPreCommitHook(ws);
        break;
      }
      case "mcp": {
        const ws = resolve(workspaceFlag ?? ".");
        const { runStdio } = await import("../mcp/server.js");
        return await runStdio(ws);
      }
      case "serve": {
        const ws = resolve(workspaceFlag ?? ".");
        const { runDaemon } = await import("../daemon/server.js");
        const portFlag = flagStr(flags, "port");
        const { port } = await runDaemon(ws, portFlag ? Number(portFlag) : 0);
        write(JSON.stringify({ ok: true, service: "daemon", url: `http://127.0.0.1:${port}` }) + "\n");
        return await new Promise<number>(() => {}); // run until signalled
      }
      case "ui": {
        const ws = resolve(workspaceFlag ?? ".");
        const { runUi } = await import("../ui/server.js");
        const portFlag = flagStr(flags, "port");
        const { port } = await runUi(ws, portFlag ? Number(portFlag) : 4173);
        write(JSON.stringify({ ok: true, service: "ui", url: `http://127.0.0.1:${port}` }) + "\n");
        return await new Promise<number>(() => {}); // run until signalled
      }
      case "flow":
        payload = dispatch("flow", { ...baseArgs, id: positionals[1] }, defaultWorkspace);
        break;
      case "plan_change":
        payload = dispatch("plan_change", { ...baseArgs, id: positionals[1], intent: flagStr(flags, "intent") ?? "" }, defaultWorkspace);
        break;
      case "orchestrate":
        payload = dispatch("orchestrate", { ...baseArgs, id: positionals[1], intent: flagStr(flags, "intent") ?? "" }, defaultWorkspace);
        break;
      case "route":
        payload = dispatch("route", { ...baseArgs, task: positionals.slice(1).join(" "), security_sensitive: Boolean(flags["security-sensitive"]) }, defaultWorkspace);
        break;
      case "narrate": {
        const target = positionals[1] ?? "";
        const impactEnv = dispatch("blast_radius", { ...baseArgs, id: target }, defaultWorkspace);
        const { narrateImpact } = await import("../llm/features.js");
        const { narration, via } = await narrateImpact(target, impactEnv);
        payload = { ...impactEnv, narration, narration_via: via } as Envelope;
        break;
      }
      default:
        payload = errorEnvelope(`unknown command: ${command}`);
    }
    emit(write, payload);
    if (payload.ok) return 0;
    return payload.error ? 2 : 1;
  } catch (error) {
    emit(write, errorEnvelope(error instanceof Error ? error.message : String(error)));
    return 2;
  }
}

// Auto-run when invoked directly (script/bin), not when imported by tests.
import { fileURLToPath } from "node:url";
const entry = process.argv[1] ? resolve(process.argv[1]) : "";
const self = fileURLToPath(import.meta.url);
if (entry && (entry === self || entry === self.replace(/\.ts$/, ".js") || entry === self.replace(/\.js$/, ".ts"))) {
  main().then((code) => process.exit(code));
}
