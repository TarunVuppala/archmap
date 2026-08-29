/**
 * evaluate_policy: Core-level policy evaluation over graph impact.
 *
 * Built-in warnings from AGENTS.md; block rules optionally come from
 * .archmap/policies.yaml. Policies warn (never block) by default in v1.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Envelope, GraphNode } from "./contracts.js";
import { impact } from "./impact.js";
import { GraphError, type GraphStore } from "./store.js";

function loadBlockKeys(workspace: string | null): Set<string> {
  const keys = new Set<string>();
  if (!workspace) return keys;
  const file = join(workspace, ".archmap", "policies.yaml");
  if (!existsSync(file)) return keys;
  const text = readFileSync(file, "utf8");
  for (const match of text.matchAll(/^\s*-?\s*([A-Za-z0-9_]+)\s*:\s*block\s*$/gm)) {
    if (match[1]) keys.add(match[1]);
  }
  if (/^\s*merge_gate\s*:\s*true\s*$/m.test(text)) keys.add("*");
  return keys;
}

export function evaluatePolicy(store: GraphStore, targetId: string, workspace: string | null = null): Envelope {
  let node = store.getNode(targetId);
  if (!node) {
    const matches = store.findNodes(targetId, null, 1);
    if (matches.length === 0) throw new GraphError(`unknown policy target: ${targetId}`);
    node = matches[0] as GraphNode;
  }
  const report = impact(store, node.id, { direction: "downstream" });
  const impacted = report.nodes;
  const blockKeys = loadBlockKeys(workspace);

  const violations: Array<{ key: string; severity: "warn" | "block"; block: boolean; message: string }> = [];
  const add = (key: string, message: string): void => {
    const blocked = blockKeys.has("*") || blockKeys.has(key);
    violations.push({ key, severity: blocked ? "block" : "warn", block: blocked, message });
  };

  const hasTests = impacted.some((n) => n.kind === "Test");
  if (node.critical && !hasTests) add("critical_without_tests", "critical node has zero TESTS on its impact path");
  if (impacted.some((n) => n.kind === "API") && !impacted.some((n) => n.kind === "Contract")) {
    add("public_route_without_contract", "public route on path with no Contract/OpenAPI update");
  }
  if ((report.edges as Array<{ type: string }>).some((e) => e.type === "WRITES")) {
    add("db_write_on_path", "change writes to a datastore on its impact path");
  }

  const blocked = violations.some((v) => v.block);
  return {
    ok: !blocked,
    nodes: impacted,
    edges: report.edges,
    paths: report.paths,
    counts: { violations: violations.length },
    risk: report.risk,
    evidence_used: report.evidence_used,
    policy: { target: node.id, violations, blocked },
  };
}
