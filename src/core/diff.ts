/**
 * Symbol-level diff impact primitive.
 *
 * The Core primitive takes changed symbol IDs (resolved by the parser/sync
 * layer from a git diff) and returns the union impact plus a per-symbol
 * classification. Mapping a raw unified diff to symbols lives in the parser
 * layer; the Core owns the impact semantics.
 */

import type { Envelope, GraphEdge, GraphNode } from "./contracts.js";
import { impact } from "./impact.js";
import { GraphError, type GraphStore } from "./store.js";

export type ChangeKind = "added" | "removed" | "signature" | "body";

export interface SymbolChange {
  id: string;
  change: ChangeKind;
}

export function diffImpact(store: GraphStore, changes: SymbolChange[], base = "main", head = "HEAD"): Envelope {
  if (!Array.isArray(changes)) throw new GraphError("changes must be an array of symbol changes");

  const known = changes.filter((c) => store.getNode(c.id));
  const nodeMap = new Map<string, GraphNode>();
  const edgeMap = new Map<string, GraphEdge>();
  const risk = new Set<string>();
  const counts: Record<string, number> = {};

  for (const change of known) {
    // Removed symbols still matter for downstream dependents, so we always
    // compute impact from the symbol id.
    const report = impact(store, change.id, { direction: "downstream" });
    for (const node of report.nodes) nodeMap.set(node.id, node);
    for (const edge of report.edges) edgeMap.set(edge.id, edge);
    for (const chip of report.risk) risk.add(chip);
    if (change.change === "signature" || change.change === "removed") risk.add("api_shape_change");
  }

  const impacted = [...nodeMap.values()].filter((n) => !known.some((c) => c.id === n.id));
  for (const node of impacted) counts[node.kind] = (counts[node.kind] ?? 0) + 1;

  return {
    ok: true,
    nodes: [...nodeMap.values()],
    edges: [...edgeMap.values()],
    paths: [],
    counts,
    risk: [...risk],
    evidence_used: [...edgeMap.values()].every((e) => Boolean(e.evidence)),
    diff: {
      base,
      head,
      changed: changes.map((c) => ({ id: c.id, change: c.change, known: Boolean(store.getNode(c.id)) })),
    },
  };
}
