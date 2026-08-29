/**
 * validate_graph: Core-level graph consistency checks.
 *
 * Deterministic, evidence-based checks over the one graph:
 *  - every edge has valid, existing endpoints
 *  - every edge carries evidence and valid source metadata
 *  - no duplicate logical edges (one row per (type, from, to))
 *  - unexplained conflict edges are surfaced
 */

import { EDGE_SOURCES, type Envelope } from "./contracts.js";
import type { GraphStore } from "./store.js";

const SOURCE_SET: ReadonlySet<string> = new Set(EDGE_SOURCES);

export function validateGraph(store: GraphStore): Envelope {
  const checks: Array<{ check: string; ok: boolean; detail: string }> = [];
  const add = (check: string, ok: boolean, detail = ""): void => {
    checks.push({ check, ok, detail });
  };

  const edges = store.listEdges(1000);
  const nodeExists = new Map<string, boolean>();
  const exists = (id: string): boolean => {
    let v = nodeExists.get(id);
    if (v === undefined) {
      v = store.getNode(id) !== null;
      nodeExists.set(id, v);
    }
    return v;
  };

  const logicalSeen = new Set<string>();
  let dangling = 0;
  let missingEvidence = 0;
  let badSources = 0;
  let conflicts = 0;
  let duplicates = 0;

  for (const edge of edges) {
    if (!exists(edge.from) || !exists(edge.to)) dangling += 1;
    if (!edge.evidence) missingEvidence += 1;
    const sources = edge.sources ?? [];
    if (sources.length === 0 || sources.some((s) => !SOURCE_SET.has(s))) badSources += 1;
    if (edge.conflict) conflicts += 1;
    const key = `${edge.type}\u0000${edge.from}\u0000${edge.to}`;
    if (logicalSeen.has(key)) duplicates += 1;
    logicalSeen.add(key);
  }

  add("edges_have_valid_endpoints", dangling === 0, `${dangling} dangling edges`);
  add("edges_have_evidence", missingEvidence === 0, `${missingEvidence} edges missing evidence`);
  add("edge_sources_valid", badSources === 0, `${badSources} edges with invalid sources`);
  add("no_duplicate_logical_edges", duplicates === 0, `${duplicates} duplicate logical edges`);

  const failed = checks.filter((c) => !c.ok);
  const risk: string[] = failed.length ? ["graph_invalid"] : [];
  if (conflicts) risk.push("conflict");

  return {
    ok: failed.length === 0,
    nodes: [],
    edges: [],
    paths: [],
    counts: { edges_checked: edges.length, conflicts, failed: failed.length },
    risk,
    evidence_used: true,
    validation: { checks, conflict_edges: conflicts },
  };
}
