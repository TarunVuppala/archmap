import { test } from "node:test";
import assert from "node:assert/strict";
import {
  GraphStore,
  impact,
  whyPath,
  testsToRun,
  search,
  symbol,
  diffImpact,
  evaluatePolicy,
  serialize,
  deserialize,
  loadConformanceGraph,
  CONFORMANCE_EXPECTATIONS,
} from "../src/core/index.ts";

function conformStore(): GraphStore {
  const store = new GraphStore(":memory:");
  loadConformanceGraph(store);
  return store;
}

test("impact downstream reproduces the conformance expectations", () => {
  const store = conformStore();
  const expected = CONFORMANCE_EXPECTATIONS.impactDownstream;
  const report = impact(store, expected.start);
  const impacted = report.nodes.map((n) => n.id).filter((id) => id !== expected.start).sort();
  assert.deepEqual(impacted, [...expected.impactedIds]);
  assert.deepEqual(report.counts, expected.counts);
  for (const chip of expected.riskContains) assert.ok(report.risk.includes(chip), `missing risk ${chip}`);
  store.close();
});

test("impact is bounded to depth<=5 and <=7 paths", () => {
  const store = conformStore();
  const report = impact(store, CONFORMANCE_EXPECTATIONS.impactDownstream.start, { depth: 99, maxPaths: 99 });
  assert.ok(report.paths.length <= 7);
  for (const path of report.paths) assert.ok(path.edges.length <= 5);
  store.close();
});

test("why_path finds a directed forward path with evidence", () => {
  const store = conformStore();
  const { from, to, minPaths } = CONFORMANCE_EXPECTATIONS.whyPath;
  const report = whyPath(store, from, to);
  assert.ok(report.paths.length >= minPaths);
  assert.equal(report.evidence_used, true);
  store.close();
});

test("search returns the expected node via lexical RAG", () => {
  const store = conformStore();
  const { q, expectedIds } = CONFORMANCE_EXPECTATIONS.search;
  const report = search(store, q);
  const ids = report.nodes.map((n) => n.id);
  for (const id of expectedIds) assert.ok(ids.includes(id), `search missing ${id}`);
  store.close();
});

test("symbol returns the node plus neighbors", () => {
  const store = conformStore();
  const report = symbol(store, CONFORMANCE_EXPECTATIONS.impactDownstream.start);
  assert.equal(report.ok, true);
  assert.ok(report.edges.length >= 1);
  store.close();
});

test("tests_to_run finds the covering test and a command", () => {
  const store = conformStore();
  const report = testsToRun(store, CONFORMANCE_EXPECTATIONS.impactDownstream.start);
  const tests = report.tests as Array<{ id: string }>;
  assert.equal(tests.length, 1);
  assert.ok((report.commands as string[]).includes("npm test"));
  store.close();
});

test("diff_impact unions impact for changed symbols", () => {
  const store = conformStore();
  const report = diffImpact(store, [{ id: CONFORMANCE_EXPECTATIONS.impactDownstream.start, change: "signature" }]);
  const ids = report.nodes.map((n) => n.id);
  assert.ok(ids.includes("ext:order-service"));
  assert.ok(report.risk.includes("api_shape_change"));
  store.close();
});

test("evaluate_policy warns but does not block by default", () => {
  const store = conformStore();
  const report = evaluatePolicy(store, CONFORMANCE_EXPECTATIONS.impactDownstream.start);
  assert.equal(report.ok, true);
  const policy = report.policy as { blocked: boolean; violations: Array<{ key: string }> };
  assert.equal(policy.blocked, false);
  assert.ok(policy.violations.some((v) => v.key === "public_route_without_contract"));
  store.close();
});

test("serialize is deterministic and round-trips", () => {
  const text = serialize({ b: 2, a: 1, nested: { y: 1, x: 2 } });
  assert.equal(text, '{"a":1,"b":2,"nested":{"x":2,"y":1}}');
  assert.deepEqual(deserialize(text), { b: 2, a: 1, nested: { y: 1, x: 2 } });
});
