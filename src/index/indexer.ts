/**
 * Workspace indexer: walks one or more repo roots, parses each file via the
 * layered parser, and upserts the normalized results into the ONE graph. Also
 * ingests manifests (package.json / requirements.txt) into External + Doc
 * nodes, runs optional verified LLM enrichment, and — when more than one root
 * is present — prefixes node IDs with `repo:<name>/…` and infers evidence-based
 * cross-repo edges.
 *
 * Incremental by content hash. Evidence is attached by the parsers. Rich
 * call/API/DB edges come from tree-sitter; other languages degrade to
 * structural symbols so nothing is a dead end.
 */

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, extname, basename } from "node:path";
import type { Envelope, GraphEdge, GraphNode } from "../core/contracts.js";
import { GraphStore } from "../core/store.js";
import { fileId, externalId, docId, prefixRepo } from "../core/ids.js";
import { parseFile } from "../parse/index.js";
import { inferCrossRepoEdges } from "../core/crossrepo.js";
import { loadLlmConfig, type LlmConfig } from "../llm/client.js";
import { proposeCouplingEdges } from "../llm/features.js";
import { verifyLlmEdges } from "../llm/verify.js";
import { loadWorkspaceConfig, resolveRootPath } from "./workspace.js";
import { cloneRemote } from "./remote.js";
import { deriveServices } from "../parse/services.js";
import { ingestKind, ingestFile } from "../parse/ingest.js";
import type { ParsedEdge } from "../parse/types.js";

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
      } else if (st.isFile() && st.size <= MAX_FILE_BYTES && (CODE_EXT.has(extname(entry)) || MANIFESTS.has(entry) || ingestKind(entry) !== null)) {
        out.push(full);
      }
    }
  }
  return out.sort();
}

/** Apply repo prefixing to a node's id (and nothing else). */
function prefixNode(node: GraphNode, repo: string | null): GraphNode {
  if (!repo) return node;
  return { ...node, id: prefixRepo(repo, node.id) };
}

/** Apply repo prefixing to an edge's endpoints. */
function prefixEdge(edge: ParsedEdge, repo: string | null): ParsedEdge {
  if (!repo) return edge;
  return { ...edge, from: prefixRepo(repo, edge.from), to: prefixRepo(repo, edge.to) };
}

