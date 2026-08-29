/**
 * Deterministic lexical RAG search over chunks that point at graph nodes, plus
 * a symbol lookup. Ported from the Python reference (archmap/rag/search.ts
 * scoring): token overlap + phrase bonus + exact id/name bonus. No embeddings
 * required; works with zero AI.
 */

import type { Envelope, GraphNode } from "./contracts.js";
import { GraphError, type GraphStore } from "./store.js";

const TOKEN_RE = /[A-Za-z0-9_@./:-]+/g;

function tokens(value: string): string[] {
  const matches = value.toLowerCase().match(TOKEN_RE);
  return matches ? matches : [];
}

export function search(store: GraphStore, query: string, kind: string | null = null, limit = 20): Envelope {
  const q = String(query ?? "").trim();
  if (!q) throw new GraphError("query is required");
  const capped = Math.max(1, Math.min(limit, 50));
  const queryTokens = new Set(tokens(q));
  if (queryTokens.size === 0) throw new GraphError("query must contain searchable characters");
  const lowerQuery = q.toLowerCase();

  const scored: Array<{ score: number; node: GraphNode }> = [];
  for (const chunk of store.listChunks(1000)) {
    if (kind && chunk.kind !== kind) continue;
    const node = store.getNode(chunk.node_id);
    if (!node) continue;
    const haystack = `${node.id} ${node.name} ${chunk.text}`.toLowerCase();
    const haystackTokens = new Set(tokens(haystack));
    let overlap = 0;
    for (const t of queryTokens) if (haystackTokens.has(t)) overlap += 1;
    const phrase = haystack.includes(lowerQuery);
    if (overlap === 0 && !phrase) continue;
    let score = overlap / queryTokens.size;
    if (phrase) score += 0.75;
    if (node.id.toLowerCase() === lowerQuery || node.name.toLowerCase() === lowerQuery) score += 1.0;
    scored.push({ score, node });
  }
  scored.sort((a, b) => b.score - a.score || a.node.kind.localeCompare(b.node.kind) || a.node.id.localeCompare(b.node.id));

  const nodes: GraphNode[] = [];
  const seen = new Set<string>();
  for (const { node } of scored) {
    if (seen.has(node.id)) continue;
    seen.add(node.id);
    nodes.push(node);
    if (nodes.length >= capped) break;
  }
  return {
    ok: true,
    nodes,
    edges: [],
    paths: [],
    counts: { results: nodes.length, nodes: nodes.length },
    risk: [],
    evidence_used: true,
    query: q,
  };
}

export function symbol(store: GraphStore, identifier: string): Envelope {
  const id = String(identifier ?? "").trim();
  let node = store.getNode(id);
  if (!node) {
    const matches = store.findNodes(id, null, 1);
    node = matches[0] ?? null;
  }
  if (!node) throw new GraphError(`unknown symbol: ${id}`);
  const neighbors = store.neighbors(node.id, "both");
  return {
    ok: true,
    nodes: neighbors.nodes,
    edges: neighbors.edges,
    paths: [],
    counts: { neighbors: neighbors.edges.length },
    risk: [],
    evidence_used: neighbors.edges.every((e) => Boolean(e.evidence)),
    symbol: node,
  };
}
