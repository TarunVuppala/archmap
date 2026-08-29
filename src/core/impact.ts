/**
 * Bounded impact traversal, why-paths, and tests-to-run.
 *
 * Ported from the Python reference (archmap/graph/store.py impact + queries).
 * Impact is a bounded BFS (depth <= 5, <= 7 why-paths) over the directional
 * edge rules, producing counts by kind, evidence-backed why-paths, and risk
 * chips. why_path is directed forward reachability over all edge types.
 */

import type { Envelope, GraphEdge, GraphNode, PathResult } from "./contracts.js";
import { DOWNSTREAM, GraphError, UPSTREAM, type GraphStore } from "./store.js";

export interface ImpactOptions {
  direction?: "downstream" | "upstream";
  depth?: number;
  maxPaths?: number;
}

const IMPACT_RELEVANT_KINDS = new Set(["Function", "Method", "Class", "Service", "API", "Table"]);

export function impact(store: GraphStore, startIds: string | string[], options: ImpactOptions = {}): Envelope {
  const direction = options.direction ?? "downstream";
  const depth = Math.min(Math.max(options.depth ?? 5, 0), 5);
  const maxPaths = Math.max(1, Math.min(options.maxPaths ?? 7, 7));
  const starts = Array.from(new Set((Array.isArray(startIds) ? startIds : [startIds]).map((s) => String(s).trim()).filter(Boolean)));
  if (starts.length === 0) throw new GraphError("at least one start node is required");
  if (direction !== "downstream" && direction !== "upstream") throw new GraphError("direction must be downstream or upstream");
  const missing = starts.find((id) => !store.getNode(id));
  if (missing) throw new GraphError(`unknown start node: ${missing}`);

  const rules = direction === "downstream" ? DOWNSTREAM : UPSTREAM;
  const queue: Array<{ current: string; nodes: string[]; edges: GraphEdge[] }> = starts.map((id) => ({
    current: id,
    nodes: [id],
    edges: [],
  }));
  const bestDepth = new Map<string, number>(starts.map((id) => [id, 0]));
  const discovered = new Set<string>(starts);
  const pathResults: PathResult[] = [];
  const edgeResults = new Map<string, GraphEdge>();

  while (queue.length > 0 && pathResults.length < maxPaths) {
    const item = queue.shift()!;
    if (item.edges.length >= depth) continue;
    for (const { edge, next } of store.directedNeighbors(item.current, rules)) {
      if (item.nodes.includes(next)) continue;
      const nextNodes = [...item.nodes, next];
      const nextEdges = [...item.edges, edge];
      discovered.add(next);
      edgeResults.set(edge.id, edge);
      pathResults.push({ nodes: nextNodes, edges: nextEdges });
      if (pathResults.length >= maxPaths) break;
      const nextDepth = item.edges.length + 1;
      if (nextDepth >= (bestDepth.get(next) ?? Number.MAX_SAFE_INTEGER)) continue;
      bestDepth.set(next, nextDepth);
      queue.push({ current: next, nodes: nextNodes, edges: nextEdges });
    }
  }

  const nodes = [...discovered].sort().map((id) => store.getNode(id)).filter((n): n is GraphNode => n !== null);
  const impacted = nodes.filter((n) => !starts.includes(n.id));
  const counts: Record<string, number> = {};
  for (const node of impacted) counts[node.kind] = (counts[node.kind] ?? 0) + 1;

  const edges = [...edgeResults.values()];
  const risk: string[] = [];
  if (impacted.length) risk.push("downstream");
  if (nodes.some((n) => n.critical)) risk.push("critical");
  if (edges.some((e) => e.type === "WRITES")) risk.push("db_write");
  if (impacted.some((n) => n.kind === "External")) risk.push("external");
  if (edges.some((e) => e.conflict)) risk.push("conflict");
  if (impacted.some((n) => store.degree(n.id) >= 10)) risk.push("high_degree");
  if (impacted.some((n) => IMPACT_RELEVANT_KINDS.has(n.kind)) && !impacted.some((n) => n.kind === "Test")) {
    risk.push("untested");
  }

  return {
    ok: true,
    nodes,
    edges,
    paths: pathResults,
    counts,
    risk,
    evidence_used: edges.every((e) => Boolean(e.evidence)),
    tests_to_run: impacted.filter((n) => n.kind === "Test"),
    docs: impacted.filter((n) => n.kind === "Doc"),
    suggested_reviewers: [],
  };
}

export function whyPath(store: GraphStore, fromId: string, toId: string, maxDepth = 5, maxPaths = 7): Envelope {
  if (!store.getNode(fromId) || !store.getNode(toId)) throw new GraphError("both why_path endpoints must exist");
  const depth = Math.min(Math.max(maxDepth, 0), 5);
  const paths = Math.max(1, Math.min(maxPaths, 7));

  const outgoing = new Map<string, GraphEdge[]>();
  for (const edge of store.listEdges(1000)) {
    const list = outgoing.get(edge.from) ?? [];
    list.push(edge);
    outgoing.set(edge.from, list);
  }

  const queue: Array<{ current: string; nodes: string[]; edges: GraphEdge[] }> = [
    { current: fromId, nodes: [fromId], edges: [] },
  ];
  const found: PathResult[] = [];
  while (queue.length > 0 && found.length < paths) {
    const item = queue.shift()!;
    if (item.current === toId) {
      found.push({ nodes: item.nodes, edges: item.edges });
      continue;
    }
    if (item.edges.length >= depth) continue;
    for (const edge of outgoing.get(item.current) ?? []) {
      if (item.nodes.includes(edge.to)) continue;
      queue.push({ current: edge.to, nodes: [...item.nodes, edge.to], edges: [...item.edges, edge] });
    }
  }

  const nodeIds = new Set<string>();
  for (const path of found) for (const id of path.nodes) nodeIds.add(id);
  const nodes = [...nodeIds].sort().map((id) => store.getNode(id)).filter((n): n is GraphNode => n !== null);
  const edges = found.flatMap((p) => p.edges);
  return {
    ok: true,
    nodes,
    edges,
    paths: found,
    counts: { paths: found.length },
    risk: [],
    evidence_used: edges.length > 0 ? edges.every((e) => Boolean(e.evidence)) : found.length > 0,
  };
}

export function testsToRun(store: GraphStore, identifier: string): Envelope {
  let target = store.getNode(identifier);
  if (!target) {
    const matches = store.findNodes(identifier, null, 1);
    target = matches[0] ?? null;
  }
  if (!target) throw new GraphError(`unknown symbol: ${identifier}`);
  const report = impact(store, target.id, { direction: "downstream" });
  const tests = (report.tests_to_run as GraphNode[]) ?? [];
  const paths = tests.map((t) => t.path).filter((p): p is string => Boolean(p));
  const commands: string[] = [];
  if (paths.some((p) => p.endsWith(".py"))) commands.push("python3 -m unittest discover -s tests -v");
  if (paths.some((p) => /\.(ts|tsx|js|jsx)$/.test(p))) commands.push("npm test");
  return {
    ok: true,
    nodes: tests,
    edges: [],
    paths: [],
    counts: { tests: tests.length },
    risk: tests.length === 0 ? ["untested"] : [],
    evidence_used: true,
    tests,
    commands,
  };
}
