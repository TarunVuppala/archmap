/**
 * LLM edge verifier. Hard rule from AGENTS.md #7: the LLM never invents edges.
 * Every LLM-proposed edge MUST cite a snippet that exists in the cited file and
 * pass this verifier, or it is dropped. The deterministic graph remains the
 * source of truth; this gate is what lets LLM output enter the ONE graph.
 */

import { existsSync, readFileSync } from "node:fs";
import { join, isAbsolute } from "node:path";
import type { ParsedEdge } from "../parse/types.js";

export interface VerifyResult {
  accepted: ParsedEdge[];
  dropped: Array<{ edge: ParsedEdge; reason: string }>;
}

function evidenceRecords(edge: ParsedEdge): Array<{ file?: unknown; line?: unknown; snippet?: unknown }> {
  const ev = edge.evidence as unknown;
  if (Array.isArray(ev)) return ev as Array<{ file?: unknown; line?: unknown; snippet?: unknown }>;
  if (ev && typeof ev === "object") return [ev as { file?: unknown; line?: unknown; snippet?: unknown }];
  return [];
}

/**
 * Verify LLM-proposed edges against the real workspace. An edge is accepted
 * only if every evidence record cites a file that exists and a snippet that is
 * actually present in that file's text. Non-LLM edges pass through untouched.
 */
export function verifyLlmEdges(workspace: string, edges: ParsedEdge[]): VerifyResult {
  const accepted: ParsedEdge[] = [];
  const dropped: Array<{ edge: ParsedEdge; reason: string }> = [];
  const fileCache = new Map<string, string | null>();

  const readFile = (rel: string): string | null => {
    if (fileCache.has(rel)) return fileCache.get(rel) ?? null;
    const abs = isAbsolute(rel) ? rel : join(workspace, rel);
    let text: string | null = null;
    try {
      if (existsSync(abs)) text = readFileSync(abs, "utf8");
    } catch {
      text = null;
    }
    fileCache.set(rel, text);
    return text;
  };

  for (const edge of edges) {
    const sources = edge.sources ?? [];
    const isLlm = sources.includes("llm");
    if (!isLlm) {
      accepted.push(edge);
      continue;
    }
    const records = evidenceRecords(edge);
    if (records.length === 0) {
      dropped.push({ edge, reason: "llm edge has no evidence" });
      continue;
    }
    let ok = true;
    let reason = "";
    for (const rec of records) {
      const file = typeof rec.file === "string" ? rec.file : "";
      const snippet = typeof rec.snippet === "string" ? rec.snippet : "";
      if (!file || !snippet) {
        ok = false;
        reason = "llm evidence missing file or snippet";
        break;
      }
      const text = readFile(file);
      if (text === null) {
        ok = false;
        reason = `cited file not found: ${file}`;
        break;
      }
      if (!text.includes(snippet)) {
        ok = false;
        reason = `snippet not found in ${file}`;
        break;
      }
    }
    if (ok) accepted.push(edge);
    else dropped.push({ edge, reason });
  }

  return { accepted, dropped };
}
