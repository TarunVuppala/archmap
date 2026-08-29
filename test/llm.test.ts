import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LLM_UNAVAILABLE,
  narrateImpact,
  nameDomain,
  docsVsUsage,
  proposeCouplingEdges,
} from "../src/llm/features.ts";
import { verifyLlmEdges } from "../src/llm/verify.ts";
import type { LlmConfig } from "../src/llm/client.ts";
import { GraphStore, impact } from "../src/core/index.ts";
import type { ParsedEdge } from "../src/parse/types.ts";

const UNCONFIGURED: LlmConfig = { configured: false };

function tinyImpact(): ReturnType<typeof impact> {
  const store = new GraphStore(":memory:");
  store.upsertNode({ id: "fn:a.ts:a", kind: "Function", name: "a" });
  store.upsertNode({ id: "fn:a.ts:b", kind: "Function", name: "b" });
  store.upsertEdge({ type: "CALLS", from: "fn:a.ts:a", to: "fn:a.ts:b", sources: ["parser"], evidence: { file: "a.ts", line: 1, snippet: "b()" } });
  const report = impact(store, "fn:a.ts:b", { direction: "downstream" });
  store.close();
  return report;
}

test("narrateImpact reports LLM unavailable (never silent) when no model is configured", async () => {
  const report = tinyImpact();
  const out = await narrateImpact("fn:a.ts:b", report, UNCONFIGURED);
  assert.equal(out.via, "deterministic");
  assert.equal(out.llm_status, LLM_UNAVAILABLE);
  assert.match(out.narration, /affects \d+ node/); // deterministic narration still produced
});

test("nameDomain returns unavailable sentinel + deterministic fallback value", async () => {
  const out = await nameDomain([{ id: "fn:web/a.ts:x", kind: "Function", name: "x", path: "web/a.ts" }], UNCONFIGURED);
  assert.equal(out.status, "unavailable");
  assert.equal(out.detail, LLM_UNAVAILABLE);
  assert.equal(out.value, "web"); // deterministic domain from directory
});

test("docsVsUsage is unavailable without a model (never crashes)", async () => {
  const out = await docsVsUsage("ext:express", "docs...", "usage...", UNCONFIGURED);
  assert.equal(out.status, "unavailable");
  assert.equal(out.detail, LLM_UNAVAILABLE);
});

test("proposeCouplingEdges yields no edges + unavailable when no model", async () => {
  const out = await proposeCouplingEdges({ file: "a.ts", source: "x", candidateTargets: ["fn:a.ts:a"] }, UNCONFIGURED);
  assert.equal(out.status, "unavailable");
  assert.deepEqual(out.value, []);
});

test("verifyLlmEdges DROPS an LLM edge whose snippet is not in the cited file", () => {
  const dir = mkdtempSync(join(tmpdir(), "archmap-verify-"));
  try {
    writeFileSync(join(dir, "a.ts"), "function a(){ return real(); }\n");
    const edges: ParsedEdge[] = [
      // real snippet present -> accepted
      { type: "CALLS", from: "fn:a.ts:a", to: "fn:a.ts:real", sources: ["llm"], evidence: { file: "a.ts", line: 1, snippet: "real()" } },
      // fabricated snippet -> dropped
      { type: "CALLS", from: "fn:a.ts:a", to: "fn:a.ts:ghost", sources: ["llm"], evidence: { file: "a.ts", line: 1, snippet: "ghost()" } },
    ];
    const { accepted, dropped } = verifyLlmEdges(dir, edges);
    assert.equal(accepted.length, 1);
    assert.equal(accepted[0]!.to, "fn:a.ts:real");
    assert.equal(dropped.length, 1);
    assert.equal(dropped[0]!.edge.to, "fn:a.ts:ghost");
    assert.match(dropped[0]!.reason, /snippet not found/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("verifyLlmEdges passes non-LLM edges through untouched", () => {
  const dir = mkdtempSync(join(tmpdir(), "archmap-verify2-"));
  try {
    writeFileSync(join(dir, "a.ts"), "x\n");
    const edges: ParsedEdge[] = [
      { type: "CALLS", from: "fn:a.ts:a", to: "fn:a.ts:b", sources: ["parser"], evidence: { file: "a.ts", line: 1, snippet: "not-checked-for-parser" } },
    ];
    const { accepted, dropped } = verifyLlmEdges(dir, edges);
    assert.equal(accepted.length, 1);
    assert.equal(dropped.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("verifyLlmEdges drops an LLM edge citing a non-existent file", () => {
  const dir = mkdtempSync(join(tmpdir(), "archmap-verify3-"));
  try {
    const edges: ParsedEdge[] = [
      { type: "CALLS", from: "fn:x:a", to: "fn:x:b", sources: ["llm"], evidence: { file: "nope.ts", line: 1, snippet: "whatever" } },
    ];
    const { accepted, dropped } = verifyLlmEdges(dir, edges);
    assert.equal(accepted.length, 0);
    assert.equal(dropped.length, 1);
    assert.match(dropped[0]!.reason, /file not found/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
