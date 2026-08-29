/**
 * Canonical Core conformance fixtures: a fixed graph plus expected results.
 * Loading CONFORMANCE_GRAPH and running the operations must reproduce
 * CONFORMANCE_EXPECTATIONS. This locks the Core contract deterministically.
 */

import type { GraphStore } from "./store.js";
import { apiId, edgeId, externalId, functionId, testId } from "./ids.js";

const SERVICE = functionId("apps/payments/service.ts", "processPayment");
const VALIDATE = functionId("apps/payments/validate.ts", "validateTransaction");
const API = apiId("POST", "/payments");
const ORDER = externalId("order-service");
const TABLE = "table:payments";
const TEST = testId("tests/payments.test.ts", "test_process_payment");

function edge(type: string, from: string, to: string, file: string, line: number, snippet: string) {
  return { id: edgeId(type, from, to), type, from, to, evidence: { file, line, snippet }, sources: ["parser"], confidence: 1.0, conflict: false };
}

export const CONFORMANCE_GRAPH = {
  nodes: [
    { id: SERVICE, kind: "Function", name: "processPayment", path: "apps/payments/service.ts", start_line: 10, end_line: 20, critical: true },
    { id: VALIDATE, kind: "Function", name: "validateTransaction", path: "apps/payments/validate.ts", start_line: 1, end_line: 8 },
    { id: API, kind: "API", name: "POST /payments" },
    { id: ORDER, kind: "External", name: "order-service" },
    { id: TABLE, kind: "Table", name: "payments" },
    { id: TEST, kind: "Test", name: "test_process_payment", path: "tests/payments.test.ts", start_line: 1, end_line: 5 },
  ],
  edges: [
    edge("CALLS", SERVICE, VALIDATE, "apps/payments/service.ts", 14, "validateTransaction(tx)"),
    edge("EXPOSES", SERVICE, API, "apps/payments/service.ts", 9, "@app.post('/payments')"),
    edge("CONSUMES", ORDER, API, "apps/orders/client.ts", 22, "POST /payments"),
    edge("WRITES", SERVICE, TABLE, "apps/payments/service.ts", 18, "INSERT INTO payments"),
    edge("TESTS", TEST, SERVICE, "tests/payments.test.ts", 3, "processPayment(sample)"),
  ],
  chunks: [
    { id: `chunk:${SERVICE}`, node_id: SERVICE, kind: "code", text: "function processPayment(tx) { validateTransaction(tx) }" },
    { id: `chunk:${VALIDATE}`, node_id: VALIDATE, kind: "code", text: "function validateTransaction(tx) { return tx.amount > 0 }" },
  ],
} as const;

export const CONFORMANCE_EXPECTATIONS = {
  // Downstream = what depends on processPayment. WRITES is inverse for
  // downstream, so the table it writes is not downstream-impacted.
  impactDownstream: {
    start: SERVICE,
    impactedIds: [API, ORDER, TEST].sort(),
    counts: { API: 1, External: 1, Test: 1 },
    riskContains: ["downstream", "critical", "external"],
  },
  // Directed forward reachability: processPayment reaches the API it EXPOSES.
  whyPath: { from: SERVICE, to: API, minPaths: 1 },
  search: { q: "processPayment", expectedIds: [SERVICE] },
} as const;

export function loadConformanceGraph(store: GraphStore): void {
  for (const node of CONFORMANCE_GRAPH.nodes) store.upsertNode(node as never);
  for (const e of CONFORMANCE_GRAPH.edges) store.upsertEdge(e as never);
  for (const chunk of CONFORMANCE_GRAPH.chunks) store.upsertChunk(chunk as never);
}
