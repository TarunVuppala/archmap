/**
 * LLM-assisted features (first-class pipeline stage, provider-neutral).
 *
 * The deterministic layer is the source of truth. These features add naming,
 * narration, docs-vs-usage reconciliation, and non-obvious coupling hints on
 * top. Hard rules:
 *  - The LLM never invents edges: any proposed edge carries `sources:["llm"]`
 *    and must pass the verifier (src/llm/verify.ts) before entering the graph.
 *  - When no model is configured, LLM-dependent outputs are returned as an
 *    explicit UNAVAILABLE sentinel — never silently skipped, never crashing.
 */

import type { Envelope, GraphNode } from "../core/contracts.js";
import type { ParsedEdge } from "../parse/types.js";
import { complete, loadLlmConfig, type LlmConfig } from "./client.js";

export const LLM_UNAVAILABLE = "unavailable — configure a model" as const;

export interface LlmOutput<T> {
  status: "ok" | "unavailable" | "error";
  value: T | null;
  detail?: string;
  via: "llm" | "deterministic";
}

function unavailable<T>(): LlmOutput<T> {
  return { status: "unavailable", value: null, detail: LLM_UNAVAILABLE, via: "deterministic" };
}

/** Deterministic one-line narration from the impact envelope + evidence. */
export function deterministicNarration(target: string, impact: Envelope): string {
  const count = impact.nodes.filter((n) => n.id !== target).length;
  const risks = impact.risk.length ? ` Risks: ${impact.risk.join(", ")}.` : "";
  const firstPath = impact.paths[0];
  const chain = firstPath ? firstPath.nodes.join(" \u2192 ") : target;
  return `Changing ${target} affects ${count} node(s).${risks} Example path: ${chain}.`;
}

/**
 * Narrate an impact result. Deterministic narration is always produced; when a
 * model is configured the LLM refines it (constrained to returned evidence).
 * `via` reports which path produced the final text, and `llm_status` makes the
 * absence of a model explicit rather than silent.
 */
export async function narrateImpact(
  target: string,
  impact: Envelope,
  config: LlmConfig = loadLlmConfig()
): Promise<{ narration: string; via: "llm" | "deterministic"; llm_status: string }> {
  const deterministic = deterministicNarration(target, impact);
  if (!config.configured) return { narration: deterministic, via: "deterministic", llm_status: LLM_UNAVAILABLE };
  const paths = impact.paths.slice(0, 5).map((p) => p.nodes.join(" -> ")).join("\n");
  const prompt = `Summarize the blast radius of changing ${target} in two sentences. Use ONLY these evidence-backed paths; do not invent nodes.\nPaths:\n${paths}\nRisks: ${impact.risk.join(", ") || "none"}`;
  const result = await complete(prompt, { system: "You are a precise software architecture assistant. Never invent code relationships.", maxTokens: 200, config });
  if (result.ok && result.text.trim()) return { narration: result.text.trim(), via: "llm", llm_status: "ok" };
  return { narration: deterministic, via: "deterministic", llm_status: result.error ?? "llm returned no text" };
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

/**
 * Propose a human domain/boundary name for a group of nodes. Requires a model;
 * returns an explicit UNAVAILABLE sentinel otherwise (the deterministic label
 * from directory structure is still provided as the fallback value).
 */
export async function nameDomain(nodes: GraphNode[], config: LlmConfig = loadLlmConfig()): Promise<LlmOutput<string>> {
  const fallback = deterministicDomain(nodes);
  if (!config.configured) return { status: "unavailable", value: fallback, detail: LLM_UNAVAILABLE, via: "deterministic" };
  const sample = nodes.slice(0, 20).map((n) => `${n.kind} ${n.name} (${n.path ?? ""})`).join("\n");
  const result = await complete(
    `Give a short domain name (1-3 words) for this group of code symbols. Reply with only the name.\n${sample}`,
    { system: "You name software domains concisely.", maxTokens: 12, config }
  );
  if (result.ok && result.text.trim()) return { status: "ok", value: result.text.trim().replace(/[".]/g, ""), via: "llm" };
  return { status: "error", value: fallback, detail: result.error ?? "no text", via: "deterministic" };
}

/**
 * Docs-vs-usage reconciliation: ask the model whether documented behavior
 * matches actual usage for an external/API. LLM-dependent; explicit sentinel
 * when no model. Never emits edges here (naming/narration only).
 */
export async function docsVsUsage(
  subject: string,
  documented: string,
  observedUsage: string,
  config: LlmConfig = loadLlmConfig()
): Promise<LlmOutput<string>> {
  if (!config.configured) return unavailable<string>();
  const result = await complete(
    `For ${subject}, does the documented behavior match observed usage? Answer in one sentence and flag any mismatch.\nDocumented:\n${documented}\nObserved usage:\n${observedUsage}`,
    { system: "You compare documentation against real usage precisely. Do not invent APIs.", maxTokens: 160, config }
  );
  if (result.ok && result.text.trim()) return { status: "ok", value: result.text.trim(), via: "llm" };
  return { status: "error", value: null, detail: result.error ?? "no text", via: "llm" };
}

/**
 * Non-obvious / dynamic coupling hints as PROPOSED edges. The model may only
 * propose edges that cite a real snippet; callers MUST pass the returned edges
 * through verifyLlmEdges before upserting. When no model is configured this
 * returns an explicit unavailable sentinel and zero edges.
 */
export async function proposeCouplingEdges(
  context: { file: string; source: string; candidateTargets: string[] },
  config: LlmConfig = loadLlmConfig()
): Promise<LlmOutput<ParsedEdge[]>> {
  if (!config.configured) return { status: "unavailable", value: [], detail: LLM_UNAVAILABLE, via: "deterministic" };
  const prompt = `Identify non-obvious runtime coupling in this file. Only report couplings you can back with an EXACT snippet copied from the file. Reply as JSON array of {from,to,type,line,snippet}. Allowed types: CALLS, PUBLISHES, SUBSCRIBES, DEPENDS_ON. Candidate target ids:\n${context.candidateTargets.join("\n")}\n\nFile ${context.file}:\n${context.source.slice(0, 6000)}`;
  const result = await complete(prompt, { system: "You surface hidden coupling. Never fabricate. Every item must quote a real snippet from the file.", maxTokens: 500, config });
  if (!result.ok) return { status: "error", value: [], detail: result.error ?? "no text", via: "llm" };
  let parsed: unknown;
  try {
    const match = result.text.match(/\[[\s\S]*\]/);
    parsed = match ? JSON.parse(match[0]) : [];
  } catch {
    return { status: "error", value: [], detail: "llm returned unparseable JSON", via: "llm" };
  }
  const edges: ParsedEdge[] = [];
  if (Array.isArray(parsed)) {
    for (const item of parsed as Array<Record<string, unknown>>) {
      const type = String(item.type ?? "");
      const from = String(item.from ?? "");
      const to = String(item.to ?? "");
      const snippet = String(item.snippet ?? "");
      const line = Number(item.line ?? 0);
      if (!type || !from || !to || !snippet) continue;
      edges.push({
        type: type as ParsedEdge["type"],
        from,
        to,
        sources: ["llm"],
        evidence: { file: context.file, line: Number.isFinite(line) ? line : 0, snippet },
        confidence: 0.5,
      });
    }
  }
  // NOTE: caller must verify these with verifyLlmEdges before persistence.
  return { status: "ok", value: edges, via: "llm" };
}
