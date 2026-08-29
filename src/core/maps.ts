/**
 * Maps: navigable projections of the ONE graph.
 *
 * A map is not a second graph — it is a filtered view of the same nodes/edges
 * already in the store, selected by node kind + edge type for a given lens.
 * Every view returns the canonical envelope plus `view` and a `mermaid` string,
 * so the CLI, ui, and mcp all render the same projection. Node/edge counts are
 * capped to keep the diagram legible (no hairball); the cap is reported in
 * `counts` and surfaced as a `truncated` risk chip when it bites.
 */

import type { Envelope, GraphEdge, GraphNode } from "./contracts.js";
import { errorEnvelope } from "./contracts.js";
import { toMermaid } from "./visualize.js";
import type { GraphStore } from "./store.js";

export const MAP_VIEWS = ["dependency", "call", "service", "api", "db", "hierarchical"] as const;
export type MapView = (typeof MAP_VIEWS)[number];

interface ViewSpec {
  /** Node kinds that anchor this view. */
  nodeKinds: readonly string[];
  /** Edge types projected in this view. */
  edgeTypes: readonly string[];
  /** Human description shown in the envelope. */
  description: string;
}

const VIEW_SPECS: Record<MapView, ViewSpec> = {
  dependency: {
    nodeKinds: ["File", "Module", "Package", "External"],
    edgeTypes: ["IMPORTS", "DEPENDS_ON"],
    description: "Module/file dependency graph (imports + declared dependencies).",
  },
  call: {
    nodeKinds: ["Function", "Method", "Class"],
    edgeTypes: ["CALLS"],
    description: "Call graph between functions and methods.",
  },
  service: {
    // Include the handlers/clients (Function/Method) and Files so the
    // EXPOSES/CONSUMES chains that link services via APIs are visible, plus the
    // Service CONTAINS edges that tie those symbols back to their service.
    nodeKinds: ["Service", "API", "External", "File", "Function", "Method"],
    edgeTypes: ["CONSUMES", "EXPOSES", "DEPENDS_ON", "CONTAINS"],
    description: "Service topology: services, their APIs, and who consumes/exposes them.",
  },
  api: {
    nodeKinds: ["API", "Service", "Contract", "Function", "Method"],
    edgeTypes: ["EXPOSES", "CONSUMES", "CONSTRAINED_BY", "DOCUMENTS"],
    description: "API surface: endpoints, their handlers, consumers, and specs.",
  },
  db: {
    nodeKinds: ["Table", "Column", "Service", "Function", "Method"],
    edgeTypes: ["READS", "WRITES", "CONTAINS"],
    description: "Data map: tables/columns and the code that reads or writes them.",
  },
  hierarchical: {
    nodeKinds: ["Repo", "Service", "Package", "Module", "File", "Class", "Interface", "Function", "Method", "Infra"],
    edgeTypes: ["CONTAINS"],
    description: "Containment tree: repos > services > files > symbols.",
  },
};

const DEFAULT_NODE_CAP = 150;
const DEFAULT_EDGE_CAP = 300;

export function isMapView(value: unknown): value is MapView {
  return typeof value === "string" && (MAP_VIEWS as readonly string[]).includes(value);
}

export interface MapOptions {
  nodeCap?: number;
  edgeCap?: number;
  /** Restrict the projection to the subgraph reachable from this node id. */
  focus?: string | null;
}

/**
 * Project the graph into a single view. Selects edges of the view's types,
 * keeps edges whose endpoints are relevant node kinds, and includes exactly the
 * nodes touched by those edges (plus, for `db`, the anchor tables even when
 * unread). Deterministic ordering; capped for legibility.
 */
