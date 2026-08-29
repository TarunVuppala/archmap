/**
 * Optional git pre-commit hook that runs `archmap sync`. Opt-in only.
 */

import { existsSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import type { Envelope } from "../core/contracts.js";
import { errorEnvelope } from "../core/contracts.js";

const HOOK = `#!/bin/sh
# Architecture Mapper: keep the graph in step with commits.
archmap sync >/dev/null 2>&1 || true
`;

export function installPreCommitHook(workspace: string): Envelope {
  const gitDir = join(workspace, ".git");
  if (!existsSync(gitDir)) return errorEnvelope("not a git repository (no .git dir)");
  const hooksDir = join(gitDir, "hooks");
  mkdirSync(hooksDir, { recursive: true });
  const hookPath = join(hooksDir, "pre-commit");
  writeFileSync(hookPath, HOOK, "utf8");
  try {
    chmodSync(hookPath, 0o755);
  } catch {
    /* windows: chmod is a no-op */
  }
  return {
    ok: true,
    nodes: [],
    edges: [],
    paths: [],
    counts: {},
    risk: [],
    evidence_used: true,
    hook: { path: hookPath, installed: true },
  };
}
