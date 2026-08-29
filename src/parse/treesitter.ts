/**
 * Tree-sitter loader with graceful degradation.
 *
 * Loads prebuilt WASM grammars from tree-sitter-wasms on demand and caches
 * them. If web-tree-sitter or a grammar is unavailable, callers fall back to
 * structural regex parsing — never a dead end.
 */

import { createRequire } from "node:module";
import { extname } from "node:path";

const require = createRequire(import.meta.url);

// extension -> tree-sitter-wasms grammar file (without directory).
const GRAMMAR_BY_EXT: Record<string, string> = {
  ".ts": "tree-sitter-typescript.wasm",
  ".tsx": "tree-sitter-tsx.wasm",
  ".js": "tree-sitter-javascript.wasm",
  ".jsx": "tree-sitter-javascript.wasm",
  ".mjs": "tree-sitter-javascript.wasm",
  ".cjs": "tree-sitter-javascript.wasm",
  ".py": "tree-sitter-python.wasm",
  ".java": "tree-sitter-java.wasm",
};

export const RICH_LANGUAGES: Record<string, "ts" | "js" | "python" | "java"> = {
  ".ts": "ts",
  ".tsx": "ts",
  ".js": "js",
  ".jsx": "js",
  ".mjs": "js",
  ".cjs": "js",
  ".py": "python",
  ".java": "java",
};

// Minimal structural typings for the subset of the web-tree-sitter API we use,
// so the Core stays strict without depending on the package's exported types.
export interface TsNode {
  type: string;
  text: string;
  startPosition: { row: number; column: number };
  endPosition: { row: number; column: number };
  childCount: number;
  child(index: number): TsNode | null;
  childForFieldName(field: string): TsNode | null;
  namedChildren: TsNode[];
}

export interface TsTree {
  rootNode: TsNode;
}

export interface TsParser {
  parse(source: string): TsTree;
}

let initPromise: Promise<unknown> | null = null;
let parserCtor: (new () => { setLanguage(lang: unknown): void; parse(src: string): TsTree }) | null = null;
let languageLoad: ((path: string) => Promise<unknown>) | null = null;
const langCache = new Map<string, unknown>();
let available = true;

async function ensureInit(): Promise<boolean> {
  if (!available) return false;
  if (initPromise) {
    await initPromise;
    return available;
  }
  initPromise = (async () => {
    try {
      const mod = (await import("web-tree-sitter")) as unknown as {
        Parser: { init(): Promise<void>; new (): { setLanguage(lang: unknown): void; parse(src: string): TsTree } };
        Language: { load(path: string): Promise<unknown> };
      };
      await mod.Parser.init();
      parserCtor = mod.Parser;
      languageLoad = (path: string) => mod.Language.load(path);
    } catch {
      available = false;
    }
  })();
  await initPromise;
  return available;
}

/** Return a parser for a file extension, or null if unsupported/unavailable. */
export async function parserForExtension(ext: string): Promise<TsParser | null> {
  const grammar = GRAMMAR_BY_EXT[ext];
  if (!grammar) return null;
  if (!(await ensureInit()) || !parserCtor || !languageLoad) return null;
  try {
    let language = langCache.get(grammar);
    if (!language) {
      const wasmPath = require.resolve(`tree-sitter-wasms/out/${grammar}`);
      language = await languageLoad(wasmPath);
      langCache.set(grammar, language);
    }
    const parser = new parserCtor();
    parser.setLanguage(language);
    return parser;
  } catch {
    return null;
  }
}

export function richLanguageFor(path: string): "ts" | "js" | "python" | "java" | null {
  return RICH_LANGUAGES[extname(path)] ?? null;
}

export function treeSitterAvailable(): boolean {
  return available;
}
