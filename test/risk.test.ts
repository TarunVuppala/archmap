import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { syncWorkspace } from "../src/index/indexer.ts";
import { dispatch } from "../src/core/operations.ts";
import type { RiskProfile } from "../src/core/risk.ts";

async function makeRepo(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "archmap-risk-"));
  mkdirSync(join(dir, "apps", "payments"), { recursive: true });
  writeFileSync(
    join(dir, "apps", "payments", "service.ts"),
    [
      "export class PaymentService {",
      "  processPayment(id) { return this.validateTransaction(id); }",
      "  validateTransaction(id) { db.query(\"INSERT INTO payments (id) VALUES (?)\", [id]); return true; }",
      "}",
      "",
    ].join("\n")
  );
  writeFileSync(join(dir, "schema.sql"), "CREATE TABLE payments (id TEXT PRIMARY KEY);\n");
  await syncWorkspace(dir, join(dir, ".archmap", "index.db"), true);
  return dir;
}

test("impact attaches a structured risk_profile with all signals", async () => {
  const dir = await makeRepo();
  try {
    const env = dispatch("impact", { workspace: dir, id: "fn:apps/payments/service.ts:validateTransaction" }, dir);
    assert.equal(env.ok, true);
    const rp = env.risk_profile as RiskProfile;
    assert.ok(rp, "risk_profile present");
    // Every documented field exists and is the right shape.
    assert.equal(typeof rp.dependency_count, "number");
    assert.equal(typeof rp.downstream_consumers, "number");
    assert.equal(typeof rp.centrality, "number");
    assert.equal(typeof rp.db_interactions, "number");
    assert.equal(typeof rp.external_deps, "number");
    assert.equal(typeof rp.test_coverage, "boolean");
    assert.equal(typeof rp.critical_path, "boolean");
    assert.equal(typeof rp.score, "number");
    assert.ok(["low", "medium", "high"].includes(rp.level));
    assert.ok(Array.isArray(rp.signals));
    // validateTransaction writes payments -> db interaction recorded, untested.
    assert.ok(rp.db_interactions >= 1, "db interaction counted");
    assert.equal(rp.test_coverage, false);
    assert.ok(rp.signals.includes("db_interaction"));
    assert.ok(rp.signals.includes("untested"));
    // churn is either a number (git available) or null (graceful).
    assert.ok(rp.churn === null || typeof rp.churn === "number");
    assert.equal(rp.churn_available, rp.churn !== null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("upstream impact omits the risk_profile (target-oriented)", async () => {
  const dir = await makeRepo();
  try {
    const env = dispatch("impact", { workspace: dir, id: "fn:apps/payments/service.ts:validateTransaction", direction: "upstream" }, dir);
    assert.equal(env.ok, true);
    assert.equal(env.risk_profile, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
