/**
 * `archmap init`: one-shot workspace setup.
 * Creates .archmap/, indexes the repo, and writes .gitignore entries,
 * .mcp.json, and a starter seed.yaml. Starting the daemon is opt-in.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Envelope } from "../core/contracts.js";
import { syncWorkspace } from "./indexer.js";

const GITIGNORE_ENTRIES = [
  ".archmap/index.db",
  ".archmap/vectors/",
  ".archmap/cache/",
  ".archmap/daemon.json",
  ".archmap/agent-runs/",
  ".archmap/repos/",
];

const MCP_JSON = {
  mcpServers: {
    "architecture-mapper": {
      command: "archmap",
      args: ["mcp"],
      cwd: "${workspaceFolder}",
    },
  },
};

const SEED_YAML = `# Architecture Mapper seed (optional).
# Only fill this in when automatic inference is wrong or blind. Everything here
# is upserted into the ONE graph; it is not a separate source of truth.
project:
  name: ""
services: []
externals: []
pins: []
ignore_paths: [node_modules/, dist/, build/, vendor/, generated/]
critical: []
`;

function ensureGitignore(workspace: string): boolean {
  const path = join(workspace, ".gitignore");
  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  const missing = GITIGNORE_ENTRIES.filter((entry) => !existing.split(/\r?\n/).includes(entry));
  if (missing.length === 0) return false;
  const prefix = existing && !existing.endsWith("\n") ? "\n" : "";
  writeFileSync(path, `${existing}${prefix}# Architecture Mapper\n${missing.join("\n")}\n`, "utf8");
  return true;
}

function writeIfMissing(path: string, content: string): boolean {
  if (existsSync(path)) return false;
  writeFileSync(path, content, "utf8");
  return true;
}

export async function initWorkspace(workspace: string, database: string): Promise<Envelope> {
  const archmapDir = join(workspace, ".archmap");
  mkdirSync(archmapDir, { recursive: true });
  const wroteMcp = writeIfMissing(join(workspace, ".mcp.json"), JSON.stringify(MCP_JSON, null, 2) + "\n");
  const wroteSeed = writeIfMissing(join(archmapDir, "seed.yaml"), SEED_YAML);
  const wroteGitignore = ensureGitignore(workspace);
  const sync = await syncWorkspace(workspace, database, true);
  return {
    ok: true,
    nodes: [],
    edges: [],
    paths: [],
    counts: sync.counts,
    risk: [],
    evidence_used: true,
    init: {
      workspace,
      database,
      wrote_mcp_json: wroteMcp,
      wrote_seed_yaml: wroteSeed,
      updated_gitignore: wroteGitignore,
    },
    fingerprint: sync.fingerprint,
  };
}
