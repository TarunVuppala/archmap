/**
 * flow: reconstruct an ordered, evidence-backed sequence over the one graph.
 *
 * Deterministic BFS following flow-shaped edges (EXPOSES, CALLS, WRITES, READS,
 * PUBLISHES, SUBSCRIBES, CONSUMES, DEPENDS_ON) from a starting node, producing
 * ordered steps with the evidence for each hop. No LLM required.
 */

import type { Envelope, GraphEdge } from "./contracts.js";
import { GraphError, type GraphStore } from "./store.js";

const FLOW_EDGES = new Set(["EXPOSES", "CALLS", "WRITES", "READS", "PUBLISHES", "SUBSCRIBES", "CONSUMES", "DEPENDS_ON"]);

export function flow(store: GraphStore, startId: string, maxSteps = 12): Envelope {
  let start = store.getNode(startId);
  if (!start) {
    const matches = store.findNodes(startId, null, 1);
    start = matches[0] ?? null;
  }
  if (!start) throw new GraphError(`unknown flow start: ${startId}`);

  const adjacency = new Map<string, GraphEdge[]>();
  for (const edge of store.listEdges(1000)) {
    if (!FLOW_EDGES.has(edge.type)) continue;
    const list = adjacency.get(edge.from) ?? [];
    list.push(edge);
    adjacency.set(edge.from, list);
  }

  const steps: Array<{ from: string; to: string; type: string; evidence: unknown }> = [];
  const visitedEdges = new Set<string>();
  const orderNodes: string[] = [start.id];
  const queue = [start.id];
  const seenNodes = new Set<string>([start.id]);

  while (queue.length > 0 && steps.length < maxSteps) {
    const current = queue.shift()!;
    for (const edge of adjacency.get(current) ?? []) {
      if (visitedEdges.has(edge.id)) continue;
      visitedEdges.add(edge.id);
      steps.push({ from: edge.from, to: edge.to, type: edge.type, evidence: edge.evidence });
      if (!seenNodes.has(edge.to)) {
        seenNodes.add(edge.to);
        orderNodes.push(edge.to);
        queue.push(edge.to);
      }
      if (steps.length >= maxSteps) break;
    }
  }

  const nodes = orderNodes.map((id) => store.getNode(id)).filter((n): n is NonNullable<typeof n> => n !== null);
  const edges = [...visitedEdges].map((id) => store.getEdge(id)).filter((e): e is GraphEdge => e !== null);
  return {
    ok: true,
    nodes,
    edges,
    paths: [{ nodes: orderNodes, edges }],
    counts: { steps: steps.length },
    risk: [],
    evidence_used: steps.every((s) => Boolean(s.evidence)),
    flow: { start: start.id, steps },
  };
}
