/**
 * Non-code input ingestion: OpenAPI/AsyncAPI specs, SQL schema/migrations,
 * config files, and infra (docker-compose / Dockerfile).
 *
 * Each ingester returns the normalized ParseResult so the indexer upserts into
 * the ONE graph. Evidence (file, line, snippet) is always attached; nothing is
 * invented. Parsing is dependency-free (targeted regex / minimal YAML) — good
 * enough for the shapes we care about without a heavy parser dependency.
 */

import { basename, extname } from "node:path";
import type { ParseResult } from "./types.js";
import { emptyResult } from "./types.js";
import { apiId, tableId, columnId, configId, contractId, serviceId, infraId } from "../core/ids.js";

/** Which ingester (if any) handles this file. */
export function ingestKind(relPath: string): "openapi" | "sql" | "config" | "compose" | "dockerfile" | null {
  const name = basename(relPath).toLowerCase();
  const ext = extname(relPath).toLowerCase();
  if (/openapi|swagger|asyncapi/.test(name) && (ext === ".yaml" || ext === ".yml" || ext === ".json")) return "openapi";
  if (ext === ".sql") return "sql";
  if (name === "docker-compose.yml" || name === "docker-compose.yaml" || name === "compose.yml" || name === "compose.yaml") return "compose";
  if (name === "dockerfile" || name.startsWith("dockerfile.")) return "dockerfile";
  if (name === ".env" || name.startsWith(".env.") || name.endsWith(".env")) return "config";
  return null;
}

export function ingestFile(kind: NonNullable<ReturnType<typeof ingestKind>>, relPath: string, source: string): ParseResult {
  switch (kind) {
    case "openapi":
      return ingestOpenApi(relPath, source);
    case "sql":
      return ingestSql(relPath, source);
    case "config":
      return ingestConfig(relPath, source);
    case "compose":
      return ingestCompose(relPath, source);
    case "dockerfile":
      return ingestDockerfile(relPath, source);
  }
}

const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete", "options", "head"]);

/**
 * OpenAPI: extract `paths:` entries as API + Contract nodes. The spec is a
 * Contract that CONSTRAINED_BY the API it documents. Works on the common YAML
 * shape (indented `/path:` then `method:`) and JSON.
 */
