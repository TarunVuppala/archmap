/**
 * Architecture Mapper Core (TypeScript).
 *
 * The Core is the single source of truth for graph semantics, stable IDs,
 * evidence-backed edges, bounded impact, why-paths, diff-impact, policy,
 * validation, RAG search, and the canonical JSON envelope. Every surface
 * (CLI, ui, mcp, serve) consumes the Core and never reimplements it.
 */

export {
  CONTRACT_VERSION,
  NODE_KINDS,
  EDGE_TYPES,
  EDGE_SOURCES,
  ContractError,
  emptyEnvelope,
  errorEnvelope,
  canonicalEnvelope,
  validateNode,
  validateEdge,
  normalizeSources,
  isNodeKind,
  isEdgeType,
  isEdgeSource,
  nowIso,
} from "./contracts.js";
export type {
  NodeKind,
  EdgeType,
  EdgeSource,
  Evidence,
  GraphNode,
  GraphEdge,
  PathResult,
  Envelope,
} from "./contracts.js";

export * as ids from "./ids.js";
export { GraphStore, GraphError, DOWNSTREAM, UPSTREAM } from "./store.js";
export { validateGraph } from "./validate.js";
export { toMermaid } from "./visualize.js";
export { impact, whyPath, testsToRun, type ImpactOptions } from "./impact.js";
export { search, symbol } from "./search.js";
export { diffImpact, type SymbolChange, type ChangeKind } from "./diff.js";
export { evaluatePolicy } from "./policy.js";
export { flow } from "./flow.js";
export { planChange, route, orchestrate, type Tier } from "./agent.js";
export { insights, type InsightsOptions } from "./insights.js";
export { projectMap, MAP_VIEWS, isMapView, type MapView, type MapOptions } from "./maps.js";
export { computeRisk, type RiskProfile } from "./risk.js";
export { inferCrossRepoEdges } from "./crossrepo.js";
export { prefixRepo, hasRepoPrefix, repoOf } from "./ids.js";
export { serialize, deserialize } from "./serialize.js";
export {
  dispatch,
  resolvePaths,
  withStore,
  CORE_OPERATIONS,
  type CoreOperation,
  type DispatchArgs,
} from "./operations.js";
export {
  CONFORMANCE_GRAPH,
  CONFORMANCE_EXPECTATIONS,
  loadConformanceGraph,
} from "./fixtures.js";
