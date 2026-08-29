/**
 * insights: deterministic architecture health signals over the one graph.
 *
 *  - cycles: dependency cycles among symbols/modules (CALLS/IMPORTS/DEPENDS_ON)
 *  - coupling: nodes with high combined fan-in + fan-out
 *  - bottlenecks: high fan-in AND high fan-out (things everything routes through)
 *  - hubs: highest total degree
 *  - isolated: nodes with no edges
 *  - hotspots: git churn when a .git dir is present, else a high-degree proxy
 *  - large_downstream_impact: nodes whose downstream blast radius is largest
 *
 * All signals are computed from graph rows (+ optional git log); no LLM.
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Envelope, GraphEdge, GraphNode } from "./contracts.js";
import { impact } from "./impact.js";
import { type GraphStore } from "./store.js";

const DEP_EDGES = new Set(["CALLS", "IMPORTS", "DEPENDS_ON"]);

interface Degree {
  in: number;
  out: number;
}

function buildAdjacency(edges: GraphEdge[]): {
  outgoing: Map<string, string[]>;
  degree: Map<string, Degree>;
  depOutgoing: Map<string, string[]>;
} {
  const outgoing = new Map<string, string[]>();
  const depOutgoing = new Map<string, string[]>();
  const degree = new Map<string, Degree>();
  const bump = (id: string, dir: "in" | "out"): void => {
    const d = degree.get(id) ?? { in: 0, out: 0 };
    d[dir] += 1;
    degree.set(id, d);
  };
  for (const edge of edges) {
    (outgoing.get(edge.from) ?? outgoing.set(edge.from, []).get(edge.from)!).push(edge.to);
    bump(edge.from, "out");
    bump(edge.to, "in");
    if (DEP_EDGES.has(edge.type)) {
      (depOutgoing.get(edge.from) ?? depOutgoing.set(edge.from, []).get(edge.from)!).push(edge.to);
    }
  }
  return { outgoing, degree, depOutgoing };
}

/** Find dependency cycles via iterative DFS (Tarjan-lite: back-edge detection). */
function findCycles(nodes: GraphNode[], depOutgoing: Map<string, string[]>, maxCycles = 20): string[][] {
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<string, number>();
  const stack: string[] = [];
  const cycles: string[][] = [];
  const ids = nodes.map((n) => n.id);

  const dfs = (start: string): void => {
    // iterative DFS carrying the path stack
    const work: Array<{ id: string; idx: number }> = [{ id: start, idx: 0 }];
    color.set(start, GRAY);
    stack.push(start);
    while (work.length > 0) {
      const top = work[work.length - 1]!;
      const neighbors = depOutgoing.get(top.id) ?? [];
      if (top.idx < neighbors.length) {
        const next = neighbors[top.idx]!;
        top.idx += 1;
        const c = color.get(next) ?? WHITE;
        if (c === WHITE) {
          color.set(next, GRAY);
          stack.push(next);
          work.push({ id: next, idx: 0 });
        } else if (c === GRAY && cycles.length < maxCycles) {
          // back edge -> cycle from `next` to current top of stack
          const at = stack.lastIndexOf(next);
          if (at >= 0) cycles.push(stack.slice(at).concat(next));
        }
      } else {
        color.set(top.id, BLACK);
        stack.pop();
        work.pop();
      }
    }
  };

  for (const id of ids) {
    if ((color.get(id) ?? WHITE) === WHITE) dfs(id);
    if (cycles.length >= maxCycles) break;
  }
  return cycles;
}

