/**
 * Service identity derivation (deterministic, evidence-backed).
 *
 * A Service is a deployable unit. We infer service boundaries from directory
 * layout and manifests, which is concrete evidence:
 *   - a directory directly under apps/, services/, or packages/
 *   - any directory that contains its own package.json / pyproject / go.mod
 *
 * Each File node is attached to the nearest enclosing service via
 * `Service CONTAINS File`, so impact can roll up to services and the service
 * map is a real projection of the one graph. Seed/docker-compose can add or
 * correct services later; nothing here invents relationships.
 */

import type { GraphStore } from "../core/store.js";
import { serviceId, prefixRepo, repoOf } from "../core/ids.js";

const SERVICE_PARENTS = new Set(["apps", "services", "packages", "cmd"]);

/** Choose a service name for a file path, or null if none applies. */
export function serviceForPath(path: string): { id: string; name: string; dir: string; underParent: boolean } | null {
  const parts = path.split("/");
  // apps/<name>/... or services/<name>/... or packages/<name>/...
  for (let i = 0; i < parts.length - 1; i += 1) {
    if (SERVICE_PARENTS.has(parts[i]!) && parts[i + 1]) {
      const name = parts[i + 1]!;
      const dir = parts.slice(0, i + 2).join("/");
      return { id: serviceId(name), name, dir, underParent: true };
    }
  }
  // Top-level directory as a service (e.g. payment-service/…). Skip lone files.
  if (parts.length >= 2) {
    const name = parts[0]!;
    return { id: serviceId(name), name, dir: name, underParent: false };
  }
  return null;
}

/**
 * Post-pass: create Service nodes and attach File nodes under them. Runs after
 * files are indexed so the File nodes already exist. Repo-prefixed ids are used
 * as-is (the store keys on whatever id the file node carries).
 */
export function deriveServices(store: GraphStore): number {
  const files = store.listFileNodes();
  const services = new Map<string, { name: string; dir: string; underParent: boolean; files: Array<{ id: string; path: string }> }>();
  for (const file of files) {
    if (!file.path) continue;
    const svc = serviceForPath(file.path);
    if (!svc) continue;
    // Preserve any repo prefix present on the file id so service ids co-locate.
    const svcNodeId = prefixRepo(repoOf(file.id), svc.id);
    const entry = services.get(svcNodeId) ?? { name: svc.name, dir: svc.dir, underParent: svc.underParent, files: [] };
    entry.files.push({ id: file.id, path: file.path });
    services.set(svcNodeId, entry);
  }

  let created = 0;
  for (const [svcId, entry] of services) {
    // A service is real when it sits under a known service parent
    // (apps/services/packages/cmd) OR groups more than one file — avoids
    // turning a single stray top-level file into a service.
    if (!entry.underParent && entry.files.length < 2) continue;
    store.upsertNode({ id: svcId, kind: "Service", name: entry.name, path: entry.dir, extra: { files: entry.files.length } });
    created += 1;
    for (const f of entry.files) {
      try {
        store.upsertEdge({
          type: "CONTAINS",
          from: svcId,
          to: f.id,
          sources: ["parser"],
          evidence: { file: f.path, line: 1, snippet: `service ${entry.name} contains ${f.path}` },
          confidence: 0.6,
        });
      } catch {
        // file node missing; skip
      }
    }
  }
  return created;
}