function ingestManifest(store: GraphStore, rel: string, source: string, repo: string | null): number {
  const name = basename(rel);
  const fid = prefixRepo(repo, fileId(rel));
  store.upsertNode({ id: fid, kind: "File", name: rel, path: rel, extra: { lang: "manifest" } });
  let count = 0;
  const addExternal = (pkg: string, version: string, line: number, snippet: string): void => {
    // External packages are global identity — NOT repo-prefixed — so the same
    // dependency shared across repos is a single node (enables shared-lib view).
    const ext = externalId(pkg);
    store.upsertNode({ id: ext, kind: "External", name: pkg, extra: { version } });
    store.upsertEdge({ type: "DEPENDS_ON", from: fid, to: ext, sources: ["lockfile"], evidence: { file: rel, line, snippet }, confidence: 0.9 });
    if (name === "package.json") {
      const doc = docId(`https://www.npmjs.com/package/${pkg}`);
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

interface RootCounts {
  files: number;
  changed: number;
  skipped: number;
  symbols: number;
  edges: number;
  treeSitter: number;
  llmProposed: number;
  llmAccepted: number;
  llmDropped: number;
}

interface PendingCall {
  from: string;
  callee: string;
  kind: "CALLS" | "TESTS";
  evidence: { file: string; line: number; snippet: string };
}

async function indexRoot(
  store: GraphStore,
  root: string,
  repo: string | null,
  force: boolean,
  llm: LlmConfig,
  diagnostics: string[],
  pending: PendingCall[]
): Promise<RootCounts> {
  const counts: RootCounts = { files: 0, changed: 0, skipped: 0, symbols: 0, edges: 0, treeSitter: 0, llmProposed: 0, llmAccepted: 0, llmDropped: 0 };
  const files = walk(root);
  counts.files = files.length;

  for (const abs of files) {
    const rel = relative(root, abs).split("\\").join("/");
    let source: string;
    try {
      source = readFileSync(abs, "utf8");
    } catch {
      continue;
    }
    const digest = sha256(source);
    const fid = prefixRepo(repo, fileId(rel));
    const existing = store.getNode(fid);
    const priorHash =
      existing && typeof existing.extra === "object" && !Array.isArray(existing.extra)
        ? (existing.extra as Record<string, unknown>).sha256
        : undefined;
    if (!force && priorHash === digest && store.fileHasChunks(rel)) {
      counts.skipped += 1;
      continue;
    }

    if (MANIFESTS.has(basename(rel))) {
      counts.symbols += ingestManifest(store, rel, source, repo);
      store.upsertNode({ id: fid, kind: "File", name: rel, path: rel, extra: { sha256: digest, lang: "manifest", repo: repo ?? undefined } });
      counts.changed += 1;
      continue;
    }

    // Non-code inputs: OpenAPI/AsyncAPI, SQL, config, docker-compose, Dockerfile.
    const kind = ingestKind(rel);
    if (kind) {
      store.upsertNode({ id: fid, kind: "File", name: rel, path: rel, extra: { sha256: digest, lang: kind } });
      const ing = ingestFile(kind, rel, source);
      for (const node of ing.nodes) store.upsertNode(prefixNode(node, repo));
      for (const edge of ing.edges) {
        try {
          store.upsertEdge(prefixEdge(edge, repo));
          counts.edges += 1;
        } catch (error) {
          diagnostics.push(`${rel}: ${kind} edge ${edge.type} skipped: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      counts.symbols += ing.nodes.length;
      counts.changed += 1;
      continue;
    }

    let parsed;
    try {
      parsed = await parseFile(rel, source);
    } catch (error) {
      diagnostics.push(`${rel}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    if (parsed.mode === "tree-sitter") counts.treeSitter += 1;

    const baseFileId = fileId(rel);
    for (const node of parsed.nodes) {
      const prefixed = prefixNode(node, repo);
      const withHash = node.id === baseFileId ? { ...prefixed, extra: { ...(prefixed.extra as object), sha256: digest, repo: repo ?? undefined } } : prefixed;
      store.upsertNode(withHash);
    }
    for (const edge of parsed.edges) {
      try {
        store.upsertEdge(prefixEdge(edge, repo));
        counts.edges += 1;
      } catch (error) {
        diagnostics.push(`${rel}: edge ${edge.type} skipped: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    for (const chunk of parsed.chunks) {
      try {
        const nodeId = prefixRepo(repo, chunk.node_id);
        store.upsertChunk({ id: `chunk:${nodeId}`, node_id: nodeId, kind: "code", text: chunk.text });
      } catch {
        // chunk points at a node that failed to upsert; skip
      }
    }
    for (const uc of parsed.unresolved) {
      pending.push({ from: prefixRepo(repo, uc.from), callee: uc.callee, kind: uc.kind, evidence: uc.evidence });
    }

    // Optional verified LLM enrichment (first-class stage, only when configured).
    if (llm.configured && parsed.mode === "tree-sitter") {
      const candidates = parsed.nodes.filter((n) => n.kind !== "File").map((n) => prefixRepo(repo, n.id));
      if (candidates.length > 0) {
        try {
          const proposed = await proposeCouplingEdges({ file: rel, source, candidateTargets: candidates }, llm);
          const { accepted, dropped } = verifyLlmEdges(root, proposed.value ?? []);
          counts.llmProposed += (proposed.value ?? []).length;
          counts.llmDropped += dropped.length;
          for (const edge of accepted) {
            try {
              store.upsertEdge(edge as GraphEdge);
              counts.edges += 1;
              counts.llmAccepted += 1;
            } catch {
              // endpoint may not exist as a node; skip silently
            }
          }
        } catch (error) {
          diagnostics.push(`${rel}: llm enrichment skipped: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }

    counts.symbols += parsed.nodes.filter((n) => n.kind !== "File").length;
    counts.changed += 1;
  }

  return counts;
}

/** Resolve cross-file CALLS/TESTS by unique symbol name. Returns edges added. */
function resolveCrossFileCalls(store: GraphStore, pending: PendingCall[], diagnostics: string[]): number {
  if (pending.length === 0) return 0;
  // Build name -> unique symbol id index (Function/Method only).
  const byName = new Map<string, string[]>();
  for (const node of store.listNodes(500)) {
    if (node.kind !== "Function" && node.kind !== "Method") continue;
    const list = byName.get(node.name);
    if (list) list.push(node.id);
    else byName.set(node.name, [node.id]);
  }
  let added = 0;
  for (const call of pending) {
    const candidates = byName.get(call.callee);
    if (!candidates || candidates.length !== 1) continue; // unique match only
    const to = candidates[0]!;
    if (to === call.from) continue;
    try {
      store.upsertEdge({ type: call.kind, from: call.from, to, sources: ["parser"], evidence: call.evidence, confidence: call.kind === "TESTS" ? 0.7 : 0.75 });
      added += 1;
    } catch (error) {
      diagnostics.push(`resolve ${call.kind} ${call.callee}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return added;
}

export async function syncWorkspace(workspace: string, database: string, force = false, llm: LlmConfig = loadLlmConfig()): Promise<Envelope> {
  const store = new GraphStore(database, workspace);
  try {
    const diagnostics: string[] = [];
    const wsConfig = loadWorkspaceConfig(workspace);

    // Assemble the set of roots. The primary workspace is always a root.
    const roots: Array<{ name: string; path: string; remote?: boolean }> = [{ name: basename(workspace) || "root", path: workspace }];
    for (const r of wsConfig.roots) roots.push({ name: r.name, path: resolveRootPath(workspace, r) });

    // Remote roots in clone mode are pulled into .archmap/repos/<name>. API-mode
    // remotes are recorded but not indexed here (no-clone listing is a separate
    // read path); they are surfaced in diagnostics so nothing is silent.
    const remoteResults: Array<{ name: string; ok: boolean; mode: string; ran: boolean; detail?: string }> = [];
    for (const remote of wsConfig.remotes) {
      if (remote.mode === "clone") {
        const result = cloneRemote(workspace, remote.name, remote.url, remote.ref);
        remoteResults.push({ name: remote.name, ok: result.ok, mode: "clone", ran: result.ran, detail: result.detail });
        if (result.ok && result.path) roots.push({ name: remote.name, path: result.path, remote: true });
        else diagnostics.push(`remote ${remote.name}: clone failed: ${result.detail ?? "unknown"}`);
      } else {
        remoteResults.push({ name: remote.name, ok: false, mode: "api", ran: false, detail: "api mode: use `archmap repo pull --github-api` to list; not indexed inline" });
      }
    }

    const multiRoot = roots.length > 1;
    const total: RootCounts = { files: 0, changed: 0, skipped: 0, symbols: 0, edges: 0, treeSitter: 0, llmProposed: 0, llmAccepted: 0, llmDropped: 0 };
    const pending: PendingCall[] = [];
    for (const rootEntry of roots) {
      const repoName = multiRoot ? rootEntry.name : null;
      const rc = await indexRoot(store, rootEntry.path, repoName, force, llm, diagnostics, pending);
      for (const key of Object.keys(total) as Array<keyof RootCounts>) total[key] += rc[key];
    }

    // Resolve cross-file CALLS/TESTS by UNIQUE symbol name across the graph.
    // Ambiguous names (same name in >1 place) are dropped — never invent an edge.
    const resolvedEdges = resolveCrossFileCalls(store, pending, diagnostics);
    total.edges += resolvedEdges;

    // Derive Service nodes from directory/manifest layout and attach files, so
    // impact can roll up to services and the service map is a real projection.
    const servicesCreated = deriveServices(store);

    // Cross-repo edge inference (evidence-based) only makes sense with >1 root.
    let crossRepoEdges = 0;
    if (multiRoot) {
      const inferred = inferCrossRepoEdges(store);
      crossRepoEdges = (inferred.counts.cross_repo_edges as number) ?? 0;
    }

    const fingerprint = sha256(roots.map((r) => `${r.name}:${r.path}`).join("\n"));
    const prev = store.getHealth("workspace_fingerprint") as { value?: string } | null;
    const fingerprintChanged = !prev || prev.value !== fingerprint;
    store.setHealth("workspace_fingerprint", { value: fingerprint, changed: fingerprintChanged });
    store.appendJournal("sync", {
      roots: roots.map((r) => r.name),
      changed: total.changed,
      skipped: total.skipped,
      symbols: total.symbols,
      edges: total.edges,
      cross_repo_edges: crossRepoEdges,
      llm_accepted: total.llmAccepted,
      llm_dropped: total.llmDropped,
      fingerprint_changed: fingerprintChanged,
    });

    return {
      ok: true,
      nodes: [],
      edges: [],
      paths: [],
      counts: {
        roots: roots.length,
        files: total.files,
        changed: total.changed,
        skipped: total.skipped,
        symbols: total.symbols,
        edges: total.edges,
        tree_sitter_files: total.treeSitter,
        services: servicesCreated,
        cross_repo_edges: crossRepoEdges,
        llm_proposed_edges: total.llmProposed,
        llm_accepted_edges: total.llmAccepted,
        llm_dropped_edges: total.llmDropped,
      },
      risk: [],
      evidence_used: true,
      workspace,
      roots: roots.map((r) => ({ name: r.name, remote: Boolean(r.remote) })),
      remotes: remoteResults,
      multi_root: multiRoot,
      fingerprint,
      fingerprint_changed: fingerprintChanged,
      llm_status: llm.configured ? "ok" : "unavailable — configure a model",
      diagnostics,
    };
  } finally {
    store.close();
  }
}
