import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseWorkspaceYaml, loadWorkspaceConfig } from "../src/index/workspace.ts";
import { prefixRepo, hasRepoPrefix, repoOf } from "../src/core/ids.ts";
import { GraphStore, inferCrossRepoEdges } from "../src/core/index.ts";
import { resolveToken } from "../src/index/remote.ts";
import { repoAdd, repoList } from "../src/index/repo.ts";
import { syncWorkspace } from "../src/index/indexer.ts";

test("parseWorkspaceYaml reads roots and remotes", () => {
  const text = [
    "roots:",
    "  - name: web",
    "    path: ../web",
    "remotes:",
    "  - name: orders",
    "    url: https://github.com/acme/orders",
    "    ref: main",
    "    mode: api",
  ].join("\n");
  const config = parseWorkspaceYaml(text);
  assert.equal(config.roots.length, 1);
  assert.deepEqual(config.roots[0], { name: "web", path: "../web" });
  assert.equal(config.remotes.length, 1);
  assert.deepEqual(config.remotes[0], { name: "orders", url: "https://github.com/acme/orders", ref: "main", mode: "api" });
});

test("prefixRepo / repoOf round-trip and are idempotent", () => {
  const prefixed = prefixRepo("web", "fn:src/a.ts:x");
  assert.equal(prefixed, "fn:repo:web/src/a.ts:x");
  assert.equal(hasRepoPrefix(prefixed), true);
  assert.equal(repoOf(prefixed), "web");
  assert.equal(prefixRepo("web", prefixed), prefixed); // no double-prefix
  assert.equal(prefixRepo(null, "fn:src/a.ts:x"), "fn:src/a.ts:x"); // single-root unchanged
  assert.equal(prefixRepo("api", "api:POST:/pay"), "api:repo:api/POST:/pay");
  assert.equal(repoOf("fn:src/a.ts:x"), null);
});

test("inferCrossRepoEdges links a cross-repo producer and consumer via matching API id", () => {
  const store = new GraphStore(":memory:");
  const ev = (f: string) => ({ file: f, line: 1, snippet: "x" });
  // Producer repo "api": a function EXPOSES POST /payments
  store.upsertNode({ id: "fn:repo:api/svc.ts:pay", kind: "Function", name: "pay" });
  store.upsertNode({ id: "api:POST:/payments", kind: "API", name: "POST /payments" });
  store.upsertEdge({ type: "EXPOSES", from: "fn:repo:api/svc.ts:pay", to: "api:POST:/payments", sources: ["parser"], evidence: ev("api/svc.ts") });
  // Consumer repo "web": a function CONSUMES the same API id
  store.upsertNode({ id: "fn:repo:web/client.ts:checkout", kind: "Function", name: "checkout" });
  store.upsertEdge({ type: "CONSUMES", from: "fn:repo:web/client.ts:checkout", to: "api:POST:/payments", sources: ["parser"], evidence: ev("web/client.ts") });

  const result = inferCrossRepoEdges(store);
  assert.equal(result.counts.cross_repo_edges, 1);
  const dep = store.listEdges(100).find((e) => e.type === "DEPENDS_ON");
  assert.ok(dep, "expected a DEPENDS_ON cross-repo edge");
  assert.equal(dep!.from, "fn:repo:web/client.ts:checkout");
  assert.equal(dep!.to, "fn:repo:api/svc.ts:pay");
  store.close();
});

test("inferCrossRepoEdges does NOT link same-repo producer/consumer", () => {
  const store = new GraphStore(":memory:");
  const ev = { file: "a.ts", line: 1, snippet: "x" };
  store.upsertNode({ id: "fn:repo:api/svc.ts:pay", kind: "Function", name: "pay" });
  store.upsertNode({ id: "fn:repo:api/self.ts:call", kind: "Function", name: "call" });
  store.upsertNode({ id: "api:POST:/x", kind: "API", name: "POST /x" });
  store.upsertEdge({ type: "EXPOSES", from: "fn:repo:api/svc.ts:pay", to: "api:POST:/x", sources: ["parser"], evidence: ev });
  store.upsertEdge({ type: "CONSUMES", from: "fn:repo:api/self.ts:call", to: "api:POST:/x", sources: ["parser"], evidence: ev });
  const result = inferCrossRepoEdges(store);
  assert.equal(result.counts.cross_repo_edges, 0);
  store.close();
});

test("indexing two on-disk sibling roots produces repo-prefixed ids in one graph", async () => {
  const base = mkdtempSync(join(tmpdir(), "archmap-multi-"));
  try {
    mkdirSync(join(base, "primary", "src"), { recursive: true });
    mkdirSync(join(base, "web", "src"), { recursive: true });
    writeFileSync(join(base, "primary", "src", "a.ts"), "export function a(){ return 1; }\n");
    writeFileSync(join(base, "web", "src", "b.ts"), "export function b(){ return 2; }\n");
    // Register the sibling root, then sync.
    repoAdd(join(base, "primary"), join(base, "web"), { name: "web" });
    const listed = repoList(join(base, "primary"));
    assert.equal((listed.counts.roots as number), 1);

    const result = await syncWorkspace(join(base, "primary"), join(base, "primary", ".archmap", "index.db"), true);
    assert.equal(result.multi_root, true);
    assert.equal((result.counts.roots as number), 2);

    const store = new GraphStore(join(base, "primary", ".archmap", "index.db"), join(base, "primary"));
    const ids = store.listNodes(500).map((n) => n.id);
    assert.ok(ids.some((id) => id.startsWith("fn:repo:")), `expected repo-prefixed fn ids, got: ${ids.join(", ")}`);
    assert.ok(ids.some((id) => repoOf(id) === "web"), "expected a node from the web root");
    store.close();
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("resolveToken never returns a token when none is configured, and reports source", () => {
  // Explicitly empty env; gh may or may not be installed, so accept either
  // 'none' (no token) — we assert the token is null when source is 'none'.
  const auth = resolveToken({} as NodeJS.ProcessEnv);
  if (auth.source === "none") {
    assert.equal(auth.token, null);
  } else {
    // If gh provided one, that's a real credential path; just ensure shape.
    assert.equal(typeof auth.token, "string");
  }
  // With an env token, it is read but our persisted artifacts must never contain it.
  const withToken = resolveToken({ GITHUB_TOKEN: "secret-xyz" } as unknown as NodeJS.ProcessEnv);
  assert.equal(withToken.token, "secret-xyz");
  assert.equal(withToken.source, "GITHUB_TOKEN");
});

test("workspace.yaml written by repo add never contains a token", () => {
  const base = mkdtempSync(join(tmpdir(), "archmap-tok-"));
  try {
    mkdirSync(join(base, "primary"), { recursive: true });
    repoAdd(join(base, "primary"), "https://github.com/acme/orders", { name: "orders", ref: "main" });
    const yaml = readFileSync(join(base, "primary", ".archmap", "workspace.yaml"), "utf8");
    // No actual credential material: GitHub token prefixes, bearer headers, or
    // a token injected into the URL (https://x-access-token:...@).
    assert.doesNotMatch(yaml, /ghp_|gho_|github_pat_|Authorization:|x-access-token:|:\/\/[^@\s]+:[^@\s]+@/);
    const config = loadWorkspaceConfig(join(base, "primary"));
    assert.equal(config.remotes[0]?.name, "orders");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
