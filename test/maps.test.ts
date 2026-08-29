import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { syncWorkspace } from "../src/index/indexer.ts";
import { GraphStore } from "../src/core/store.ts";
import { projectMap, MAP_VIEWS, isMapView } from "../src/core/maps.ts";

async function makeRepo(): Promise<{ dir: string; db: string }> {
  const dir = mkdtempSync(join(tmpdir(), "archmap-maps-"));
  mkdirSync(join(dir, "apps", "payments"), { recursive: true });
  mkdirSync(join(dir, "apps", "orders"), { recursive: true });
  writeFileSync(
    join(dir, "apps", "payments", "service.ts"),
    [
      "export class PaymentService {",
      "  processPayment(id) { return this.validateTransaction(id); }",
      "  validateTransaction(id) { db.query(\"INSERT INTO payments (id) VALUES (?)\", [id]); return true; }",
      "}",
      "app.post(\"/payments\", (req, res) => new PaymentService().processPayment(req.body.id));",
      "",
    ].join("\n")
  );
  writeFileSync(
    join(dir, "apps", "orders", "client.ts"),
    "export async function placeOrder(id) { return fetch(\"/payments\", { method: \"POST\", body: id }); }\n"
  );
  writeFileSync(join(dir, "openapi.yaml"), "openapi: 3.0.0\npaths:\n  /payments:\n    post:\n      summary: create\n");
  writeFileSync(join(dir, "schema.sql"), "CREATE TABLE payments (\n  id TEXT PRIMARY KEY,\n  amount INTEGER\n);\n");
  const db = join(dir, ".archmap", "index.db");
  await syncWorkspace(dir, db, true);
  return { dir, db };
}

test("every map view returns the canonical envelope with mermaid + view", async () => {
  const { dir, db } = await makeRepo();
  const store = new GraphStore(db, dir);
  try {
    for (const view of MAP_VIEWS) {
      const env = projectMap(store, view);
      assert.equal(env.ok, true, `${view} ok`);
      assert.equal(env.view, view);
      assert.equal(typeof env.mermaid, "string");
      assert.ok(Array.isArray(env.nodes));
      assert.ok(Array.isArray(env.edges));
      // Projected edges only connect nodes present in the view (no dangling).
      const ids = new Set(env.nodes.map((n) => n.id));
      for (const e of env.edges) {
        assert.ok(ids.has(e.from) && ids.has(e.to), `${view} edge endpoints in view`);
      }
    }
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("api view surfaces the service-to-service CONSUMES edge", async () => {
  const { dir, db } = await makeRepo();
  const store = new GraphStore(db, dir);
  try {
    const env = projectMap(store, "api");
    const consumes = env.edges.filter((e) => e.type === "CONSUMES");
    assert.ok(consumes.some((e) => e.to === "api:POST:/payments"), "orders client CONSUMES POST /payments");
    assert.ok(env.edges.some((e) => e.type === "CONSTRAINED_BY"), "openapi constrains the api");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("db view links writer to table and table to columns", async () => {
  const { dir, db } = await makeRepo();
  const store = new GraphStore(db, dir);
  try {
    const env = projectMap(store, "db");
    assert.ok(env.edges.some((e) => e.type === "WRITES" && e.to === "table:payments"), "WRITES payments");
    assert.ok(env.edges.some((e) => e.type === "CONTAINS" && e.from === "table:payments"), "table CONTAINS columns");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("unknown view is a clean error envelope", async () => {
  const { dir, db } = await makeRepo();
  const store = new GraphStore(db, dir);
  try {
    const env = projectMap(store, "nope");
    assert.equal(env.ok, false);
    assert.match(String(env.error), /unknown map view/);
    assert.equal(isMapView("nope"), false);
    assert.equal(isMapView("call"), true);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
