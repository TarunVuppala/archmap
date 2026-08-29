import { test } from "node:test";
import assert from "node:assert/strict";
import { GraphStore, GraphError, validateGraph, ids } from "../src/core/index.ts";

function freshStore(): GraphStore {
  return new GraphStore(":memory:");
}

function addFn(store: GraphStore, id: string, name: string, extra: Record<string, unknown> = {}): void {
  store.upsertNode({ id, kind: "Function", name, path: "a.ts", start_line: 1, end_line: 3, ...extra });
}

const evidence = { file: "a.ts", line: 2, snippet: "x()" };

test("stable ID scheme matches the documented format", () => {
  assert.equal(ids.functionId("apps/pay/service.ts", "processPayment"), "fn:apps/pay/service.ts:processPayment");
  assert.equal(ids.apiId("post", "/payments"), "api:POST:/payments");
  assert.equal(ids.tableId("payments"), "table:payments");
  const e = ids.edgeId("CALLS", "fn:a:x", "fn:b:y");
  assert.match(e, /^e_[0-9a-f]{16}$/);
  assert.equal(e, ids.edgeId("CALLS", "fn:a:x", "fn:b:y")); // deterministic
});

test("node upsert is stable and idempotent by id", () => {
  const store = freshStore();
  addFn(store, "fn:a.ts:x", "x");
  addFn(store, "fn:a.ts:x", "x-renamed");
  const node = store.getNode("fn:a.ts:x");
  assert.equal(node?.name, "x-renamed");
  assert.equal(store.listNodes().length, 1);
  store.close();
});

test("edge requires evidence for automated sources", () => {
  const store = freshStore();
  addFn(store, "fn:a.ts:x", "x");
  addFn(store, "fn:a.ts:y", "y");
  assert.throws(
    () => store.upsertEdge({ type: "CALLS", from: "fn:a.ts:x", to: "fn:a.ts:y", sources: ["parser"], evidence: {} }),
    GraphError
  );
  // user pin may omit file evidence
  const pin = store.upsertEdge({ type: "CALLS", from: "fn:a.ts:x", to: "fn:a.ts:y", sources: ["user"], evidence: { note: "confirmed" } });
  assert.equal(pin.from, "fn:a.ts:x");
  store.close();
});

test("edge endpoints must exist as nodes", () => {
  const store = freshStore();
  addFn(store, "fn:a.ts:x", "x");
  assert.throws(
    () => store.upsertEdge({ type: "CALLS", from: "fn:a.ts:x", to: "fn:a.ts:missing", sources: ["parser"], evidence }),
    GraphError
  );
  store.close();
});

test("logical edge upsert appends evidence and stays a single row", () => {
  const store = freshStore();
  addFn(store, "fn:a.ts:x", "x");
  addFn(store, "fn:a.ts:y", "y");
  const first = store.upsertEdge({ type: "CALLS", from: "fn:a.ts:x", to: "fn:a.ts:y", sources: ["parser"], evidence: { file: "a.ts", line: 2, snippet: "y()" } });
  const second = store.upsertEdge({ type: "CALLS", from: "fn:a.ts:x", to: "fn:a.ts:y", sources: ["git"], evidence: { file: "a.ts", line: 9, snippet: "y(2)" } });
  assert.equal(first.id, second.id);
  assert.equal(store.listEdges().length, 1);
  const evidenceList = Array.isArray(second.evidence) ? second.evidence : [second.evidence];
  assert.equal(evidenceList.length, 2);
  assert.deepEqual([...second.sources].sort(), ["git", "parser"]);
  store.close();
});

test("conflicting rewrite stays one row and sets conflict with both blobs", () => {
  const store = freshStore();
  addFn(store, "fn:a.ts:x", "x");
  addFn(store, "fn:a.ts:y", "y");
  addFn(store, "fn:a.ts:z", "z");
  const eid = ids.edgeId("CALLS", "fn:a.ts:x", "fn:a.ts:y");
  store.upsertEdge({ id: eid, type: "CALLS", from: "fn:a.ts:x", to: "fn:a.ts:y", sources: ["parser"], evidence });
  // Reuse the same edge id but disagree on the target.
  const conflicted = store.upsertEdge({ id: eid, type: "CALLS", from: "fn:a.ts:x", to: "fn:a.ts:z", sources: ["llm"], evidence: { file: "a.ts", line: 5, snippet: "z()" } });
  assert.equal(conflicted.conflict, true);
  assert.equal(store.listEdges().length, 1);
  store.close();
});

test("neighbors returns adjacent edges and nodes", () => {
  const store = freshStore();
  addFn(store, "fn:a.ts:x", "x");
  addFn(store, "fn:a.ts:y", "y");
  store.upsertEdge({ type: "CALLS", from: "fn:a.ts:x", to: "fn:a.ts:y", sources: ["parser"], evidence });
  const out = store.neighbors("fn:a.ts:x", "out");
  assert.equal(out.edges.length, 1);
  assert.equal(out.nodes.length, 2);
  const inbound = store.neighbors("fn:a.ts:x", "in");
  assert.equal(inbound.edges.length, 0);
  store.close();
});

test("validate_graph passes on a consistent graph", () => {
  const store = freshStore();
  addFn(store, "fn:a.ts:x", "x");
  addFn(store, "fn:a.ts:y", "y");
  store.upsertEdge({ type: "CALLS", from: "fn:a.ts:x", to: "fn:a.ts:y", sources: ["parser"], evidence });
  const result = validateGraph(store);
  assert.equal(result.ok, true);
  assert.equal(result.counts.failed, 0);
  assert.equal(result.counts.conflicts, 0);
  store.close();
});

test("journal and health round-trip", () => {
  const store = freshStore();
  store.appendJournal("sync", { changed: 3 });
  store.setHealth("fingerprint", { value: "abc", changed: true });
  assert.deepEqual(store.getHealth("fingerprint"), { value: "abc", changed: true });
  assert.equal(store.listJournal("sync")[0]?.event, "sync");
  store.close();
});
