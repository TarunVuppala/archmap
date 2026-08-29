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
import type { ParseResult } from "./types.js";
import { emptyResult } from "./types.js";
import { classId, externalId, fileId, functionId, apiId, tableId } from "../core/ids.js";
import { parserForExtension, richLanguageFor, type TsNode } from "./treesitter.js";

type Lang = "ts" | "js" | "python" | "java";

interface SymbolDef {
  id: string;
  name: string;
  kind: "Function" | "Method" | "Class";
  line: number;
  endLine: number;
  snippet: string;
}

const SYMBOL_TYPES: Record<Lang, Record<string, "Function" | "Method" | "Class">> = {
  ts: { function_declaration: "Function", method_definition: "Method", class_declaration: "Class", generator_function_declaration: "Function" },
  js: { function_declaration: "Function", method_definition: "Method", class_declaration: "Class", generator_function_declaration: "Function" },
  python: { function_definition: "Function", class_definition: "Class" },
  java: { method_declaration: "Method", class_declaration: "Class", interface_declaration: "Class", constructor_declaration: "Method" },
};

const ROUTE_METHODS = new Set(["get", "post", "put", "patch", "delete", "options", "head"]);
const SQL_WRITE = /\b(insert\s+into|update|delete\s+from)\s+["'`]?([a-zA-Z_][\w.]*)/i;
const SQL_READ = /\bfrom\s+["'`]?([a-zA-Z_][\w.]*)/i;

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

  // Pass 1: symbols + CONTAINS + chunks.
  walk(tree.rootNode, (node) => {
    const kind = symbolTypes[node.type];
    if (!kind) return;
    const name = firstIdentifier(node);
    if (!name) return;
    const line = node.startPosition.row + 1;
    const endLine = node.endPosition.row + 1;
    const id = kind === "Class" ? classId(relPath, name) : functionId(relPath, name);
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

  // Pass 2: calls, imports, routes, SQL.
  walk(tree.rootNode, (node) => {
    // CALLS
    if (node.type === "call_expression" || node.type === "call" || node.type === "method_invocation") {
      const fn = node.childForFieldName("function") ?? node.childForFieldName("name") ?? node.namedChildren[0];
      const callee = fn ? lastName(fn.text) : null;
      const line = node.startPosition.row + 1;
      const caller = enclosingSymbol(defs, line);
      if (callee && caller) {
        const target = defByName.get(callee);
        if (target && target.id !== caller.id) {
          const snippet = (lines[line - 1] ?? "").trim().slice(0, 200);
          result.edges.push({ type: "CALLS", from: caller.id, to: target.id, sources: ["parser"], evidence: { file: relPath, line, snippet }, confidence: 0.9 });
        }
        // Route registration heuristic: app.get('/x', ...) / @app.post('/x')
        if (ROUTE_METHODS.has(callee.toLowerCase())) {
          const arg = node.childForFieldName("arguments")?.namedChildren?.[0];
          const routePath = arg && /string/.test(arg.type) ? stripQuotes(arg.text) : null;
          if (routePath && routePath.startsWith("/")) {
            const api = apiId(callee, routePath);
            result.nodes.push({ id: api, kind: "API", name: `${callee.toUpperCase()} ${routePath}` });
            const owner = caller ?? defs[0];
            if (owner) {
              const snippet = (lines[line - 1] ?? "").trim().slice(0, 200);
              result.edges.push({ type: "EXPOSES", from: owner.id, to: api, sources: ["parser"], evidence: { file: relPath, line, snippet }, confidence: 0.7 });
            }
          }
        }
      }
    }
    // IMPORTS -> External
    if (node.type === "import_statement" || node.type === "import_from_statement" || node.type === "import_declaration") {
      const line = node.startPosition.row + 1;
      const mod = importTarget(node);
      if (mod && !mod.startsWith(".")) {
        const ext = externalId(mod);
        result.nodes.push({ id: ext, kind: "External", name: mod });
        const snippet = (lines[line - 1] ?? "").trim().slice(0, 200);
        result.edges.push({ type: "IMPORTS", from: fid, to: ext, sources: ["parser"], evidence: { file: relPath, line, snippet }, confidence: 0.8 });
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
