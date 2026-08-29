/**
 * Optional LLM-assisted features. Each has a deterministic fallback so the
 * product works fully with no model configured. The LLM only ever narrates or
 * names; it never invents graph edges (that rule lives in the Core).
 */

import type { Envelope, GraphNode } from "../core/contracts.js";
import { complete, loadLlmConfig, type LlmConfig } from "./client.js";

/** Deterministic one-line narration from the impact envelope + evidence. */
export function deterministicNarration(target: string, impact: Envelope): string {
  const count = impact.nodes.filter((n) => n.id !== target).length;
  const risks = impact.risk.length ? ` Risks: ${impact.risk.join(", ")}.` : "";
  const firstPath = impact.paths[0];
  const chain = firstPath ? firstPath.nodes.join(" \u2192 ") : target;
  return `Changing ${target} affects ${count} node(s).${risks} Example path: ${chain}.`;
}

/**
 * Narrate an impact result. Uses the LLM only when configured, constrained to
 * the returned evidence; otherwise returns the deterministic sentence.
 */
export async function narrateImpact(target: string, impact: Envelope, config: LlmConfig = loadLlmConfig()): Promise<{ narration: string; via: "llm" | "deterministic" }> {
  const deterministic = deterministicNarration(target, impact);
  if (!config.configured) return { narration: deterministic, via: "deterministic" };
  const paths = impact.paths.slice(0, 5).map((p) => p.nodes.join(" -> ")).join("\n");
  const prompt = `Summarize the blast radius of changing ${target} in two sentences. Use ONLY these evidence-backed paths; do not invent nodes.\nPaths:\n${paths}\nRisks: ${impact.risk.join(", ") || "none"}`;
  const result = await complete(prompt, { system: "You are a precise software architecture assistant. Never invent code relationships.", maxTokens: 200, config });
  if (result.ok && result.text.trim()) return { narration: result.text.trim(), via: "llm" };
  return { narration: deterministic, via: "deterministic" };
}

/** Deterministic domain label from directory + node kinds. */
export function deterministicDomain(nodes: GraphNode[]): string {
  const dirs = new Map<string, number>();
  for (const node of nodes) {
    if (!node.path) continue;
    const top = node.path.split("/")[0] ?? node.path;
    dirs.set(top, (dirs.get(top) ?? 0) + 1);
  }
  const top = [...dirs.entries()].sort((a, b) => b[1] - a[1])[0];
  return top ? top[0] : "workspace";
}
