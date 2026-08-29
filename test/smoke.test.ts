import { test } from "node:test";
import assert from "node:assert/strict";
import { CONTRACT_VERSION } from "../src/core/index.ts";

test("toolchain smoke: core module loads and exposes contract version", () => {
  assert.equal(CONTRACT_VERSION, "1.0.0");
});