function gitChurn(workspace: string, limit = 300): Map<string, number> {
  const churn = new Map<string, number>();
  if (!existsSync(join(workspace, ".git"))) return churn;
  try {
    const out = execFileSync("git", ["-C", workspace, "log", "--name-only", "--pretty=format:", `-n${limit}`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    for (const raw of out.split(/\r?\n/)) {
      const path = raw.trim().split("\\").join("/");
      if (!path) continue;
      churn.set(path, (churn.get(path) ?? 0) + 1);
    }
  } catch {
    // no git history available
  }
  return churn;
}

export interface InsightsOptions {
  workspace?: string | null;
  topN?: number;
  couplingThreshold?: number;
}

export function insights(store: GraphStore, opts: InsightsOptions = {}): Envelope {
  const topN = Math.max(1, Math.min(opts.topN ?? 10, 50));
  const nodes = store.listNodes(500);
  const edges = store.listEdges(1000);
  const { degree, depOutgoing } = buildAdjacency(edges);
  const nodeById = new Map(nodes.map((n) => [n.id, n]));

  const degreeOf = (id: string): Degree => degree.get(id) ?? { in: 0, out: 0 };
  const total = (id: string): number => degreeOf(id).in + degreeOf(id).out;

  // hubs: highest total degree
  const hubs = [...nodes]
    .map((n) => ({ id: n.id, kind: n.kind, degree: total(n.id) }))
    .filter((h) => h.degree > 0)
    .sort((a, b) => b.degree - a.degree)
    .slice(0, topN);

  // bottlenecks: high fan-in AND fan-out
  const bottlenecks = [...nodes]
    .map((n) => ({ id: n.id, in: degreeOf(n.id).in, out: degreeOf(n.id).out, score: Math.min(degreeOf(n.id).in, degreeOf(n.id).out) }))
    .filter((b) => b.score >= 2)
    .sort((a, b) => b.score - a.score)
    .slice(0, topN);

  // coupling: high combined degree above threshold
  const threshold = opts.couplingThreshold ?? 6;
  const coupling = [...nodes]
    .map((n) => ({ id: n.id, degree: total(n.id) }))
    .filter((c) => c.degree >= threshold)
    .sort((a, b) => b.degree - a.degree)
    .slice(0, topN);

  // isolated: no edges at all
  const isolated = nodes.filter((n) => total(n.id) === 0 && n.kind !== "Repo").map((n) => n.id).slice(0, topN * 2);

  // cycles
  const cycles = findCycles(nodes, depOutgoing);

  // hotspots: git churn (if available) mapped to nodes by path, else high-degree proxy
  const churn = gitChurn(opts.workspace ?? store.workspaceRoot ?? ".");
  let hotspots: Array<{ id: string; churn?: number; degree?: number; via: "git" | "degree" }>;
  if (churn.size > 0) {
    const byPath = new Map<string, string[]>();
    for (const n of nodes) if (n.path) (byPath.get(n.path) ?? byPath.set(n.path, []).get(n.path)!).push(n.id);
    const scored: Array<{ id: string; churn: number; via: "git" }> = [];
    for (const [path, count] of churn) {
      for (const id of byPath.get(path) ?? []) scored.push({ id, churn: count, via: "git" });
    }
    hotspots = scored.sort((a, b) => b.churn - a.churn).slice(0, topN);
  } else {
    hotspots = hubs.slice(0, topN).map((h) => ({ id: h.id, degree: h.degree, via: "degree" as const }));
  }

  // large downstream impact: recompute bounded impact per candidate (cap work)
  const candidates = [...nodes]
    .filter((n) => degreeOf(n.id).in > 0 || degreeOf(n.id).out > 0)
    .sort((a, b) => total(b.id) - total(a.id))
    .slice(0, Math.min(nodes.length, 40));
  const largeDownstream = candidates
    .map((n) => {
      const report = impact(store, n.id, { direction: "downstream" });
      return { id: n.id, downstream: report.nodes.filter((m) => m.id !== n.id).length, risk: report.risk };
    })
    .filter((d) => d.downstream > 0)
    .sort((a, b) => b.downstream - a.downstream)
    .slice(0, topN);

  const risk: string[] = [];
  if (cycles.length) risk.push("cycles");
  if (bottlenecks.length) risk.push("bottlenecks");
  if (coupling.length) risk.push("high_coupling");

  return {
    ok: true,
    nodes: [],
    edges: [],
    paths: [],
    counts: {
      nodes: nodes.length,
      edges: edges.length,
      cycles: cycles.length,
      bottlenecks: bottlenecks.length,
      hubs: hubs.length,
      isolated: isolated.length,
      hotspots: hotspots.length,
    },
    risk,
    evidence_used: true,
    insights: {
      cycles,
      coupling,
      bottlenecks,
      hubs,
      isolated,
      hotspots,
      large_downstream_impact: largeDownstream,
      hotspots_via: churn.size > 0 ? "git-churn" : "degree-proxy",
    },
  };
}
