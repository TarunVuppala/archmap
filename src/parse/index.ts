/**
 * Layered parser entry point.
 *
 * Tier (a): rich tree-sitter extraction for TS/JS/Python/Java (calls, imports,
 *   routes, SQL).
 * Tier (b): universal structural regex extraction for any other language, so
 *   nothing is a dead end.
 * Tier (c): manifest/lockfile ingest (External/Doc) handled separately by the
 *   indexer.
 *
 * All tiers return the normalized ParseResult and attach evidence.
 */

import { extname } from "node:path";
import type { ParseResult } from "./types.js";
import { emptyResult } from "./types.js";
import { classId, fileId, functionId } from "../core/ids.js";
import { extractRich } from "./extract.js";
import { richLanguageFor } from "./treesitter.js";

export type { ParseResult } from "./types.js";

const STRUCTURAL_PATTERNS: Array<{ re: RegExp; kind: "Function" | "Class" | "Method"; group: number }> = [
  { re: /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/, kind: "Function", group: 1 },
  { re: /^\s*(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, kind: "Class", group: 1 },
  { re: /^\s*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/, kind: "Function", group: 1 },
  { re: /^\s*def\s+([A-Za-z_][\w]*)/, kind: "Function", group: 1 },
  { re: /^\s*class\s+([A-Za-z_][\w]*)/, kind: "Class", group: 1 },
  { re: /^\s*(?:func|fn|sub)\s+([A-Za-z_][\w]*)/, kind: "Function", group: 1 },
];

export function structuralParse(relPath: string, source: string): ParseResult {
  const result = emptyResult(extname(relPath).slice(1) || "text", "structural");
  const fid = fileId(relPath);
  result.nodes.push({ id: fid, kind: "File", name: relPath, path: relPath, extra: { lang: extname(relPath).slice(1) } });
  const lines = source.split(/\r?\n/);
  const seen = new Set<string>();
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    for (const pattern of STRUCTURAL_PATTERNS) {
      const match = pattern.re.exec(line);
      if (!match) continue;
      const name = match[pattern.group];
      if (!name) continue;
      const id = pattern.kind === "Class" ? classId(relPath, name) : functionId(relPath, name);
      if (seen.has(id)) continue;
      seen.add(id);
      const snippet = line.trim().slice(0, 200);
      result.nodes.push({ id, kind: pattern.kind, name, path: relPath, start_line: i + 1, end_line: i + 1, signature: snippet });
      result.edges.push({ type: "CONTAINS", from: fid, to: id, sources: ["parser"], evidence: { file: relPath, line: i + 1, snippet } });
      const chunkText = lines.slice(i, Math.min(lines.length, i + 20)).join("\n").trim().slice(0, 4000);
      if (chunkText) result.chunks.push({ node_id: id, text: chunkText });
      break;
    }
  }
  return result;
}

/** Parse a single file with the best available tier. */
export async function parseFile(relPath: string, source: string): Promise<ParseResult> {
  if (richLanguageFor(relPath)) {
    try {
      const rich = await extractRich(relPath, source);
      if (rich && rich.nodes.length > 0) return rich;
    } catch {
      // fall through to structural
    }
  }
  return structuralParse(relPath, source);
}
