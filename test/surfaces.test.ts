import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { syncWorkspace } from "../src/index/indexer.ts";
import { McpServer } from "../src/mcp/server.ts";
import { runDaemon } from "../src/daemon/server.ts";
import { runUi, graphView } from "../src/ui/server.ts";

async function makeIndexedRepo(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "archmap-surf-"));
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "svc.ts"), "export function processPayment(tx){ return validate(tx); }\nfunction validate(x){ return x>0; }\n");
  await syncWorkspace(dir, join(dir, ".archmap", "index.db"), true);
  return dir;
}

async function post(port: number, path: string, body: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

test("MCP tools/list and tools/call route through the Core", async () => {
  const dir = await makeIndexedRepo();
  try {
    const server = new McpServer(dir);
    const list = server.handle({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const tools = (list?.result as { tools: Array<{ name: string }> }).tools.map((t) => t.name);
    assert.ok(tools.includes("impact"));
    assert.ok(tools.includes("search"));

    const call = server.handle({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "impact", arguments: { id: "fn:src/svc.ts:validate" } },
    });
    const structured = (call?.result as { structuredContent: { ok: boolean; nodes: Array<{ id: string }> } }).structuredContent;
    assert.equal(structured.ok, true);
    assert.ok(structured.nodes.some((n) => n.id === "fn:src/svc.ts:processPayment"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("HTTP daemon serves /health and /v1/impact identical to the Core", async () => {
  const dir = await makeIndexedRepo();
  const { port, close } = await runDaemon(dir, 0);
  try {
    const health = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal((await health.json()).ok, true);
    const { status, json } = await post(port, "/v1/impact", { id: "fn:src/svc.ts:validate" });
    assert.equal(status, 200);
    assert.equal(json.ok, true);
    assert.ok(json.nodes.some((n: { id: string }) => n.id === "fn:src/svc.ts:processPayment"));
  } finally {
    close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ui serves the page and graph.json with Mermaid", async () => {
  const dir = await makeIndexedRepo();
  const { port, close } = await runUi(dir, 0);
  try {
    const page = await fetch(`http://127.0.0.1:${port}/`);
    const html = await page.text();
    assert.match(html, /Architecture Mapper/);
    const graph = await (await fetch(`http://127.0.0.1:${port}/graph.json?view=architecture`)).json();
    assert.equal(graph.ok, true);
    assert.ok(graph.nodes.length >= 1);
    assert.match(graph.mermaid, /flowchart LR/);
  } finally {
    close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("graphView returns nodes/edges/mermaid over the one graph", async () => {
  const dir = await makeIndexedRepo();
  try {
    const view = graphView(dir, "architecture");
    assert.equal(view.ok, true);
    assert.ok(view.nodes.length >= 1);
    assert.match(view.mermaid, /flowchart LR/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
