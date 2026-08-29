/**
 * Mermaid export over the one graph query result. Deterministic; no second
 * graph. React Flow / Cosmograph consume the same node/edge JSON in the ui.
 */

import type { GraphEdge, GraphNode } from "./contracts.js";

function safeId(id: string): string {
  return "n_" + id.replace(/[^A-Za-z0-9_]/g, "_");
}

export function toMermaid(nodes: GraphNode[], edges: GraphEdge[]): string {
  const lines = ["flowchart LR"];
  for (const node of nodes) {
    lines.push(`  ${safeId(node.id)}["${node.kind}: ${node.name.replace(/"/g, "'")}"]`);
  }
  for (const edge of edges) {
    lines.push(`  ${safeId(edge.from)} -->|${edge.type}| ${safeId(edge.to)}`);
  }
  return lines.join("\n");
}
