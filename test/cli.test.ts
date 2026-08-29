import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../src/cli/index.ts";

async function run(argv: string[]): Promise<{ code: number; out: string }> {
  const chunks: string[] = [];
  const code = await main(argv, (t) => chunks.push(t));
  return { code, out: chunks.join("") };
}

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "archmap-cli-"));
  mkdirSync(join(dir, "src"), { recursive: true });
  mkdirSync(join(dir, "svc"), { recursive: true });
  writeFileSync(
    join(dir, "src", "service.ts"),
    "export function processPayment(tx: number) {\n  return validate(tx);\n}\nfunction validate(x: number) { return x > 0; }\n"
  );
  writeFileSync(join(dir, "svc", "worker.py"), "def settle(amount):\n    return charge(amount)\n\ndef charge(amount):\n    return {'ok': amount}\n");
  writeFileSync(join(dir, "svc", "Ledger.java"), "class Ledger {\n  public int record(int n) { return n; }\n}\n");
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "sample", dependencies: { express: "^4.18.0" } }));
  return dir;
}

test("archmap init indexes a fresh multi-language repo and writes setup files", async () => {
  const dir = makeRepo();
  try {
    const { code, out } = await run(["init", dir, "--json"]);
    assert.equal(code, 0);
    const payload = JSON.parse(out);
    assert.equal(payload.ok, true);
    assert.ok(payload.counts.files >= 3, `expected >=3 files, got ${payload.counts.files}`);
    assert.ok(payload.counts.symbols >= 3, `expected >=3 symbols, got ${payload.counts.symbols}`);
    assert.equal(payload.init.wrote_mcp_json, true);
    assert.equal(payload.init.wrote_seed_yaml, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("tree-sitter yields real CALLS edges: validate's downstream includes processPayment", async () => {
  const dir = makeRepo();
  try {
    await run(["init", dir, "--json"]);
    const { code, out } = await run(["impact", "fn:src/service.ts:validate", "--workspace", dir, "--json"]);
    assert.equal(code, 0);
    const payload = JSON.parse(out);
    assert.equal(payload.ok, true);
    const ids = payload.nodes.map((n: { id: string }) => n.id);
    assert.ok(ids.includes("fn:src/service.ts:processPayment"), `impacted ids: ${ids.join(", ")}`);
    assert.ok(payload.paths.length >= 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("python call graph is extracted (settle CALLS charge)", async () => {
  const dir = makeRepo();
  try {
    await run(["init", dir, "--json"]);
    const { out } = await run(["impact", "fn:svc/worker.py:charge", "--workspace", dir, "--json"]);
    const payload = JSON.parse(out);
    const ids = payload.nodes.map((n: { id: string }) => n.id);
    assert.ok(ids.includes("fn:svc/worker.py:settle"), `impacted ids: ${ids.join(", ")}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("manifest ingest creates External + DEPENDS_ON from package.json", async () => {
  const dir = makeRepo();
  try {
    await run(["init", dir, "--json"]);
    // package.json File CONTAINS/DEPENDS_ON express; check via neighbors of the External node.
    const { out } = await run(["neighbors", "ext:express", "--workspace", dir, "--json"]);
    const payload = JSON.parse(out);
    assert.equal(payload.ok, true);
    const ids = payload.nodes.map((n: { id: string }) => n.id);
    assert.ok(ids.includes("file:package.json"), `neighbor ids: ${ids.join(", ")}`);
    assert.ok(payload.edges.some((e: { type: string }) => e.type === "DEPENDS_ON"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("archmap search finds an indexed symbol", async () => {
  const dir = makeRepo();
  try {
    await run(["init", dir, "--json"]);
    const { code, out } = await run(["search", "processPayment", "--workspace", dir, "--json"]);
    assert.equal(code, 0);
    const payload = JSON.parse(out);
    const ids = payload.nodes.map((n: { id: string }) => n.id);
    assert.ok(ids.includes("fn:src/service.ts:processPayment"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("archmap health and validate_graph pass on an indexed repo", async () => {
  const dir = makeRepo();
  try {
    await run(["init", dir, "--json"]);
    const health = JSON.parse((await run(["health", "--workspace", dir, "--json"])).out);
    assert.equal(health.ok, true);
    const validation = JSON.parse((await run(["validate_graph", "--workspace", dir, "--json"])).out);
    assert.equal(validation.ok, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("unknown command returns a structured error and exit code 2", async () => {
  const { code, out } = await run(["frobnicate", "--json"]);
  assert.equal(code, 2);
  const payload = JSON.parse(out);
  assert.equal(payload.ok, false);
  assert.match(payload.error, /unknown command/);
});
