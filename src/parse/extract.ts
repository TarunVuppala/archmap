/**
 * Rich AST extraction for TS/JS, Python, and Java over tree-sitter.
 *
 * Produces normalized nodes/edges with evidence (file, line, snippet):
 *  - symbols: Function / Method / Class (+ CONTAINS from the File)
 *  - CALLS edges between symbols resolved by name within the file
 *  - IMPORTS edges (File -> External) for import/require statements
 *  - EXPOSES edges (symbol -> API) for common route registrations
 *  - WRITES/READS edges (symbol -> Table) for SQL in string literals
 *
 * Evidence is always attached. Unresolved names are dropped rather than
 * invented, satisfying the "never invent edges" rule.
 */

import { extname } from "node:path";
import type { ParseResult, ParsedEdge } from "./types.js";
import { emptyResult } from "./types.js";
import { classId, externalId, fileId, functionId, apiId, tableId, interfaceId, eventId, testId } from "../core/ids.js";
import { parserForExtension, richLanguageFor, type TsNode } from "./treesitter.js";

type Lang = "ts" | "js" | "python" | "java";

interface SymbolDef {
  id: string;
  name: string;
  kind: "Function" | "Method" | "Class" | "Interface";
  line: number;
  endLine: number;
  snippet: string;
}

const SYMBOL_TYPES: Record<Lang, Record<string, "Function" | "Method" | "Class" | "Interface">> = {
  ts: { function_declaration: "Function", method_definition: "Method", class_declaration: "Class", generator_function_declaration: "Function", interface_declaration: "Interface" },
  js: { function_declaration: "Function", method_definition: "Method", class_declaration: "Class", generator_function_declaration: "Function" },
  python: { function_definition: "Function", class_definition: "Class" },
  java: { method_declaration: "Method", class_declaration: "Class", interface_declaration: "Interface", constructor_declaration: "Method" },
};