function ingestOpenApi(relPath: string, source: string): ParseResult {
  const result = emptyResult("openapi", "manifest");
  const contract = contractId(relPath);
  result.nodes.push({ id: contract, kind: "Contract", name: `OpenAPI ${basename(relPath)}`, path: relPath });

  const lines = source.split(/\r?\n/);
  let currentPath: string | null = null;
  let pathsSeen = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (/^\s*paths\s*:/.test(line)) {
      pathsSeen = true;
      continue;
    }
    if (!pathsSeen) continue;
    // A route path key: e.g. "  /payments:" (YAML) or "  \"/payments\": {" (JSON)
    const pathMatch = /^\s*["']?(\/[A-Za-z0-9_{}\/.-]*)["']?\s*:/.exec(line);
    if (pathMatch && pathMatch[1]) {
      currentPath = pathMatch[1];
      continue;
    }
    // A method under the current path.
    const methodMatch = /^\s*["']?(get|post|put|patch|delete|options|head)["']?\s*:/i.exec(line);
    if (methodMatch && currentPath && HTTP_METHODS.has(methodMatch[1]!.toLowerCase())) {
      const method = methodMatch[1]!.toUpperCase();
      const api = apiId(method, currentPath);
      const snippet = `${method} ${currentPath}`;
      result.nodes.push({ id: api, kind: "API", name: snippet, extra: { method, path: currentPath, source: "openapi" } });
      result.edges.push({ type: "CONSTRAINED_BY", from: api, to: contract, sources: ["openapi"], evidence: { file: relPath, line: i + 1, snippet }, confidence: 0.9 });
      result.edges.push({ type: "DOCUMENTS", from: contract, to: api, sources: ["openapi"], evidence: { file: relPath, line: i + 1, snippet }, confidence: 0.9 });
    }
  }
  return result;
}

/** SQL: CREATE TABLE -> Table node + Column nodes (CONTAINS). */
function ingestSql(relPath: string, source: string): ParseResult {
  const result = emptyResult("sql", "manifest");
  const lines = source.split(/\r?\n/);
  const createRe = /create\s+table\s+(?:if\s+not\s+exists\s+)?["'`]?([A-Za-z_][\w.]*)["'`]?\s*\(/i;
  for (let i = 0; i < lines.length; i += 1) {
    const m = createRe.exec(lines[i] ?? "");
    if (!m || !m[1]) continue;
    const name = m[1].toLowerCase();
    const table = tableId(name);
    result.nodes.push({ id: table, kind: "Table", name, path: relPath, start_line: i + 1, extra: { source: "sql" } });
    // Columns until the matching close paren.
    for (let j = i + 1; j < lines.length; j += 1) {
      const raw = (lines[j] ?? "").trim();
      if (raw.startsWith(")") || /^\)\s*;?/.test(raw)) break;
      const col = /^["'`]?([A-Za-z_][\w]*)["'`]?\s+[A-Za-z]/.exec(raw);
      if (col && col[1] && !/^(primary|foreign|constraint|unique|key|index|check)$/i.test(col[1])) {
        const colName = col[1].toLowerCase();
        const cid = columnId(name, colName);
        result.nodes.push({ id: cid, kind: "Column", name: colName, path: relPath, start_line: j + 1 });
        result.edges.push({ type: "CONTAINS", from: table, to: cid, sources: ["parser"], evidence: { file: relPath, line: j + 1, snippet: raw.slice(0, 120) }, confidence: 0.9 });
      }
    }
  }
  return result;
}

/** .env / config -> ConfigKey nodes. */
function ingestConfig(relPath: string, source: string): ParseResult {
  const result = emptyResult("config", "manifest");
  const lines = source.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const raw = (lines[i] ?? "").trim();
    if (!raw || raw.startsWith("#")) continue;
    const m = /^([A-Z][A-Z0-9_]*)\s*=/.exec(raw);
    if (m && m[1]) {
      const key = m[1];
      const cfg = configId(key);
      result.nodes.push({ id: cfg, kind: "ConfigKey", name: key, path: relPath, start_line: i + 1 });
    }
  }
  return result;
}

/** docker-compose -> Service + Infra nodes (service names under `services:`). */
function ingestCompose(relPath: string, source: string): ParseResult {
  const result = emptyResult("compose", "manifest");
  const infra = infraId(relPath);
  result.nodes.push({ id: infra, kind: "Infra", name: basename(relPath), path: relPath, extra: { infra_kind: "compose" } });

  const lines = source.split(/\r?\n/);
  let inServices = false;
  let servicesIndent = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (/^\s*services\s*:/.test(line)) {
      inServices = true;
      servicesIndent = line.search(/\S/);
      continue;
    }
    if (!inServices) continue;
    const indent = line.search(/\S/);
    if (indent >= 0 && indent <= servicesIndent && !/^\s*services\s*:/.test(line)) {
      inServices = false;
      continue;
    }
    // A service key is the first indent level under services:.
    const svcMatch = /^(\s+)([A-Za-z0-9_.-]+)\s*:/.exec(line);
    if (svcMatch && svcMatch[2] && svcMatch[1]!.length === servicesIndent + 2) {
      const name = svcMatch[2];
      const svc = serviceId(name);
      result.nodes.push({ id: svc, kind: "Service", name, extra: { source: "compose" } });
      result.edges.push({ type: "CONTAINS", from: infra, to: svc, sources: ["infra"], evidence: { file: relPath, line: i + 1, snippet: `${name}:` }, confidence: 0.8 });
    }
  }
  return result;
}

/** Dockerfile -> Infra node. */
function ingestDockerfile(relPath: string, source: string): ParseResult {
  const result = emptyResult("dockerfile", "manifest");
  const infra = infraId(relPath);
  const firstFrom = source.split(/\r?\n/).find((l) => /^\s*FROM\s+/i.test(l)) ?? "";
  result.nodes.push({ id: infra, kind: "Infra", name: basename(relPath), path: relPath, extra: { infra_kind: "dockerfile", base: firstFrom.replace(/^\s*FROM\s+/i, "").trim() } });
  return result;
}
