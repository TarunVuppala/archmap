/**
 * Structured risk profile for a change target.
 *
 * The impact envelope already carries coarse risk chips (strings). This module
 * computes the quantified breakdown the definition-of-done asks for, all from
 * the ONE graph plus optional git churn:
 *   dependency_count     — edges into/out of the target (degree)
 *   downstream_consumers — distinct impacted nodes (from the impact traversal)
 *   centrality           — degree normalized against the busiest node (0..1)
 *   churn                — commits touching the target's file (git, graceful)
 *   db_interactions      — READS/WRITES edges among impacted paths
 *   external_deps        — impacted External nodes
 *   test_coverage        — does anything TESTS the target (directly)?
 *   critical_path        — target (or an impacted node) marked critical
 * A 0..100 `score` and a `level` (low/medium/high) summarize the signals so
 * surfaces can sort/badge without re-deriving. Nothing is invented: every
 * number traces to graph edges or git output.
 */

import { execFileSync } from "node:child_process";
import type { GraphEdge, GraphNode } from "./contracts.js";
import type { GraphStore } from "./store.js";

export interface RiskProfile {
  dependency_count: number;
  downstream_consumers: number;
  centrality: number;
  churn: number | null;
  churn_available: boolean;
  db_interactions: number;
  external_deps: number;
  test_coverage: boolean;
  critical_path: boolean;
  score: number;
  level: "low" | "medium" | "high";
  signals: string[];
}

/** Max degree across the graph, used to normalize centrality. Cached per call. */
function maxDegree(store: GraphStore): number {
  const row = store.db
    .prepare(
      `SELECT MAX(d) AS m FROM (
         SELECT from_id AS id, COUNT(*) AS d FROM edges GROUP BY from_id
         UNION ALL
         SELECT to_id AS id, COUNT(*) AS d FROM edges GROUP BY to_id
       )`
    )
    .get() as { m: number | null };
  return row.m ?? 0;
}

/** Count of commits that touched the file backing this node (git, graceful). */
function gitChurn(store: GraphStore, node: GraphNode): number | null {
  const rel = node.path;
  const root = store.workspaceRoot;
  if (!rel || !root) return null;
  try {
    const out = execFileSync("git", ["log", "--oneline", "--", rel], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    });
    const lines = out.split(/\r?\n/).filter((l) => l.trim().length > 0);
    return lines.length;
  } catch {
    return null; // no git, not a repo, or file untracked — churn simply unknown
  }
}

/** Does anything TESTS this node directly (incoming TESTS edge)? */
function hasDirectTests(store: GraphStore, nodeId: string): boolean {
  const row = store.db.prepare("SELECT 1 FROM edges WHERE type = 'TESTS' AND to_id = ? LIMIT 1").get(nodeId);
  return row !== undefined;
}

/** READS/WRITES edges incident to any of the given node ids. */
function dbInteractionCount(store: GraphStore, nodeIds: string[]): number {
  if (nodeIds.length === 0) return 0;
  const placeholders = nodeIds.map(() => "?").join(",");
  const row = store.db
    .prepare(
      `SELECT COUNT(*) AS c FROM edges
       WHERE type IN ('READS','WRITES') AND (from_id IN (${placeholders}) OR to_id IN (${placeholders}))`
    )
    .get(...nodeIds, ...nodeIds) as { c: number };
  return row.c;
}

export function computeRisk(
  store: GraphStore,
  target: GraphNode,
  impacted: GraphNode[],
  edges: GraphEdge[]
): RiskProfile {
  const dependency_count = store.degree(target.id);
  const downstream_consumers = impacted.length;
  const maxDeg = maxDegree(store);
  const centrality = maxDeg > 0 ? Number((dependency_count / maxDeg).toFixed(3)) : 0;
  const churn = gitChurn(store, target);
  // Count DB edges incident to the target or any impacted node, independent of
  // traversal direction (WRITES/READS rules are inverse in downstream BFS).
  const db_interactions = dbInteractionCount(store, [target.id, ...impacted.map((n) => n.id)]);
  const external_deps = impacted.filter((n) => n.kind === "External").length;
  const test_coverage = hasDirectTests(store, target.id) || impacted.some((n) => n.kind === "Test");
  const critical_path = Boolean(target.critical) || impacted.some((n) => n.critical);

  const signals: string[] = [];
  // Score is a bounded, explainable sum of weighted signals (0..100).
  let score = 0;
  if (downstream_consumers >= 10) {
    score += 25;
    signals.push("large_downstream");
  } else if (downstream_consumers >= 3) {
    score += 12;
    signals.push("moderate_downstream");
  }
  if (centrality >= 0.6) {
    score += 20;
    signals.push("hub");
  } else if (centrality >= 0.3) {
    score += 10;
  }
  if (!test_coverage) {
    score += 20;
    signals.push("untested");
  }
  if (db_interactions > 0) {
    score += 12;
    signals.push("db_interaction");
  }
  if (external_deps > 0) {
    score += 10;
    signals.push("external_dependency");
  }
  if (critical_path) {
    score += 20;
    signals.push("critical_path");
  }
  if (churn !== null && churn >= 10) {
    score += 8;
    signals.push("high_churn");
  }
  score = Math.min(100, score);
  const level: RiskProfile["level"] = score >= 55 ? "high" : score >= 25 ? "medium" : "low";

  return {
    dependency_count,
    downstream_consumers,
    centrality,
    churn,
    churn_available: churn !== null,
    db_interactions,
    external_deps,
    test_coverage,
    critical_path,
    score,
    level,
    signals,
  };
}
