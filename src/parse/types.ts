/**
 * Normalized parser result model.
 *
 * All parsers (tree-sitter extractors, regex fallback, manifest/SQL ingest)
 * produce this shape, which the indexer upserts into the ONE graph. Parser
 * implementations may be language-specific; graph meaning is defined by the
 * Core, not the parser.
 */

import type { GraphNode, GraphEdge } from "../core/contracts.js";

export type ParsedNode = Omit<GraphNode, "updated_at">;
export type ParsedEdge = Omit<GraphEdge, "id" | "updated_at" | "conflict"> & { id?: string };

/**
 * A call whose target could not be resolved within the same file. The indexer
 * resolves these across the workspace by unique symbol name after all files are
 * parsed, so cross-file CALLS/TESTS edges form without inventing relationships
 * (only a unique name match is accepted; ambiguous names are dropped).
 */
export interface UnresolvedCall {
  from: string; // caller symbol id
  callee: string; // called name
  kind: "CALLS" | "TESTS";
  evidence: { file: string; line: number; snippet: string };
}

export interface ParseResult {
  /** Extraction tier used, for observability and graceful-degradation notes. */
  mode: "tree-sitter" | "structural" | "manifest" | "none";
  language: string;
  nodes: ParsedNode[];
  edges: ParsedEdge[];
  /** node_id -> chunk text for RAG. */
  chunks: Array<{ node_id: string; text: string }>;
  /** cross-file calls to resolve after the whole workspace is parsed. */
  unresolved: UnresolvedCall[];
  diagnostics: string[];
}

export function emptyResult(language: string, mode: ParseResult["mode"] = "none"): ParseResult {
  return { mode, language, nodes: [], edges: [], chunks: [], unresolved: [], diagnostics: [] };
}
