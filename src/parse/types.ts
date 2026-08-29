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

export interface ParseResult {
  /** Extraction tier used, for observability and graceful-degradation notes. */
  mode: "tree-sitter" | "structural" | "manifest" | "none";
  language: string;
  nodes: ParsedNode[];
  edges: ParsedEdge[];
  /** node_id -> chunk text for RAG. */
  chunks: Array<{ node_id: string; text: string }>;
  diagnostics: string[];
}

export function emptyResult(language: string, mode: ParseResult["mode"] = "none"): ParseResult {
  return { mode, language, nodes: [], edges: [], chunks: [], diagnostics: [] };
}