const ROUTE_METHODS = new Set(["get", "post", "put", "patch", "delete", "options", "head"]);
const SQL_WRITE = /\b(insert\s+into|update|delete\s+from)\s+["'`]?([a-zA-Z_][\w.]*)/i;
const SQL_READ = /\bfrom\s+["'`]?([a-zA-Z_][\w.]*)/i;

// HTTP client callees that indicate an outbound API call (service-to-service).
const HTTP_CLIENT_CALLEES = new Set(["fetch", "get", "post", "put", "patch", "delete", "request", "requests", "axios", "got", "ky", "httpx"]);
const HTTP_METHOD_HINT = /\b(GET|POST|PUT|PATCH|DELETE)\b/;
// Event pub/sub method names.
const PUBLISH_CALLEES = new Set(["emit", "publish", "dispatch", "send", "produce"]);
const SUBSCRIBE_CALLEES = new Set(["on", "subscribe", "addEventListener", "consume", "listen"]);

/** A test file by convention (name or path). Calls from here become TESTS edges. */
export function isTestPath(relPath: string): boolean {
  const p = relPath.toLowerCase();
  return /(^|\/)(tests?|__tests__|spec)\//.test(p) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(p) || /(^|\/)test_[^/]+\.py$/.test(p) || /_test\.(py|go|java)$/.test(p) || /tests?\.py$/.test(p);
}

/** Test node id for a test file, or null if not a test file. */
function testIdFor(relPath: string): string | null {
  return isTestPath(relPath) ? testId(relPath, "suite") : null;
}

function firstIdentifier(node: TsNode): string | null {
  const named = node.childForFieldName("name");
  if (named) return named.text;
  for (const child of node.namedChildren) {
    if (child.type.endsWith("identifier") || child.type === "identifier") return child.text;
  }
  return null;
}

function walk(node: TsNode, visit: (n: TsNode) => void): void {
  visit(node);
  for (let i = 0; i < node.childCount; i += 1) {
    const child = node.child(i);
    if (child) walk(child, visit);
  }
}

function enclosingSymbol(defs: SymbolDef[], line: number): SymbolDef | null {
  let best: SymbolDef | null = null;
  for (const def of defs) {
    if (line >= def.line && line <= def.endLine) {
      if (!best || def.line >= best.line) best = def;
    }
  }
  return best;
}

export async function extractRich(relPath: string, source: string): Promise<ParseResult | null> {
  const lang = richLanguageFor(relPath);
  if (!lang) return null;
  const parser = await parserForExtension(extname(relPath));
  if (!parser) return null;

  let tree;
  try {
    tree = parser.parse(source);
  } catch {
    return null;
  }

  const result = emptyResult(lang, "tree-sitter");
  const fid = fileId(relPath);
  result.nodes.push({ id: fid, kind: "File", name: relPath, path: relPath, extra: { lang } });

  const symbolTypes = SYMBOL_TYPES[lang];
  const defs: SymbolDef[] = [];
  const lines = source.split(/\r?\n/);

  // A test file gets a Test node; TESTS edges originate from it so
  // `tests_to_run` can find the covering tests as first-class Test nodes.
  const testNodeId = testIdFor(relPath);
  if (testNodeId) {
    result.nodes.push({ id: testNodeId, kind: "Test", name: relPath, path: relPath });
  }

  // Pass 1: symbols + CONTAINS + chunks.
  walk(tree.rootNode, (node) => {
    const kind = symbolTypes[node.type];
    if (!kind) return;
    const name = firstIdentifier(node);
    if (!name) return;
    const line = node.startPosition.row + 1;
    const endLine = node.endPosition.row + 1;
    const id = kind === "Class" ? classId(relPath, name) : kind === "Interface" ? interfaceId(relPath, name) : functionId(relPath, name);
    if (defs.some((d) => d.id === id)) return;
    const snippet = (lines[line - 1] ?? "").trim().slice(0, 200);
    defs.push({ id, name, kind, line, endLine, snippet });
    result.nodes.push({ id, kind, name, path: relPath, start_line: line, end_line: endLine, signature: snippet });
    result.edges.push({ type: "CONTAINS", from: fid, to: id, sources: ["parser"], evidence: { file: relPath, line, snippet } });
    const chunkText = lines.slice(line - 1, Math.min(endLine, line + 40)).join("\n").trim().slice(0, 4000);
    if (chunkText) result.chunks.push({ node_id: id, text: chunkText });
  });

  const defByName = new Map<string, SymbolDef>();
  for (const def of defs) if (!defByName.has(def.name)) defByName.set(def.name, def);
  const isTest = isTestPath(relPath);

  const stringArgs = (node: TsNode): string[] => {
    const args = node.childForFieldName("arguments");
    const out: string[] = [];
    if (args) for (const c of args.namedChildren) if (/string/.test(c.type)) out.push(stripQuotes(c.text));
    return out;
  };

  // Pass 2: calls, imports, routes, SQL, http-client CONSUMES, tests, events, implements.
  walk(tree.rootNode, (node) => {
    // IMPLEMENTS: class ... implements X / extends X (java + ts)
    if (node.type === "class_declaration") {
      const line = node.startPosition.row + 1;
      const clsName = firstIdentifier(node);
      const cls = clsName ? defByName.get(clsName) : null;
      if (cls) {
        walk(node, (child) => {
          if (child.type === "implements_clause" || child.type === "super_interfaces" || child.type === "extends_type_clause") {
            for (const t of child.namedChildren) {
              const ifaceName = lastName(t.text);
              const iface = defByName.get(ifaceName);
              const snippet = (lines[line - 1] ?? "").trim().slice(0, 200);
              if (iface) result.edges.push({ type: "IMPLEMENTS", from: cls.id, to: iface.id, sources: ["parser"], evidence: { file: relPath, line, snippet }, confidence: 0.8 });
            }
          }
        });
      }
    }

    // CALLS / route registration / http-client CONSUMES / events / TESTS
    if (node.type === "call_expression" || node.type === "call" || node.type === "method_invocation") {
      const fn = node.childForFieldName("function") ?? node.childForFieldName("name") ?? node.namedChildren[0];
      const calleeText = fn ? fn.text : "";
      const callee = fn ? lastName(fn.text) : null;
      const line = node.startPosition.row + 1;
      const snippet = (lines[line - 1] ?? "").trim().slice(0, 200);
      const caller = enclosingSymbol(defs, line);
      if (!callee) return;

      // in-file CALLS (and TESTS when the call is inside a test file).
      // In a test file the "caller" is the enclosing symbol if any, otherwise
      // the test File itself (tests often call at top level or in callbacks).
      const target = defByName.get(callee);
      const testFrom = testNodeId ?? (caller ? caller.id : fid);
      const notPlumbing = !HTTP_CLIENT_CALLEES.has(callee.toLowerCase()) && !ROUTE_METHODS.has(callee.toLowerCase()) && !PUBLISH_CALLEES.has(callee.toLowerCase()) && !SUBSCRIBE_CALLEES.has(callee.toLowerCase());
      if (caller && target && target.id !== caller.id) {
        result.edges.push({ type: "CALLS", from: caller.id, to: target.id, sources: ["parser"], evidence: { file: relPath, line, snippet }, confidence: 0.9 });
      }
      if (isTest && notPlumbing) {
        if (target) result.edges.push({ type: "TESTS", from: testFrom, to: target.id, sources: ["parser"], evidence: { file: relPath, line, snippet }, confidence: 0.8 });
        else result.unresolved.push({ from: testFrom, callee, kind: "TESTS", evidence: { file: relPath, line, snippet } });
      }
      if (caller && !target && notPlumbing) {
        // Target not in this file — resolve CALLS across the workspace later.
        result.unresolved.push({ from: caller.id, callee, kind: "CALLS", evidence: { file: relPath, line, snippet } });
      }

      // Route registration -> EXPOSES api
      if (ROUTE_METHODS.has(callee.toLowerCase()) && !/^https?:/.test(calleeText)) {
        const routePath = stringArgs(node)[0];
        if (routePath && routePath.startsWith("/")) {
          const api = apiId(callee, routePath);
          result.nodes.push({ id: api, kind: "API", name: `${callee.toUpperCase()} ${routePath}`, extra: { method: callee.toUpperCase(), path: routePath } });
          const owner = caller ?? defs[0];
          if (owner) result.edges.push({ type: "EXPOSES", from: owner.id, to: api, sources: ["parser"], evidence: { file: relPath, line, snippet }, confidence: 0.7 });
        }
      }

      // Outbound HTTP client call -> CONSUMES api (service-to-service).
      if (caller && HTTP_CLIENT_CALLEES.has(callee.toLowerCase())) {
        const args = stringArgs(node);
        const pathArg = args.find((a) => a.startsWith("/") || /^https?:\/\//.test(a));
        if (pathArg) {
          const routePath = pathArg.replace(/^https?:\/\/[^/]+/, "");
          // Method: fetch(..,{method:'POST'}) or axios.post(...) etc.
          const bodyMethod = HTTP_METHOD_HINT.exec(snippet.toUpperCase())?.[1];
          const verbFromCallee = ROUTE_METHODS.has(callee.toLowerCase()) ? callee.toUpperCase() : null;
          const method = (verbFromCallee ?? bodyMethod ?? "GET").toUpperCase();
          if (routePath.startsWith("/")) {
            const api = apiId(method, routePath);
            result.nodes.push({ id: api, kind: "API", name: `${method} ${routePath}`, extra: { method, path: routePath } });
            result.edges.push({ type: "CONSUMES", from: caller.id, to: api, sources: ["parser"], evidence: { file: relPath, line, snippet }, confidence: 0.6 });
          }
        }
      }

      // Events: emit/publish/on/subscribe('event-name', ...)
      if (caller && (PUBLISH_CALLEES.has(callee.toLowerCase()) || SUBSCRIBE_CALLEES.has(callee.toLowerCase()))) {
        const evName = stringArgs(node)[0];
        if (evName && /^[A-Za-z][\w.:-]*$/.test(evName)) {
          const ev = eventId(evName);
          result.nodes.push({ id: ev, kind: "Event", name: evName });
          const type = PUBLISH_CALLEES.has(callee.toLowerCase()) ? "PUBLISHES" : "SUBSCRIBES";
          result.edges.push({ type, from: caller.id, to: ev, sources: ["parser"], evidence: { file: relPath, line, snippet }, confidence: 0.5 });
        }
      }
    }

    // IMPORTS: local (file->file) vs external
    if (node.type === "import_statement" || node.type === "import_from_statement" || node.type === "import_declaration") {
      const line = node.startPosition.row + 1;
      const mod = importTarget(node);
      const snippet = (lines[line - 1] ?? "").trim().slice(0, 200);
      if (mod && !mod.startsWith(".")) {
        const ext = externalId(mod);
        result.nodes.push({ id: ext, kind: "External", name: mod });
        result.edges.push({ type: "IMPORTS", from: fid, to: ext, sources: ["parser"], evidence: { file: relPath, line, snippet }, confidence: 0.8 });
      } else if (mod && mod.startsWith(".")) {
        // Local module import: record the resolved sibling file id (best-effort).
        const targetRel = resolveLocalImport(relPath, mod);
        if (targetRel) {
          result.edges.push({ type: "IMPORTS", from: fid, to: fileId(targetRel), sources: ["parser"], evidence: { file: relPath, line, snippet }, confidence: 0.7 });
        }
      }
    }

    // SQL in string literals -> WRITES/READS Table
    if (/string/.test(node.type) || node.type === "template_string") {
      const text = node.text;
      const line = node.startPosition.row + 1;
      const caller = enclosingSymbol(defs, line);
      if (!caller) return;
      const write = SQL_WRITE.exec(text);
      const read = write ? null : SQL_READ.exec(text);
      const tableName = write ? write[2] : read ? read[1] : null;
      const type = write ? "WRITES" : read ? "READS" : null;
      if (tableName && type) {
        const table = tableId(tableName.toLowerCase());
        result.nodes.push({ id: table, kind: "Table", name: tableName.toLowerCase() });
        const snippet = text.trim().slice(0, 120);
        result.edges.push({ type, from: caller.id, to: table, sources: ["parser"], evidence: { file: relPath, line, snippet }, confidence: 0.6 });
      }
    }
  });

  return dedupeEdges(result);
}

/** Resolve a relative import specifier to a best-effort sibling file relpath. */
function resolveLocalImport(fromRel: string, spec: string): string | null {
  const parts = fromRel.split("/");
  parts.pop(); // drop filename
  const segs = spec.split("/");
  for (const seg of segs) {
    if (seg === "." || seg === "") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  const base = parts.join("/");
  if (!base) return null;
  // Caller upserts File nodes for real files; the store drops edges to missing
  // endpoints, so guessing an extension is safe (only a real match survives).
  return /\.[cm]?[jt]sx?$|\.py$|\.java$/.test(base) ? base : `${base}.ts`;
}

/** Collapse duplicate logical edges within one file result. */
function dedupeEdges(result: ParseResult): ParseResult {
  const seen = new Set<string>();
  const edges: ParsedEdge[] = [];
  for (const e of result.edges) {
    const key = `${e.type}\u0000${e.from}\u0000${e.to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push(e);
  }
  result.edges = edges;
  return result;
}

function lastName(text: string): string {
  const cleaned = text.split("(")[0] ?? text;
  const parts = cleaned.split(/[.\s]/).filter(Boolean);
  return parts[parts.length - 1] ?? cleaned;
}

function stripQuotes(text: string): string {
  return text.replace(/^["'`]|["'`]$/g, "");
}

function importTarget(node: TsNode): string | null {
  // Find a string literal child (module path) or dotted module name (python/java).
  let found: string | null = null;
  walk(node, (n) => {
    if (found) return;
    if (/string/.test(n.type)) found = stripQuotes(n.text);
    else if (n.type === "dotted_name" || n.type === "scoped_identifier") found = n.text;
  });
  return found;
}
