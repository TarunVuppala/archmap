/**
 * Bounded, deterministic agent primitives: plan_change, route, orchestrate.
 *
 * These are evidence-first and provider-neutral. route picks a capability tier
 * (deterministic / cheap / strong / verifier) without vendor lock-in.
 * orchestrate runs a bounded plan -> verify loop over the Core. No LLM is
 * required; all outputs are derived from the graph.
 */

import type { Envelope, GraphNode } from "./contracts.js";
import { impact } from "./impact.js";
import { evaluatePolicy } from "./policy.js";
import { validateGraph } from "./validate.js";
import { GraphError, type GraphStore } from "./store.js";

/** plan_change: an allowed-files + impacted + policy + tests envelope. */
export function planChange(store: GraphStore, targetId: string, intent = "", workspace: string | null = null): Envelope {
  let target = store.getNode(targetId);
  if (!target) {
    const matches = store.findNodes(targetId, null, 1);
    target = matches[0] ?? null;
  }
  if (!target) throw new GraphError(`unknown change target: ${targetId}`);

  const report = impact(store, target.id, { direction: "downstream" });
  const impacted = report.nodes.filter((n) => n.id !== target!.id);
  const allowedFiles = new Set<string>();
  if (target.path) allowedFiles.add(target.path);
  for (const node of report.nodes) {
    if (node.path && ["Function", "Method", "Class", "Module", "File"].includes(node.kind)) allowedFiles.add(node.path);
  }
  const tests = impacted.filter((n) => n.kind === "Test");
  const policy = evaluatePolicy(store, target.id, workspace);

  return {
    ok: true,
    nodes: report.nodes,
    edges: report.edges,
    paths: report.paths,
    counts: { impacted: impacted.length, allowed_files: allowedFiles.size, tests: tests.length },
    risk: report.risk,
    evidence_used: report.evidence_used,
    plan: {
      target: target.id,
      intent,
      allowed_files: [...allowedFiles].sort(),
      impacted: impacted.map((n) => n.id),
      tests_to_run: tests.map((n) => n.id),
      policies: (policy.policy as { violations: unknown[] }).violations,
      forbidden_actions: ["edit files outside allowed_files", "create a second source of truth"],
    },
  };
}

export type Tier = "deterministic" | "cheap" | "strong" | "verifier";

const DETERMINISTIC = new Set(["parsing", "graph_query", "impact", "diff", "search", "why_path", "tests_to_run", "validate"]);
const STRONG = new Set(["architecture", "dynamic_coupling", "plan_change", "incident"]);
const CHEAP = new Set(["summary", "classification", "narration", "routing"]);

/** route: capability/cost tier selection, provider-neutral. */
export function route(taskKind: string, opts: { securitySensitive?: boolean; ambiguity?: number } = {}): Envelope {
  const kind = String(taskKind ?? "").trim().toLowerCase();
  let tier: Tier;
  let reason: string;
  if (opts.securitySensitive) {
    tier = "verifier";
    reason = "security-sensitive work requires an independent verifier";
  } else if (DETERMINISTIC.has(kind)) {
    tier = "deterministic";
    reason = "deterministic tooling satisfies this with no model call";
  } else if (STRONG.has(kind) || (opts.ambiguity ?? 0) >= 0.6) {
    tier = "strong";
    reason = "high difficulty/ambiguity warrants a stronger model";
  } else if (CHEAP.has(kind) || (opts.ambiguity ?? 0) > 0) {
    tier = "cheap";
    reason = "a cheap model is sufficient";
  } else {
    tier = "deterministic";
    reason = "default to deterministic; escalate only when needed";
  }
  const relativeCost: Record<Tier, number> = { deterministic: 0, cheap: 1, strong: 10, verifier: 12 };
  return {
    ok: true,
    nodes: [],
    edges: [],
    paths: [],
    counts: {},
    risk: [],
    evidence_used: true,
    route: { tier, reason, estimated_relative_cost: relativeCost[tier], uses_model: tier !== "deterministic", provider_locked: false },
  };
}

/**
 * orchestrate: a bounded, verified workflow over the Core. Deterministic:
 * plan -> compute impact -> independently verify graph + envelope -> accept.
 */
export function orchestrate(store: GraphStore, targetId: string, intent = "", workspace: string | null = null): Envelope {
  const steps: Array<{ step: string; ok: boolean; detail: string }> = [];
  const record = (step: string, ok: boolean, detail = ""): void => {
    steps.push({ step, ok, detail });
  };

  const plan = planChange(store, targetId, intent, workspace);
  record("plan", plan.ok, `${(plan.counts.impacted as number) ?? 0} impacted`);

  const validation = validateGraph(store);
  record("verify_graph", validation.ok, `${validation.counts.failed ?? 0} checks failed`);

  const planTarget = (plan.plan as { target: string }).target;
  const recomputed = impact(store, planTarget, { direction: "downstream" });
  const stable = recomputed.nodes.length === plan.nodes.length;
  record("verify_impact_stable", stable, `${recomputed.nodes.length} vs ${plan.nodes.length}`);

  const accepted = steps.every((s) => s.ok);
  return {
    ok: accepted,
    nodes: plan.nodes,
    edges: plan.edges,
    paths: plan.paths,
    counts: plan.counts,
    risk: plan.risk,
    evidence_used: plan.evidence_used,
    orchestration: {
      target: planTarget,
      intent,
      steps,
      accepted,
      plan: plan.plan,
    },
  };
}
