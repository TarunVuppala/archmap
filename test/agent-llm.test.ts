import { test } from "node:test";
import assert from "node:assert/strict";
import { GraphStore, flow, planChange, route, orchestrate, loadConformanceGraph, CONFORMANCE_EXPECTATIONS } from "../src/core/index.ts";
import { loadLlmConfig, complete } from "../src/llm/client.ts";
import { narrateImpact, deterministicNarration } from "../src/llm/features.ts";
import { impact } from "../src/core/index.ts";

function conformStore(): GraphStore {
  const store = new GraphStore(":memory:");
  loadConformanceGraph(store);
  return store;
}

const START = CONFORMANCE_EXPECTATIONS.impactDownstream.start;

test("LLM is unconfigured by default and complete() degrades gracefully", async () => {
  const config = loadLlmConfig({} as NodeJS.ProcessEnv);
  assert.equal(config.configured, false);
  const result = await complete("hello", { config });
  assert.equal(result.ok, false);
  assert.equal(result.configured, false);
});

test("loadLlmConfig reads base url + model from env", () => {
  const config = loadLlmConfig({ ARCHMAP_LLM_BASE_URL: "http://localhost:11434/v1/", ARCHMAP_LLM_MODEL: "llama3.1" } as unknown as NodeJS.ProcessEnv);
  assert.equal(config.configured, true);
  assert.equal(config.baseUrl, "http://localhost:11434/v1");
  assert.equal(config.model, "llama3.1");
});

test("narrateImpact falls back to deterministic narration with no LLM", async () => {
  const store = conformStore();
  const report = impact(store, START);
  const { narration, via } = await narrateImpact(START, report, { configured: false });
  assert.equal(via, "deterministic");
  assert.equal(narration, deterministicNarration(START, report));
  assert.match(narration, /affects \d+ node/);
  store.close();
});

test("flow reconstructs ordered evidence-backed steps", () => {
  const store = conformStore();
  const report = flow(store, START);
  assert.equal(report.ok, true);
  const steps = (report.flow as { steps: Array<{ from: string; to: string; type: string }> }).steps;
  assert.ok(steps.length >= 1);
  assert.ok(steps.every((s) => s.from && s.to && s.type));
  assert.equal(report.evidence_used, true);
  store.close();
});

test("plan_change returns a bounded allowed-files envelope", () => {
  const store = conformStore();
  const report = planChange(store, START);
  assert.equal(report.ok, true);
  const plan = report.plan as { allowed_files: string[]; impacted: string[]; forbidden_actions: string[] };
  assert.ok(plan.allowed_files.includes("apps/payments/service.ts"));
  assert.ok(plan.forbidden_actions.length >= 1);
  store.close();
});

test("route picks tiers without provider lock-in", () => {
  const det = route("impact").route as { tier: string; provider_locked: boolean };
  assert.equal(det.tier, "deterministic");
  assert.equal(det.provider_locked, false);
  const strong = route("architecture").route as { tier: string };
  assert.equal(strong.tier, "strong");
  const verifier = route("anything", { securitySensitive: true }).route as { tier: string };
  assert.equal(verifier.tier, "verifier");
});

test("orchestrate runs a bounded plan->verify loop and accepts on a clean graph", () => {
  const store = conformStore();
  const report = orchestrate(store, START, "tighten validation");
  const orch = report.orchestration as { accepted: boolean; steps: Array<{ step: string; ok: boolean }> };
  assert.equal(orch.accepted, true);
  assert.ok(orch.steps.some((s) => s.step === "verify_graph" && s.ok));
  store.close();
});
