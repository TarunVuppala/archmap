/**
 * Single Core operations dispatcher.
 *
 * Every surface (CLI, mcp, serve, ui) routes graph-backed operations through
 * this one function so no surface forks graph/impact/policy semantics. Each
 * operation returns a canonical envelope. Transport and argument shaping stay
 * in the surfaces; meaning stays here.
 */

import { join, isAbsolute, resolve } from "node:path";
import { errorEnvelope, type Envelope } from "./contracts.js";
import { GraphStore, GraphError } from "./store.js";
import { impact, whyPath, testsToRun } from "./impact.js";
import { search, symbol } from "./search.js";
import { diffImpact, type SymbolChange } from "./diff.js";
import { evaluatePolicy } from "./policy.js";
import { validateGraph } from "./validate.js";
import { flow } from "./flow.js";
import { planChange, route, orchestrate } from "./agent.js";

export const CORE_OPERATIONS = [
  "search",
  "symbol",
  "neighbors",
  "blast_radius",
  "impact",
  "why_path",
  "diff_impact",
  "tests_to_run",
  "health",
  "validate_graph",
  "evaluate_policy",
  "pin",
  "graph",
  "flow",
  "plan_change",
  "route",
  "orchestrate",
] as const;

export type CoreOperation = (typeof CORE_OPERATIONS)[number];

export interface DispatchArgs {
  workspace?: string;
  db?: string;
  [key: string]: unknown;
}

export function resolvePaths(defaultWorkspace: string, args: DispatchArgs): { workspace: string; database: string } {
  const wsArg = args.workspace ?? defaultWorkspace;
  const workspace = isAbsolute(wsArg) ? resolve(wsArg) : resolve(defaultWorkspace, wsArg);
  const dbArg = args.db;
  const database = dbArg ? (isAbsolute(dbArg) ? dbArg : join(workspace, dbArg)) : join(workspace, ".archmap", "index.db");
  return { workspace, database };
}

/** Open a store, run fn, always close. */
export function withStore<T>(database: string, workspace: string, fn: (store: GraphStore) => T): T {
  const store = new GraphStore(database, workspace);
  try {
    return fn(store);
  } finally {
    store.close();
  }
}

export function dispatch(operation: string, args: DispatchArgs = {}, defaultWorkspace = "."): Envelope {
  if (!(CORE_OPERATIONS as readonly string[]).includes(operation)) {
    return errorEnvelope(`unknown operation: ${operation}`);
  }
  const { workspace, database } = resolvePaths(resolve(defaultWorkspace), args);
  try {
    return withStore(database, workspace, (store) => runOperation(store, operation as CoreOperation, args, workspace));
  } catch (error) {
    return errorEnvelope(error instanceof Error ? error.message : String(error));
  }
}

function num(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function runOperation(store: GraphStore, operation: CoreOperation, args: DispatchArgs, workspace: string): Envelope {
  switch (operation) {
    case "search":
      return search(store, String(args.q ?? args.query ?? ""), (args.kind as string) ?? null, num(args.limit, 20));
    case "symbol":
      return symbol(store, String(args.id ?? args.name ?? ""));
    case "neighbors": {
      const n = store.neighbors(String(args.id ?? ""), (args.direction as "in" | "out" | "both") ?? "both");
      return {
        ok: true,
        nodes: n.nodes,
        edges: n.edges,
        paths: [],
        counts: { edges: n.edges.length },
        risk: [],
        evidence_used: n.edges.every((e) => Boolean(e.evidence)),
      };
    }
    case "blast_radius":
    case "impact": {
      if (!args.id) throw new GraphError("id is required");
      return impact(store, String(args.id), {
        direction: (args.direction as "downstream" | "upstream") ?? "downstream",
        depth: num(args.depth, 5),
        maxPaths: num(args.max_paths ?? args.maxPaths, 7),
      });
    }
    case "why_path":
      return whyPath(store, String(args.from ?? ""), String(args.to ?? ""));
    case "tests_to_run":
      return testsToRun(store, String(args.id ?? ""));
    case "diff_impact":
      return diffImpact(store, (args.changes as SymbolChange[]) ?? [], String(args.base ?? "main"), String(args.head ?? "HEAD"));
    case "validate_graph":
      return validateGraph(store);
    case "evaluate_policy":
      return evaluatePolicy(store, String(args.id ?? args.target ?? ""), workspace);
    case "flow":
      return flow(store, String(args.id ?? ""), num(args.max_steps ?? args.maxSteps, 12));
    case "plan_change":
      return planChange(store, String(args.id ?? args.target ?? ""), String(args.intent ?? ""), workspace);
    case "route":
      return route(String(args.task ?? args.kind ?? ""), { securitySensitive: Boolean(args.security_sensitive), ambiguity: num(args.ambiguity, 0) });
    case "orchestrate":
      return orchestrate(store, String(args.id ?? args.target ?? ""), String(args.intent ?? ""), workspace);
    case "health":
      return graphHealth(store);
    case "pin": {
      const edge = store.upsertEdge({
        type: args.type as never,
        from: String(args.from ?? ""),
        to: String(args.to ?? ""),
        sources: ["user"],
        evidence: (args.evidence as Record<string, unknown>) ?? { note: (args.note as string) ?? "user pin" },
      });
      return { ok: true, nodes: [], edges: [edge], paths: [], counts: {}, risk: [], evidence_used: true };
    }
    case "graph": {
      return {
        ok: true,
        nodes: store.listNodes(num(args.node_limit, 200)),
        edges: store.listEdges(num(args.edge_limit, 500)),
        paths: [],
        counts: {},
        risk: [],
        evidence_used: true,
        view: (args.view as string) ?? "architecture",
      };
    }
    default:
      return errorEnvelope(`unhandled operation: ${operation}`);
  }
}

/** health: graph consistency + basic inference health. */
function graphHealth(store: GraphStore): Envelope {
  const validation = validateGraph(store);
  const nodes = store.listNodes(500);
  const nodeCount = nodes.length;
  const edgeCount = store.listEdges(1000).length;
  const criticalWithoutTests = nodes
    .filter((n) => n.critical)
    .filter((n) => !impact(store, n.id, { direction: "downstream" }).nodes.some((m) => m.kind === "Test"))
    .map((n) => n.id);
  const risk = [...validation.risk];
  if (criticalWithoutTests.length) risk.push("critical_untested");
  return {
    ok: validation.ok,
    nodes: [],
    edges: [],
    paths: [],
    counts: { nodes: nodeCount, edges: edgeCount, critical_untested: criticalWithoutTests.length },
    risk,
    evidence_used: true,
    health: {
      graph_valid: validation.ok,
      validation: validation.validation,
      critical_without_tests: criticalWithoutTests,
    },
  };
}
