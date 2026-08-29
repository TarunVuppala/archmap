/**
 * Evidence-backed SQLite graph store (TypeScript Core).
 *
 * Ported from the Python reference (archmap/graph/store.py). Owns the ONE
 * graph: canonical upsert with single-row logical edges, evidence validation,
 * conflict handling, neighbors, journal, health, and RAG chunks. Impact,
 * why-path, and diff live in sibling Core modules but read this store.
 */

import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  ContractError,
  type EdgeSource,
  type Evidence,
  type GraphEdge,
  type GraphNode,
  isEdgeType,
  isNodeKind,
  normalizeSources,
  nowIso,
} from "./contracts.js";
import { edgeId as computeEdgeId } from "./ids.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS nodes (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  repo TEXT,
  path TEXT,
  start_line INTEGER,
  end_line INTEGER,
  signature TEXT,
  summary TEXT,
  extra TEXT NOT NULL DEFAULT '{}',
  critical INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS edges (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  from_id TEXT NOT NULL,
  to_id TEXT NOT NULL,
  evidence TEXT NOT NULL,
  sources TEXT NOT NULL,
  confidence REAL,
  conflict INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  UNIQUE(type, from_id, to_id)
);
CREATE INDEX IF NOT EXISTS edges_from_idx ON edges(from_id);
CREATE INDEX IF NOT EXISTS edges_to_idx ON edges(to_id);
CREATE TABLE IF NOT EXISTS chunks (
  id TEXT PRIMARY KEY,
  node_id TEXT,
  kind TEXT,
  text TEXT NOT NULL,
  embedding BLOB,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS journal (
  ts TEXT NOT NULL,
  event TEXT NOT NULL,
  payload TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS health (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

/** Direction rules used by impact traversal (ported verbatim). */
export const DOWNSTREAM: Record<string, "forward" | "inverse"> = {
  CALLS: "inverse",
  EXPOSES: "forward",
  CONSUMES: "inverse",
  WRITES: "inverse",
  PUBLISHES: "forward",
  TESTS: "inverse",
  DEPENDS_ON: "inverse",
};

export const UPSTREAM: Record<string, "forward" | "inverse"> = {
  CALLS: "forward",
  IMPORTS: "forward",
  READS: "forward",
  CONSUMES: "forward",
  DEPENDS_ON: "forward",
};

export class GraphError extends ContractError {
  constructor(message: string) {
    super(message);
    this.name = "GraphError";
  }
}

interface NodeRow {
  id: string;
  kind: string;
  name: string;
  repo: string | null;
  path: string | null;
  start_line: number | null;
  end_line: number | null;
  signature: string | null;
  summary: string | null;
  extra: string;
  critical: number;
  updated_at: string;
}

interface EdgeRow {
  id: string;
  type: string;
  from_id: string;
  to_id: string;
  evidence: string;
  sources: string;
  confidence: number | null;
  conflict: number;
  updated_at: string;
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

export class GraphStore {
  readonly db: Database.Database;
  readonly workspaceRoot: string | null;

  constructor(databasePath: string, workspaceRoot: string | null = null) {
    if (databasePath !== ":memory:") {
      mkdirSync(dirname(databasePath), { recursive: true });
    }
    this.workspaceRoot = workspaceRoot;
    this.db = new Database(databasePath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  // ---- nodes ----------------------------------------------------------------

  upsertNode(node: Partial<GraphNode>): GraphNode {
    const id = String(node.id ?? "").trim();
    const kind = String(node.kind ?? "").trim();
    const name = String(node.name ?? "").trim();
    if (!id || !name) throw new GraphError("node id and name are required");
    if (!isNodeKind(kind)) throw new GraphError(`unsupported node kind: ${kind}`);
    const extra = node.extra ?? {};
    if (typeof extra !== "object") throw new GraphError("node extra must be an object or array");

    this.db
      .prepare(
        `INSERT INTO nodes (id, kind, name, repo, path, start_line, end_line, signature, summary, extra, critical, updated_at)
         VALUES (@id, @kind, @name, @repo, @path, @start_line, @end_line, @signature, @summary, @extra, @critical, @updated_at)
         ON CONFLICT(id) DO UPDATE SET
           kind=excluded.kind, name=excluded.name, repo=excluded.repo, path=excluded.path,
           start_line=excluded.start_line, end_line=excluded.end_line, signature=excluded.signature,
           summary=excluded.summary, extra=excluded.extra, critical=excluded.critical, updated_at=excluded.updated_at`
      )
      .run({
        id,
        kind,
        name,
        repo: node.repo ?? null,
        path: node.path ?? null,
        start_line: node.start_line ?? null,
        end_line: node.end_line ?? null,
        signature: node.signature ?? null,
        summary: node.summary ?? null,
        extra: stableJson(extra),
        critical: node.critical ? 1 : 0,
        updated_at: node.updated_at ?? nowIso(),
      });
    return this.getNode(id) as GraphNode;
  }

  getNode(id: string): GraphNode | null {
    const row = this.db.prepare("SELECT * FROM nodes WHERE id = ?").get(id) as NodeRow | undefined;
    return row ? nodeFromRow(row) : null;
  }

  listNodes(limit = 50): GraphNode[] {
    const capped = Math.max(1, Math.min(limit, 500));
    const rows = this.db.prepare("SELECT * FROM nodes ORDER BY kind, id LIMIT ?").all(capped) as NodeRow[];
    return rows.map(nodeFromRow);
  }

  listFileNodes(): GraphNode[] {
    const rows = this.db.prepare("SELECT * FROM nodes WHERE kind = 'File' ORDER BY path, id").all() as NodeRow[];
    return rows.map(nodeFromRow);
  }

  findNodes(query: string, kind: string | null = null, limit = 20): GraphNode[] {
    const q = String(query ?? "").trim();
    if (!q) throw new GraphError("query is required");
    const capped = Math.max(1, Math.min(limit, 50));
    const like = `%${q}%`;
    const rows = kind
      ? (this.db
          .prepare(
            `SELECT * FROM nodes WHERE kind = ? AND (id LIKE ? OR name LIKE ?)
             ORDER BY CASE WHEN id = ? OR name = ? THEN 0 ELSE 1 END, kind, id LIMIT ?`
          )
          .all(kind, like, like, q, q, capped) as NodeRow[])
      : (this.db
          .prepare(
            `SELECT * FROM nodes WHERE id LIKE ? OR name LIKE ?
             ORDER BY CASE WHEN id = ? OR name = ? THEN 0 ELSE 1 END, kind, id LIMIT ?`
          )
          .all(like, like, q, q, capped) as NodeRow[]);
    return rows.map(nodeFromRow);
  }

  markCritical(id: string): GraphNode {
    const node = this.getNode(id);
    if (!node) throw new GraphError(`unknown node: ${id}`);
    node.critical = true;
    return this.upsertNode(node);
  }

  // ---- edges ----------------------------------------------------------------

  upsertEdge(edge: Partial<GraphEdge> & { from?: string; to?: string }): GraphEdge {
    const type = String(edge.type ?? "").trim();
    const from = String(edge.from ?? "").trim();
    const to = String(edge.to ?? "").trim();
    let id = String(edge.id ?? "").trim();
    if (!id && type && from && to) id = computeEdgeId(type, from, to);
    const sources = normalizeSources(edge.sources);
    const evidence = edge.evidence;
    if (!id || !type || !from || !to) throw new GraphError("edge id, type, from, and to are required");
    if (!isEdgeType(type)) throw new GraphError(`unsupported edge type: ${type}`);
    if (!this.getNode(from) || !this.getNode(to)) throw new GraphError("edge endpoints must already exist as nodes");
    this.validateEvidence(evidence, sources);

    const existing = (this.db.prepare("SELECT * FROM edges WHERE id = ?").get(id) as EdgeRow | undefined)
      ?? (this.db
        .prepare("SELECT * FROM edges WHERE type = ? AND from_id = ? AND to_id = ?")
        .get(type, from, to) as EdgeRow | undefined);
    if (existing) return this.mergeExistingEdge(existing, type, from, to, evidence, sources, edge);

    this.db
      .prepare(
        `INSERT INTO edges (id, type, from_id, to_id, evidence, sources, confidence, conflict, updated_at)
         VALUES (@id, @type, @from_id, @to_id, @evidence, @sources, @confidence, @conflict, @updated_at)`
      )
      .run({
        id,
        type,
        from_id: from,
        to_id: to,
        evidence: stableJson(evidence),
        sources: stableJson(sources),
        confidence: edge.confidence ?? null,
        conflict: edge.conflict ? 1 : 0,
        updated_at: edge.updated_at ?? nowIso(),
      });
    return this.getEdge(id) as GraphEdge;
  }

  getEdge(id: string): GraphEdge | null {
    const row = this.db.prepare("SELECT * FROM edges WHERE id = ?").get(id) as EdgeRow | undefined;
    return row ? edgeFromRow(row) : null;
  }

  listEdges(limit = 100): GraphEdge[] {
    const capped = Math.max(1, Math.min(limit, 1000));
    const rows = this.db.prepare("SELECT * FROM edges ORDER BY id LIMIT ?").all(capped) as EdgeRow[];
    return rows.map(edgeFromRow);
  }

  private mergeExistingEdge(
    row: EdgeRow,
    type: string,
    from: string,
    to: string,
    incomingEvidence: unknown,
    incomingSources: EdgeSource[],
    incoming: Partial<GraphEdge>
  ): GraphEdge {
    const current = edgeFromRow(row);
    let conflict = Boolean(current.conflict);
    const evidenceItems = Array.isArray(current.evidence) ? [...current.evidence] : [current.evidence];
    const sameIdentity = current.type === type && current.from === from && current.to === to;
    let candidate: unknown = incomingEvidence;
    if (!sameIdentity) {
      conflict = true;
      candidate = { edge_candidate: { type, from, to }, evidence: incomingEvidence };
    }
    const existingBlobs = new Set(evidenceItems.map((item) => stableJson(item)));
    if (!existingBlobs.has(stableJson(candidate))) {
      evidenceItems.push(candidate as Evidence);
    }
    const sources = Array.from(new Set([...current.sources, ...incomingSources]));
    const confidences = [current.confidence, incoming.confidence].filter(
      (value): value is number => typeof value === "number"
    );
    const confidence = confidences.length ? Math.max(...confidences) : null;
    const evidenceValue = evidenceItems.length === 1 ? evidenceItems[0] : evidenceItems;
    this.db
      .prepare(
        `UPDATE edges SET evidence = ?, sources = ?, confidence = ?, conflict = ?, updated_at = ? WHERE id = ?`
      )
      .run(stableJson(evidenceValue), stableJson(sources), confidence, conflict ? 1 : 0, incoming.updated_at ?? nowIso(), current.id);
    return this.getEdge(current.id) as GraphEdge;
  }

  private validateEvidence(evidence: unknown, sources: EdgeSource[]): void {
    if (evidence === undefined || evidence === null || (typeof evidence === "object" && Object.keys(evidence).length === 0)) {
      throw new GraphError("every edge requires evidence");
    }
    if (sources.every((s) => s === "user" || s === "agent")) return; // pins may omit file evidence
    const records = Array.isArray(evidence) ? evidence : [evidence];
    for (const record of records) {
      if (!record || typeof record !== "object") throw new GraphError("edge evidence entries must be objects");
      const ev = record as Evidence;
      if (!ev.file || typeof ev.line !== "number" || !ev.snippet) {
        throw new GraphError("automated edge evidence requires file, integer line, and snippet");
      }
    }
  }

  // ---- chunks (RAG) ---------------------------------------------------------

  upsertChunk(chunk: { id: string; node_id: string; kind?: string; text: string }): void {
    const id = String(chunk.id ?? "").trim();
    const nodeId = String(chunk.node_id ?? "").trim();
    const text = String(chunk.text ?? "").trim();
    if (!id || !nodeId || !text) throw new GraphError("chunk id, node_id, and text are required");
    if (!this.getNode(nodeId)) throw new GraphError("chunk node_id must already exist as a node");
    this.db
      .prepare(
        `INSERT INTO chunks (id, node_id, kind, text, embedding, updated_at)
         VALUES (?, ?, ?, ?, NULL, ?)
         ON CONFLICT(id) DO UPDATE SET node_id=excluded.node_id, kind=excluded.kind, text=excluded.text, updated_at=excluded.updated_at`
      )
      .run(id, nodeId, chunk.kind ?? "code", text, nowIso());
  }

  listChunks(limit = 1000): Array<{ id: string; node_id: string; kind: string | null; text: string }> {
    const capped = Math.max(1, Math.min(limit, 5000));
    return this.db.prepare("SELECT id, node_id, kind, text FROM chunks ORDER BY id LIMIT ?").all(capped) as Array<{
      id: string;
      node_id: string;
      kind: string | null;
      text: string;
    }>;
  }

  fileHasChunks(relativePath: string): boolean {
    const row = this.db
      .prepare("SELECT 1 FROM chunks c JOIN nodes n ON n.id = c.node_id WHERE n.path = ? LIMIT 1")
      .get(relativePath);
    return row !== undefined;
  }

  // ---- journal + health -----------------------------------------------------

  appendJournal(event: string, payload: Record<string, unknown>): void {
    this.db.prepare("INSERT INTO journal (ts, event, payload) VALUES (?, ?, ?)").run(nowIso(), event, stableJson(payload));
  }

  listJournal(event: string | null = null, limit = 100): Array<{ ts: string; event: string; payload: unknown }> {
    const capped = Math.max(1, Math.min(limit, 1000));
    const rows = event
      ? (this.db.prepare("SELECT ts, event, payload FROM journal WHERE event = ? ORDER BY rowid DESC LIMIT ?").all(event, capped) as Array<{ ts: string; event: string; payload: string }>)
      : (this.db.prepare("SELECT ts, event, payload FROM journal ORDER BY rowid DESC LIMIT ?").all(capped) as Array<{ ts: string; event: string; payload: string }>);
    return rows.map((r) => ({ ts: r.ts, event: r.event, payload: JSON.parse(r.payload) as unknown }));
  }

  setHealth(key: string, value: unknown): void {
    this.db
      .prepare(
        `INSERT INTO health (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`
      )
      .run(key, stableJson(value), nowIso());
  }

  getHealth(key: string): unknown {
    const row = this.db.prepare("SELECT value FROM health WHERE key = ?").get(key) as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as unknown) : null;
  }

  // ---- neighbors ------------------------------------------------------------

  neighbors(nodeId: string, direction: "in" | "out" | "both" = "both"): {
    node: GraphNode;
    edges: GraphEdge[];
    nodes: GraphNode[];
  } {
    const node = this.getNode(nodeId);
    if (!node) throw new GraphError(`unknown node: ${nodeId}`);
    const rows = this.db
      .prepare("SELECT * FROM edges WHERE from_id = ? OR to_id = ? ORDER BY id")
      .all(nodeId, nodeId) as EdgeRow[];
    const edges: GraphEdge[] = [];
    const neighborIds = new Set<string>();
    for (const row of rows) {
      if (direction === "out" && row.from_id !== nodeId) continue;
      if (direction === "in" && row.to_id !== nodeId) continue;
      const edge = edgeFromRow(row);
      edges.push(edge);
      neighborIds.add(edge.to === nodeId ? edge.from : edge.to);
    }
    const nodes = [node, ...[...neighborIds].sort().map((id) => this.getNode(id)).filter((n): n is GraphNode => n !== null)];
    return { node, edges, nodes };
  }

  /** Adjacency helper used by impact traversal. */
  directedNeighbors(nodeId: string, rules: Record<string, "forward" | "inverse">): Array<{ edge: GraphEdge; next: string }> {
    const rows = this.db
      .prepare("SELECT * FROM edges WHERE from_id = ? OR to_id = ? ORDER BY id")
      .all(nodeId, nodeId) as EdgeRow[];
    const out: Array<{ edge: GraphEdge; next: string }> = [];
    for (const row of rows) {
      const mode = rules[row.type];
      if (mode === "forward" && row.from_id === nodeId) out.push({ edge: edgeFromRow(row), next: row.to_id });
      else if (mode === "inverse" && row.to_id === nodeId) out.push({ edge: edgeFromRow(row), next: row.from_id });
    }
    return out;
  }

  degree(nodeId: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS d FROM edges WHERE from_id = ? OR to_id = ?")
      .get(nodeId, nodeId) as { d: number };
    return row.d;
  }

  // ---- projection helpers (maps) -------------------------------------------

  /** All nodes whose kind is in the given set. Ordered for determinism. */
  nodesByKinds(kinds: readonly string[], limit = 2000): GraphNode[] {
    if (kinds.length === 0) return [];
    const capped = Math.max(1, Math.min(limit, 5000));
    const placeholders = kinds.map(() => "?").join(",");
    const rows = this.db
      .prepare(`SELECT * FROM nodes WHERE kind IN (${placeholders}) ORDER BY kind, id LIMIT ?`)
      .all(...kinds, capped) as NodeRow[];
    return rows.map(nodeFromRow);
  }

  /** All edges whose type is in the given set. Ordered for determinism. */
  edgesByTypes(types: readonly string[], limit = 4000): GraphEdge[] {
    if (types.length === 0) return [];
    const capped = Math.max(1, Math.min(limit, 10000));
    const placeholders = types.map(() => "?").join(",");
    const rows = this.db
      .prepare(`SELECT * FROM edges WHERE type IN (${placeholders}) ORDER BY id LIMIT ?`)
      .all(...types, capped) as EdgeRow[];
    return rows.map(edgeFromRow);
  }

  countNodesByKind(): Record<string, number> {
    const rows = this.db.prepare("SELECT kind, COUNT(*) AS c FROM nodes GROUP BY kind").all() as Array<{ kind: string; c: number }>;
    const out: Record<string, number> = {};
    for (const r of rows) out[r.kind] = r.c;
    return out;
  }
}

function nodeFromRow(row: NodeRow): GraphNode {
  return {
    id: row.id,
    kind: row.kind as GraphNode["kind"],
    name: row.name,
    repo: row.repo,
    path: row.path,
    start_line: row.start_line,
    end_line: row.end_line,
    signature: row.signature,
    summary: row.summary,
    extra: JSON.parse(row.extra) as Record<string, unknown>,
    critical: Boolean(row.critical),
    updated_at: row.updated_at,
  };
}

function edgeFromRow(row: EdgeRow): GraphEdge {
  return {
    id: row.id,
    type: row.type as GraphEdge["type"],
    from: row.from_id,
    to: row.to_id,
    evidence: JSON.parse(row.evidence) as Evidence | Evidence[],
    sources: JSON.parse(row.sources) as GraphEdge["sources"],
    confidence: row.confidence,
    conflict: Boolean(row.conflict),
    updated_at: row.updated_at,
  };
}
