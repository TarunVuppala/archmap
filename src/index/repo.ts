/**
 * `archmap repo add|pull|list`: manage repo roots in .archmap/workspace.yaml.
 *
 * add   — append a sibling (local path) or remote (GitHub url) root.
 * pull  — re-pull remote clone-mode roots (explicit), or list files via the
 *         GitHub API for api-mode roots (no clone). Never persists a token.
 * list  — show configured roots/remotes.
 *
 * Writing workspace.yaml is deterministic and secret-free.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import type { Envelope } from "../core/contracts.js";
import { errorEnvelope } from "../core/contracts.js";
import { loadWorkspaceConfig, workspaceConfigPath, type RemoteEntry, type RootEntry } from "./workspace.js";
import { cloneRemote, listGitHubTree, resolveToken } from "./remote.js";

function isGitHubUrl(target: string): boolean {
  return /github\.com[/:]/.test(target) || /^git@github\.com:/.test(target);
}

function nameFromTarget(target: string): string {
  const cleaned = target.replace(/\.git$/, "").replace(/\/+$/, "");
  return basename(cleaned) || "repo";
}

function serializeWorkspace(roots: RootEntry[], remotes: RemoteEntry[]): string {
  const lines: string[] = ["# Architecture Mapper multi-repo workspace.", "# Managed by `archmap repo`. No secrets are stored here.", ""];
  lines.push("roots:");
  if (roots.length === 0) lines.push("  []");
  for (const r of roots) lines.push(`  - name: ${r.name}\n    path: ${r.path}`);
  lines.push("remotes:");
  if (remotes.length === 0) lines.push("  []");
  for (const r of remotes) {
    lines.push(`  - name: ${r.name}\n    url: ${r.url}${r.ref ? `\n    ref: ${r.ref}` : ""}\n    mode: ${r.mode}`);
  }
  return lines.join("\n") + "\n";
}

function writeWorkspace(workspace: string, roots: RootEntry[], remotes: RemoteEntry[]): void {
  const path = workspaceConfigPath(workspace);
  mkdirSync(join(workspace, ".archmap"), { recursive: true });
  writeFileSync(path, serializeWorkspace(roots, remotes), "utf8");
}

export function repoList(workspace: string): Envelope {
  const config = loadWorkspaceConfig(workspace);
  return {
    ok: true,
    nodes: [],
    edges: [],
    paths: [],
    counts: { roots: config.roots.length, remotes: config.remotes.length },
    risk: [],
    evidence_used: true,
    roots: config.roots,
    remotes: config.remotes,
  };
}

export function repoAdd(workspace: string, target: string, opts: { name?: string; ref?: string; githubApi?: boolean } = {}): Envelope {
  if (!target) return errorEnvelope("repo add requires a path or GitHub url");
  const config = loadWorkspaceConfig(workspace);
  const name = opts.name ?? nameFromTarget(target);

  if (isGitHubUrl(target) || /^https?:\/\//.test(target)) {
    if (config.remotes.some((r) => r.name === name)) return errorEnvelope(`remote already exists: ${name}`);
    const remote: RemoteEntry = { name, url: target, ref: opts.ref, mode: opts.githubApi ? "api" : "clone" };
    config.remotes.push(remote);
    writeWorkspace(workspace, config.roots, config.remotes);
    return {
      ok: true, nodes: [], edges: [], paths: [], counts: { remotes: config.remotes.length }, risk: [], evidence_used: true,
      added: { kind: "remote", ...remote }, note: "run `archmap sync` (clone mode) or `archmap repo pull` to fetch",
    };
  }

  // Local sibling path.
  let ok = false;
  try {
    ok = statSync(target).isDirectory();
  } catch {
    ok = false;
  }
  if (!ok) return errorEnvelope(`not a directory (or unsupported url): ${target}`);
  if (config.roots.some((r) => r.name === name)) return errorEnvelope(`root already exists: ${name}`);
  const root: RootEntry = { name, path: target };
  config.roots.push(root);
  writeWorkspace(workspace, config.roots, config.remotes);
  return {
    ok: true, nodes: [], edges: [], paths: [], counts: { roots: config.roots.length }, risk: [], evidence_used: true,
    added: { kind: "root", ...root }, note: "run `archmap sync` to index all roots into the one graph",
  };
}

export async function repoPull(workspace: string, name?: string): Promise<Envelope> {
  const config = loadWorkspaceConfig(workspace);
  const targets = name ? config.remotes.filter((r) => r.name === name) : config.remotes;
  if (targets.length === 0) return errorEnvelope(name ? `no such remote: ${name}` : "no remotes configured");
  const auth = resolveToken();
  const results: Array<Record<string, unknown>> = [];
  for (const remote of targets) {
    if (remote.mode === "api") {
      const tree = await listGitHubTree(remote.url, remote.ref ?? "HEAD");
      results.push({ name: remote.name, mode: "api", ok: tree.ok, ran: tree.ran, files: tree.files.length, detail: tree.detail });
    } else {
      const res = cloneRemote(workspace, remote.name, remote.url, remote.ref);
      results.push({ name: remote.name, mode: "clone", ok: res.ok, ran: res.ran, path: res.path, detail: res.detail });
    }
  }
  return {
    ok: results.every((r) => r.ok),
    nodes: [], edges: [], paths: [], counts: { pulled: results.length }, risk: [], evidence_used: true,
    results,
    auth_source: auth.source, // never the token itself
  };
}