export function projectMap(store: GraphStore, view: string, options: MapOptions = {}): Envelope {
  if (!isMapView(view)) {
    return errorEnvelope(`unknown map view: ${view}. valid: ${MAP_VIEWS.join(", ")}`);
  }
  const spec = VIEW_SPECS[view];
  const nodeCap = Math.max(1, options.nodeCap ?? DEFAULT_NODE_CAP);
  const edgeCap = Math.max(1, options.edgeCap ?? DEFAULT_EDGE_CAP);

  const allNodes = store.nodesByKinds(spec.nodeKinds);
  const nodeById = new Map(allNodes.map((n) => [n.id, n]));

  // Keep only edges whose both endpoints are in-view node kinds.
  const candidateEdges = store
    .edgesByTypes(spec.edgeTypes)
    .filter((e) => nodeById.has(e.from) && nodeById.has(e.to));

  const focused = options.focus ? focusEdges(candidateEdges, options.focus) : candidateEdges;

  const cappedEdges = focused.slice(0, edgeCap);
  const truncatedEdges = focused.length > cappedEdges.length;

  // Node set = endpoints actually used by the kept edges, plus isolated anchor
  // nodes so lenses like `db`/`service` still show unreferenced entities.
  const used = new Set<string>();
  for (const e of cappedEdges) {
    used.add(e.from);
    used.add(e.to);
  }
  const isolated = allNodes.filter((n) => !used.has(n.id) && isAnchorKind(view, n.kind));
  const nodeList: GraphNode[] = [
    ...[...used].map((id) => nodeById.get(id)).filter((n): n is GraphNode => Boolean(n)),
    ...isolated,
  ];
  nodeList.sort((a, b) => (a.kind === b.kind ? a.id.localeCompare(b.id) : a.kind.localeCompare(b.kind)));

  const cappedNodes = nodeList.slice(0, nodeCap);
  const truncatedNodes = nodeList.length > cappedNodes.length;
  const keepIds = new Set(cappedNodes.map((n) => n.id));
  const finalEdges = cappedEdges.filter((e) => keepIds.has(e.from) && keepIds.has(e.to));

  const risk: string[] = [];
  if (truncatedNodes || truncatedEdges) risk.push("truncated");
  if (cappedNodes.length === 0) risk.push("empty_view");

  const countsByKind = tallyByKind(cappedNodes);
  const countsByEdge = tallyByType(finalEdges);

  return {
    ok: true,
    nodes: cappedNodes,
    edges: finalEdges,
    paths: [],
    counts: {
      nodes: cappedNodes.length,
      edges: finalEdges.length,
      total_matching_nodes: nodeList.length,
      total_matching_edges: focused.length,
      ...prefixKeys("node_", countsByKind),
      ...prefixKeys("edge_", countsByEdge),
    },
    risk,
    evidence_used: finalEdges.every((e) => Boolean(e.evidence)),
    view,
    description: spec.description,
    node_kinds: spec.nodeKinds,
    edge_types: spec.edgeTypes,
    mermaid: toMermaid(cappedNodes, finalEdges),
  } as Envelope;
}

/** Anchor kinds that we keep even when they have no in-view edges. */
function isAnchorKind(view: MapView, kind: string): boolean {
  switch (view) {
    case "db":
      return kind === "Table";
    case "service":
      return kind === "Service";
    case "api":
      return kind === "API";
    default:
      return false;
  }
}

/** Restrict to edges within N hops of `focus` (both directions). */
function focusEdges(edges: GraphEdge[], focus: string): GraphEdge[] {
  const reachable = new Set<string>([focus]);
  // Fixpoint over a small graph is fine here.
  let grew = true;
  while (grew) {
    grew = false;
    for (const e of edges) {
      if (reachable.has(e.from) && !reachable.has(e.to)) {
        reachable.add(e.to);
        grew = true;
      }
      if (reachable.has(e.to) && !reachable.has(e.from)) {
        reachable.add(e.from);
        grew = true;
      }
    }
  }
  return edges.filter((e) => reachable.has(e.from) && reachable.has(e.to));
}

function tallyByKind(nodes: GraphNode[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const n of nodes) out[n.kind] = (out[n.kind] ?? 0) + 1;
  return out;
}

function tallyByType(edges: GraphEdge[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const e of edges) out[e.type] = (out[e.type] ?? 0) + 1;
  return out;
}

function prefixKeys(prefix: string, obj: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(obj)) out[`${prefix}${k}`] = v;
  return out;
}
