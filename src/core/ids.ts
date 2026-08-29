/**
 * Stable ID construction for the one graph of record.
 *
 * Same scheme as the reference implementation so IDs are portable and
 * deterministic: fn:<relpath>:<qual>, api:<METHOD>:<path>, table:<name>, and
 * edge ids e_<sha1(type\0from\0to)[:16]>.
 */

import { createHash } from "node:crypto";

export const repoId = (name: string): string => `repo:${name}`;
export const fileId = (relpath: string): string => `file:${relpath}`;
export const moduleId = (relpath: string): string => `mod:${relpath}`;
export const packageId = (name: string, version: string): string => `pkg:${name}@${version}`;
export const classId = (relpath: string, name: string): string => `cls:${relpath}:${name}`;
export const interfaceId = (relpath: string, name: string): string => `iface:${relpath}:${name}`;
export const functionId = (relpath: string, qual: string): string => `fn:${relpath}:${qual}`;
export const methodId = (relpath: string, qual: string): string => `fn:${relpath}:${qual}`;
export const serviceId = (id: string): string => `svc:${id}`;
export const apiId = (method: string, path: string): string => `api:${method.toUpperCase()}:${path}`;
export const routeId = (method: string, path: string): string => `api:${method.toUpperCase()}:${path}`;
export const tableId = (name: string): string => `table:${name}`;
export const columnId = (table: string, name: string): string => `col:${table}.${name}`;
export const eventId = (name: string): string => `event:${name}`;
export const jobId = (relpath: string, name: string): string => `job:${relpath}:${name}`;
export const testId = (relpath: string, name: string): string => `test:${relpath}:${name}`;
export const externalId = (name: string): string => `ext:${name}`;
export const infraId = (relpath: string): string => `infra:${relpath}`;
export const docId = (urlOrPath: string): string => `doc:${urlOrPath}`;
export const configId = (key: string): string => `cfg:${key}`;
export const contractId = (relpath: string): string => `contract:${relpath}`;

/**
 * Deterministic edge identity from (type, from, to). Matches the parser/pin
 * layers so a logical edge stays a single row regardless of which writer
 * created it.
 */
export function edgeId(type: string, from: string, to: string): string {
  const digest = createHash("sha1").update(`${type}\0${from}\0${to}`).digest("hex").slice(0, 16);
  return `e_${digest}`;
}

/**
 * Prefix a node id with its repo root when more than one root exists. The kind
 * prefix (`fn:`, `file:`, `api:`, …) is kept; the repo name is inserted right
 * after it as `repo:<name>/…`. Single-root graphs pass ids through unchanged so
 * existing IDs stay stable.
 *
 *   prefixRepo("payments", "fn:src/a.ts:x")  -> "fn:repo:payments/src/a.ts:x"
 *   prefixRepo("payments", "api:POST:/pay")  -> "api:repo:payments/POST:/pay"
 *   prefixRepo(null, id)                     -> id
 */
export function prefixRepo(repo: string | null | undefined, id: string): string {
  if (!repo) return id;
  const marker = "repo:";
  const sep = id.indexOf(":");
  if (sep < 0) return `${marker}${repo}/${id}`;
  const kind = id.slice(0, sep);
  const rest = id.slice(sep + 1);
  // Already prefixed — do not double-prefix.
  if (rest.startsWith(marker)) return id;
  return `${kind}:${marker}${repo}/${rest}`;
}

/** True when an id carries a repo prefix. */
export function hasRepoPrefix(id: string): boolean {
  const sep = id.indexOf(":");
  return sep >= 0 && id.slice(sep + 1).startsWith("repo:");
}

/** Extract the repo name from a prefixed id, or null. */
export function repoOf(id: string): string | null {
  const sep = id.indexOf(":");
  if (sep < 0) return null;
  const rest = id.slice(sep + 1);
  if (!rest.startsWith("repo:")) return null;
  const slash = rest.indexOf("/");
  return slash > 5 ? rest.slice(5, slash) : null;
}
