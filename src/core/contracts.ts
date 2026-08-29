/**
 * Canonical vocabulary and JSON envelope contract for the Core.
 *
 * One definition of node kinds, edge types, and edge sources. Every surface
 * returns the same envelope shape. This is the single source of truth ported
 * from the Python reference (archmap/graph/store.py + core/contracts.py).
 */

export const CONTRACT_VERSION = "1.0.0";

export const NODE_KINDS = [
  "Repo",
  "File",
  "Module",
  "Package",
  "Class",
  "Interface",
  "Function",
  "Method",
  "Service",
  "API",
  "Route",
  "Table",
  "Column",
  "Event",
  "Job",
  "Test",
  "External",
  "Infra",
  "Doc",
  "Contract",
  "ConfigKey",
] as const;

export type NodeKind = (typeof NODE_KINDS)[number];

export const EDGE_TYPES = [
  "CONTAINS",
  "IMPORTS",
  "CALLS",
  "IMPLEMENTS",
  "EXPOSES",
  "CONSUMES",
  "READS",
  "WRITES",
  "PUBLISHES",
  "SUBSCRIBES",
  "TESTS",
  "DEPENDS_ON",
  "DOCUMENTS",
  "CONSTRAINED_BY",
  "CO_CHANGED",
  "BROKE_BEFORE",
  "USES_CONFIG",
] as const;

export type EdgeType = (typeof EDGE_TYPES)[number];

export const EDGE_SOURCES = [
  "parser",
  "git",
  "openapi",
  "lockfile",
  "coverage",
  "infra",
  "runtime",
  "user",
  "agent",
  "llm",
] as const;

export type EdgeSource = (typeof EDGE_SOURCES)[number];

const NODE_KIND_SET: ReadonlySet<string> = new Set(NODE_KINDS);
const EDGE_TYPE_SET: ReadonlySet<string> = new Set(EDGE_TYPES);
const EDGE_SOURCE_SET: ReadonlySet<string> = new Set(EDGE_SOURCES);

export function isNodeKind(value: unknown): value is NodeKind {
  return typeof value === "string" && NODE_KIND_SET.has(value);
}

export function isEdgeType(value: unknown): value is EdgeType {
  return typeof value === "string" && EDGE_TYPE_SET.has(value);
}

export function isEdgeSource(value: unknown): value is EdgeSource {
  return typeof value === "string" && EDGE_SOURCE_SET.has(value);
}

/** file/line/snippet evidence, or an explicit user/agent pin blob. */
export interface Evidence {
  file?: string;
  line?: number;
  snippet?: string;
  [key: string]: unknown;
}

export interface GraphNode {
  id: string;
  kind: NodeKind;
  name: string;
  repo?: string | null;
  path?: string | null;
  start_line?: number | null;
  end_line?: number | null;
  signature?: string | null;
  summary?: string | null;
  extra?: Record<string, unknown> | unknown[];
  critical?: boolean;
  updated_at?: string;
}

export interface GraphEdge {
  id: string;
  type: EdgeType;
  from: string;
  to: string;
  evidence: Evidence | Evidence[];
  sources: EdgeSource[];
  confidence?: number | null;
  conflict?: boolean;
  updated_at?: string;
}

export interface PathResult {
  nodes: string[];
  edges: GraphEdge[];
}

/** The canonical result envelope returned by every Core operation. */
export interface Envelope {
  ok: boolean;
  nodes: GraphNode[];
  edges: GraphEdge[];
  paths: PathResult[];
  counts: Record<string, number>;
  risk: string[];
  evidence_used: boolean;
  error?: string;
  [key: string]: unknown;
}

export const ENVELOPE_KEYS = [
  "ok",
  "nodes",
  "edges",
  "paths",
  "counts",
  "risk",
  "evidence_used",
] as const;

export class ContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContractError";
  }
}

export function emptyEnvelope(ok = true): Envelope {
  return { ok, nodes: [], edges: [], paths: [], counts: {}, risk: [], evidence_used: ok };
}

export function errorEnvelope(message: string): Envelope {
  const env = emptyEnvelope(false);
  env.error = message;
  return env;
}

export function canonicalEnvelope(partial: Partial<Envelope>): Envelope {
  const env = emptyEnvelope(partial.ok ?? true);
  Object.assign(env, partial);
  env.ok = Boolean(partial.ok ?? true);
  env.evidence_used = Boolean(partial.evidence_used ?? env.ok);
  return env;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function validateNode(node: Partial<GraphNode>): void {
  if (!node.id || String(node.id).trim() === "") throw new ContractError("node id is required");
  if (!node.name || String(node.name).trim() === "") throw new ContractError("node name is required");
  if (!isNodeKind(node.kind)) throw new ContractError(`unsupported node kind: ${String(node.kind)}`);
}

export function normalizeSources(value: unknown): EdgeSource[] {
  let list: unknown[];
  if (typeof value === "string") list = [value];
  else if (Array.isArray(value)) list = value;
  else throw new ContractError("edge sources must be a non-empty list");
  const seen = new Set<string>();
  const out: EdgeSource[] = [];
  for (const raw of list) {
    const s = String(raw);
    if (seen.has(s)) continue;
    if (!isEdgeSource(s)) throw new ContractError(`unsupported edge source: ${s}`);
    seen.add(s);
    out.push(s);
  }
  if (out.length === 0) throw new ContractError("edge sources must be a non-empty list");
  return out;
}

export function validateEdge(edge: Partial<GraphEdge>): void {
  if (!edge.id || String(edge.id).trim() === "") throw new ContractError("edge id is required");
  if (!isEdgeType(edge.type)) throw new ContractError(`unsupported edge type: ${String(edge.type)}`);
  if (!edge.from || !edge.to) throw new ContractError("edge from and to are required");
  normalizeSources(edge.sources);
  if (!edge.evidence) throw new ContractError("edge evidence is required");
}
