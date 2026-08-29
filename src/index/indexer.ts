/**
 * Workspace indexer: walks a repo, parses each file via the layered parser, and
 * upserts the normalized results into the ONE graph. Also ingests manifests
 * (package.json / requirements.txt) into External + Doc nodes.
 *
 * Incremental by content hash. Evidence is attached by the parsers. Rich
 * call/API/DB edges come from tree-sitter; other languages degrade to
 * structural symbols so nothing is a dead end.
 */

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, extname, basename } from "node:path";
import type { Envelope } from "../core/contracts.js";
import { GraphStore } from "../core/store.js";
import { fileId, externalId, docId } from "../core/ids.js";
import { parseFile } from "../parse/index.js";

const IGNORE_DIRS = new Set([
  ".git", ".archmap", "node_modules", "dist", "build", "out", ".venv", "venv",
  "__pycache__", "vendor", "generated", ".next", "coverage", ".turbo", ".cache",
]);

const CODE_EXT = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".java", ".go", ".rb",
  ".rs", ".php", ".cs", ".kt", ".scala", ".swift", ".c", ".cc", ".cpp", ".h", ".hpp",
]);

const MANIFESTS = new Set(["package.json", "requirements.txt", "pyproject.toml", "go.mod", "Cargo.toml", "pom.xml"]);
const MAX_FILE_BYTES = 512 * 1024;

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function walk(root: string): string[] {
  const out: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(dir, entry);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (!IGNORE_DIRS.has(entry)) stack.push(full);
      } else if (st.isFile() && st.size <= MAX_FILE_BYTES && (CODE_EXT.has(extname(entry)) || MANIFESTS.has(entry))) {
        out.push(full);
      }
    }
  }
  return out.sort();
}

function ingestManifest(store: GraphStore, rel: string, source: string): number {
  const name = basename(rel);
  const fid = fileId(rel);
  store.upsertNode({ id: fid, kind: "File", name: rel, path: rel, extra: { lang: "manifest" } });
  let count = 0;
  const addExternal = (pkg: string, version: string, line: number, snippet: string): void => {
    const ext = externalId(pkg);
    store.upsertNode({ id: ext, kind: "External", name: pkg, extra: { version } });
    store.upsertEdge({ type: "DEPENDS_ON", from: fid, to: ext, sources: ["lockfile"], evidence: { file: rel, line, snippet }, confidence: 0.9 });
    const doc = docId(`https://www.npmjs.com/package/${pkg}`);
    if (name === "package.json") {
      store.upsertNode({ id: doc, kind: "Doc", name: `${pkg} docs`, extra: { url: `https://www.npmjs.com/package/${pkg}` } });
      store.upsertEdge({ type: "DOCUMENTS", from: doc, to: ext, sources: ["lockfile"], evidence: { file: rel, line, snippet }, confidence: 0.5 });
    }
    count += 1;
  };
  try {
    if (name === "package.json") {
      const data = JSON.parse(source) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
      for (const deps of [data.dependencies, data.devDependencies]) {
        if (!deps) continue;
        for (const [pkg, version] of Object.entries(deps)) addExternal(pkg, String(version), 1, `${pkg}: ${version}`);
      }
    } else if (name === "requirements.txt") {
      source.split(/\r?\n/).forEach((raw, i) => {
        const lineText = raw.trim();
        if (!lineText || lineText.startsWith("#")) return;
        const match = /^([A-Za-z0-9_.-]+)\s*([=<>!~]+\s*[\w.]+)?/.exec(lineText);
        if (match?.[1]) addExternal(match[1], (match[2] ?? "").replace(/\s+/g, ""), i + 1, lineText.slice(0, 120));
      });
    }
  } catch {
    // malformed manifest: keep the File node, skip deps
  }
  return count;
}

export async function syncWorkspace(workspace: string, database: string, force = false): Promise<Envelope> {
  const store = new GraphStore(database, workspace);
  try {
    const files = walk(workspace);
    let changed = 0;
    let skipped = 0;
    let symbolCount = 0;
    let edgeCount = 0;
    let treeSitterFiles = 0;
    const diagnostics: string[] = [];

    for (const abs of files) {
      const rel = relative(workspace, abs).split("\\").join("/");
      let source: string;
      try {
        source = readFileSync(abs, "utf8");
      } catch {
        continue;
      }
      const digest = sha256(source);
      const fid = fileId(rel);
      const existing = store.getNode(fid);
      const priorHash =
        existing && typeof existing.extra === "object" && !Array.isArray(existing.extra)
          ? (existing.extra as Record<string, unknown>).sha256
          : undefined;
      if (!force && priorHash === digest && store.fileHasChunks(rel)) {
        skipped += 1;
        continue;
      }

      if (MANIFESTS.has(basename(rel))) {
        symbolCount += ingestManifest(store, rel, source);
        store.upsertNode({ id: fid, kind: "File", name: rel, path: rel, extra: { sha256: digest, lang: "manifest" } });
        changed += 1;
        continue;
      }

      let parsed;
      try {
        parsed = await parseFile(rel, source);
      } catch (error) {
        diagnostics.push(`${rel}: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
      if (parsed.mode === "tree-sitter") treeSitterFiles += 1;

      for (const node of parsed.nodes) {
        const withHash = node.id === fid ? { ...node, extra: { ...(node.extra as object), sha256: digest } } : node;
        store.upsertNode(withHash);
      }
      for (const edge of parsed.edges) {
        try {
          store.upsertEdge(edge);
          edgeCount += 1;
        } catch (error) {
          diagnostics.push(`${rel}: edge ${edge.type} skipped: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      for (const chunk of parsed.chunks) {
        try {
          store.upsertChunk({ id: `chunk:${chunk.node_id}`, node_id: chunk.node_id, kind: "code", text: chunk.text });
        } catch {
          // chunk points at a node that failed to upsert; skip
        }
      }
      symbolCount += parsed.nodes.filter((n) => n.kind !== "File").length;
      changed += 1;
    }

    const fingerprint = sha256(files.map((f) => relative(workspace, f)).join("\n"));
    const prev = store.getHealth("workspace_fingerprint") as { value?: string } | null;
    const fingerprintChanged = !prev || prev.value !== fingerprint;
    store.setHealth("workspace_fingerprint", { value: fingerprint, changed: fingerprintChanged });
    store.appendJournal("sync", { changed, skipped, symbols: symbolCount, edges: edgeCount, tree_sitter_files: treeSitterFiles, fingerprint_changed: fingerprintChanged });

    return {
      ok: true,
      nodes: [],
      edges: [],
      paths: [],
      counts: { files: files.length, changed, skipped, symbols: symbolCount, edges: edgeCount, tree_sitter_files: treeSitterFiles },
      risk: [],
      evidence_used: true,
      workspace,
      fingerprint,
      fingerprint_changed: fingerprintChanged,
      diagnostics,
    };
  } finally {
    store.close();
  }
}
