/**
 * Remote GitHub repo support.
 *
 * Two modes:
 *  - clone (default): shallow `git clone --depth 1` at a pinned ref into
 *    .archmap/repos/<name> (gitignored). Re-pull is explicit.
 *  - api (no-clone): list files via the GitHub REST API without cloning.
 *
 * Auth is read at run time from GITHUB_TOKEN / GH_TOKEN / `gh auth token`. The
 * token is NEVER written to config, the graph, or the journal — it only ever
 * lives in memory and in the Authorization header / git credential for the
 * duration of the call.
 */

import { execFileSync, execSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export interface RemoteAuth {
  token: string | null;
  source: "GITHUB_TOKEN" | "GH_TOKEN" | "gh" | "none";
}

/** Resolve a GitHub token without persisting it anywhere. */
export function resolveToken(env: NodeJS.ProcessEnv = process.env): RemoteAuth {
  if (env.GITHUB_TOKEN?.trim()) return { token: env.GITHUB_TOKEN.trim(), source: "GITHUB_TOKEN" };
  if (env.GH_TOKEN?.trim()) return { token: env.GH_TOKEN.trim(), source: "GH_TOKEN" };
  try {
    const out = execSync("gh auth token", { stdio: ["ignore", "pipe", "ignore"], encoding: "utf8" }).trim();
    if (out) return { token: out, source: "gh" };
  } catch {
    // gh not installed or not authenticated
  }
  return { token: null, source: "none" };
}

export function reposDir(workspace: string): string {
  return join(workspace, ".archmap", "repos");
}

export interface CloneResult {
  ok: boolean;
  name: string;
  path?: string;
  ref?: string;
  mode: "clone" | "api";
  detail?: string;
  /** True only when a network operation actually ran in this process. */
  ran: boolean;
}

function authedUrl(url: string, token: string | null): string {
  if (!token) return url;
  // Inject token into https URL for this call only; never stored.
  return url.replace(/^https:\/\//, `https://x-access-token:${token}@`);
}

/**
 * Shallow-clone (or re-pull) a remote repo at a pinned ref. Returns the local
 * path. Does not throw on failure — returns ok:false with detail so callers can
 * degrade. The token is used only in-memory for this invocation.
 */
export function cloneRemote(workspace: string, name: string, url: string, ref?: string, env: NodeJS.ProcessEnv = process.env): CloneResult {
  const dir = reposDir(workspace);
  mkdirSync(dir, { recursive: true });
  const dest = join(dir, name);
  const { token } = resolveToken(env);
  const remote = authedUrl(url, token);
  try {
    if (existsSync(join(dest, ".git"))) {
      // Explicit re-pull at the pinned ref.
      execFileSync("git", ["-C", dest, "fetch", "--depth", "1", "origin", ref ?? "HEAD"], { stdio: "ignore" });
      execFileSync("git", ["-C", dest, "checkout", "FETCH_HEAD"], { stdio: "ignore" });
    } else {
      const args = ["clone", "--depth", "1"];
      if (ref) args.push("--branch", ref);
      args.push(remote, dest);
      execFileSync("git", args, { stdio: "ignore" });
    }
    return { ok: true, name, path: dest, ref, mode: "clone", ran: true };
  } catch (error) {
    return { ok: false, name, mode: "clone", ran: true, detail: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * No-clone GitHub API mode: list the repo tree at a ref via the REST API. Used
 * when the user does not want a local clone. Returns file paths; the caller
 * fetches individual file contents lazily. Never persists the token.
 */
export async function listGitHubTree(url: string, ref = "HEAD", env: NodeJS.ProcessEnv = process.env): Promise<{ ok: boolean; files: string[]; detail?: string; ran: boolean }> {
  const match = /github\.com[/:]([^/]+)\/([^/.]+)/.exec(url);
  if (!match) return { ok: false, files: [], detail: "not a github url", ran: false };
  const [, owner, repo] = match;
  const { token } = resolveToken(env);
  const headers: Record<string, string> = { Accept: "application/vnd.github+json", "User-Agent": "archmap" };
  if (token) headers.Authorization = `Bearer ${token}`;
  try {
    const api = `https://api.github.com/repos/${owner}/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`;
    const res = await fetch(api, { headers });
    if (!res.ok) return { ok: false, files: [], detail: `GitHub API HTTP ${res.status}`, ran: true };
    const data = (await res.json()) as { tree?: Array<{ path?: string; type?: string }> };
    const files = (data.tree ?? []).filter((t) => t.type === "blob" && typeof t.path === "string").map((t) => t.path as string);
    return { ok: true, files, ran: true };
  } catch (error) {
    return { ok: false, files: [], detail: error instanceof Error ? error.message : String(error), ran: true };
  }
}
