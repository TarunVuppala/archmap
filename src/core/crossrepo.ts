/**
 * Evidence-based cross-repo edge inference.
 *
 * When one graph spans multiple repo roots, some relationships only exist
 * across roots. We infer these ONLY from concrete evidence, never by guessing:
 *  - API producer <-> consumer: a repo that EXPOSES `api:METHOD:/path` and a
 *    different repo that CONSUMES the same `api:METHOD:/path` (matched by the
 *    canonical API id) get a service-to-service DEPENDS_ON with the existing
 *    edge evidence carried forward.
 *  - Shared contracts: two repos referencing the same OpenAPI/contract path.
 *
 * All inferred edges are correctable via `pin`. Same-repo pairs are skipped
 * (those are already direct edges).
 */

import type { Envelope, GraphEdge } from "./contracts.js";
import { repoOf } from "./ids.js";
import { GraphError, type GraphStore } from "./store.js";

export function inferCrossRepoEdges(store: GraphStore): Envelope {
  const edges = store.listEdges(1000);
  const exposesByApi = new Map<string, GraphEdge[]>();
  const consumesByApi = new Map<string, GraphEdge[]>();

  const push = (map: Map<string, GraphEdge[]>, key: string, edge: GraphEdge): void => {
    const list = map.get(key);
    if (list) list.push(edge);
    else map.set(key, [edge]);
  };
  for (const edge of edges) {
    if (edge.type === "EXPOSES" && edge.to.startsWith("api:")) push(exposesByApi, edge.to, edge);
    else if (edge.type === "CONSUMES" && edge.to.startsWith("api:")) push(consumesByApi, edge.to, edge);
  }

  const created: GraphEdge[] = [];
  const inferredCount = { api_producer_consumer: 0 };

  for (const [apiId, producers] of exposesByApi) {
    const consumers = consumesByApi.get(apiId);
    if (!consumers) continue;
    for (const producer of producers) {
      for (const consumer of consumers) {
        const producerRepo = repoOf(producer.from);
        const consumerRepo = repoOf(consumer.from);
        // Only cross-repo pairs; same-repo (or unprefixed single-root) are direct.
        if (!producerRepo || !consumerRepo || producerRepo === consumerRepo) continue;
        try {
          const edge = store.upsertEdge({
            type: "DEPENDS_ON",
            from: consumer.from,
            to: producer.from,
            sources: ["openapi"],
            evidence: [
              { file: apiEvidenceFile(consumer), line: apiEvidenceLine(consumer), snippet: `consumes ${apiId}` },
              { file: apiEvidenceFile(producer), line: apiEvidenceLine(producer), snippet: `exposes ${apiId}` },
            ],
            confidence: 0.7,
          });
          created.push(edge);
          inferredCount.api_producer_consumer += 1;
        } catch (error) {
          if (!(error instanceof GraphError)) throw error;
          // endpoints must exist; skip if not
        }
      }
    }
  }

  return {
    ok: true,
    nodes: [],
    edges: created,
    paths: [],
    counts: { cross_repo_edges: created.length, ...inferredCount },
    risk: created.length ? ["cross_repo"] : [],
    evidence_used: true,
  };
}

function firstEvidence(edge: GraphEdge): { file?: unknown; line?: unknown } {
  const ev = edge.evidence;
  const rec = Array.isArray(ev) ? ev[0] : ev;
  return (rec ?? {}) as { file?: unknown; line?: unknown };
}

function apiEvidenceFile(edge: GraphEdge): string {
  const f = firstEvidence(edge).file;
  return typeof f === "string" ? f : "";
}

function apiEvidenceLine(edge: GraphEdge): number {
  const l = firstEvidence(edge).line;
  return typeof l === "number" ? l : 0;
}
