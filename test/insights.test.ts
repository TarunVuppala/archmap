import { test } from "node:test";
import assert from "node:assert/strict";
import { GraphStore, insights } from "../src/core/index.ts";

function ev(file = "a.ts") {
  return { file, line: 1, snippet: "x" };
}

test("insights detects a dependency cycle", () => {
  const store = new GraphStore(":memory:");
  store.upsertNode({ id: "fn:a.ts:a", kind: "Function", name: "a" });
  store.upsertNode({ id: "fn:a.ts:b", kind: "Function", name: "b" });
  store.upsertEdge({ type: "CALLS", from: "fn:a.ts:a", to: "fn:a.ts:b", sources: ["parser"], evidence: ev() });
  store.upsertEdge({ type: "CALLS", from: "fn:a.ts:b", to: "fn:a.ts:a", sources: ["parser"], evidence: ev() });
  const report = insights(store);
  assert.ok((report.counts.cycles as number) >= 1, "expected at least one cycle");
  const cycles = (report.insights as { cycles: string[][] }).cycles;
  assert.ok(cycles.some((c) => c.includes("fn:a.ts:a") && c.includes("fn:a.ts:b")));
  assert.ok(report.risk.includes("cycles"));
  store.close();
});

test("insights identifies a hub by degree", () => {
  const store = new GraphStore(":memory:");
  store.upsertNode({ id: "fn:h.ts:hub", kind: "Function", name: "hub" });
  for (let i = 0; i < 5; i += 1) {
    const id = `fn:h.ts:c${i}`;
    store.upsertNode({ id, kind: "Function", name: `c${i}` });
    store.upsertEdge({ type: "CALLS", from: id, to: "fn:h.ts:hub", sources: ["parser"], evidence: ev("h.ts") });
  }
  const report = insights(store);
  const hubs = (report.insights as { hubs: Array<{ id: string; degree: number }> }).hubs;
  assert.equal(hubs[0]?.id, "fn:h.ts:hub");
  assert.ok(hubs[0]!.degree >= 5);
  store.close();
});

test("insights reports isolated nodes", () => {
  const store = new GraphStore(":memory:");
  store.upsertNode({ id: "fn:i.ts:lonely", kind: "Function", name: "lonely" });
  store.upsertNode({ id: "fn:i.ts:x", kind: "Function", name: "x" });
  store.upsertNode({ id: "fn:i.ts:y", kind: "Function", name: "y" });
  store.upsertEdge({ type: "CALLS", from: "fn:i.ts:x", to: "fn:i.ts:y", sources: ["parser"], evidence: ev("i.ts") });
  const report = insights(store);
  const isolated = (report.insights as { isolated: string[] }).isolated;
  assert.ok(isolated.includes("fn:i.ts:lonely"));
  assert.ok(!isolated.includes("fn:i.ts:x"));
  store.close();
});

test("insights uses the degree proxy for hotspots when no git history is present", () => {
  const store = new GraphStore(":memory:", "/nonexistent-workspace-xyz");
  store.upsertNode({ id: "fn:a.ts:a", kind: "Function", name: "a" });
  store.upsertNode({ id: "fn:a.ts:b", kind: "Function", name: "b" });
  store.upsertEdge({ type: "CALLS", from: "fn:a.ts:a", to: "fn:a.ts:b", sources: ["parser"], evidence: ev() });
  const report = insights(store, { workspace: "/nonexistent-workspace-xyz" });
  assert.equal((report.insights as { hotspots_via: string }).hotspots_via, "degree-proxy");
  store.close();
});

test("insights surfaces large downstream impact", () => {
  const store = new GraphStore(":memory:");
  // leaf <- mid <- top  (changing leaf impacts mid and top downstream)
  store.upsertNode({ id: "fn:d.ts:leaf", kind: "Function", name: "leaf" });
  store.upsertNode({ id: "fn:d.ts:mid", kind: "Function", name: "mid" });
  store.upsertNode({ id: "fn:d.ts:top", kind: "Function", name: "top" });
  store.upsertEdge({ type: "CALLS", from: "fn:d.ts:mid", to: "fn:d.ts:leaf", sources: ["parser"], evidence: ev("d.ts") });
  store.upsertEdge({ type: "CALLS", from: "fn:d.ts:top", to: "fn:d.ts:mid", sources: ["parser"], evidence: ev("d.ts") });
  const report = insights(store);
  const large = (report.insights as { large_downstream_impact: Array<{ id: string; downstream: number }> }).large_downstream_impact;
  const leaf = large.find((l) => l.id === "fn:d.ts:leaf");
  assert.ok(leaf, "leaf should have downstream impact");
  assert.ok(leaf!.downstream >= 2);
  store.close();
});
