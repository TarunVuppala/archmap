/**
 * .archmap/workspace.yaml parser (dependency-free, minimal subset).
 *
 * Declares additional repo roots so one graph can span multiple repos:
 *
 *   roots:
 *     - name: web
 *       path: ../web-frontend        # sibling repo on disk
 *   remotes:
 *     - name: orders
 *       url: https://github.com/acme/orders
 *       ref: main                     # pinned ref (default: default branch)
 *       mode: clone                   # clone (default) | api (no-clone)
 *
 * No secrets live here; auth comes from the environment at run time.
 */

import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

export interface RootEntry {
  name: string;
  path: string;
}

export interface RemoteEntry {
  name: string;
  url: string;
  ref?: string;
  mode: "clone" | "api";
}

export interface WorkspaceConfig {
  roots: RootEntry[];
  remotes: RemoteEntry[];
}

export function workspaceConfigPath(workspace: string): string {
  return join(workspace, ".archmap", "workspace.yaml");
}

/** Parse the tiny list-of-maps YAML subset we support. Never throws. */
export function parseWorkspaceYaml(text: string): WorkspaceConfig {
  const roots: RootEntry[] = [];
  const remotes: RemoteEntry[] = [];
  let section: "roots" | "remotes" | null = null;
  let current: Record<string, string> | null = null;

  const flush = (): void => {
    if (!current || !section) return;
    if (section === "roots" && current.name && current.path) {
      roots.push({ name: current.name, path: current.path });
    } else if (section === "remotes" && current.name && current.url) {
      remotes.push({
        name: current.name,
        url: current.url,
        ref: current.ref,
        mode: current.mode === "api" ? "api" : "clone",
      });
    }
    current = null;
  };

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").replace(/\s+$/, "");
    if (!line.trim()) continue;
    const topMatch = /^([A-Za-z_]+):\s*$/.exec(line);
    if (topMatch && (topMatch[1] === "roots" || topMatch[1] === "remotes")) {
      flush();
      section = topMatch[1];
      continue;
    }
    const itemStart = /^\s*-\s*([A-Za-z_]+):\s*(.*)$/.exec(line);
    if (itemStart) {
      flush();
      current = {};
      const key = itemStart[1]!;
      const value = stripQuotes(itemStart[2] ?? "");
      if (value) current[key] = value;
      continue;
    }
    const field = /^\s+([A-Za-z_]+):\s*(.*)$/.exec(line);
    if (field && current) {
      current[field[1]!] = stripQuotes(field[2] ?? "");
    }
  }
  flush();
  return { roots, remotes };
}

function stripQuotes(value: string): string {
  const v = value.trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) return v.slice(1, -1);
  return v;
}

export function loadWorkspaceConfig(workspace: string): WorkspaceConfig {
  const path = workspaceConfigPath(workspace);
  if (!existsSync(path)) return { roots: [], remotes: [] };
  try {
    return parseWorkspaceYaml(readFileSync(path, "utf8"));
  } catch {
    return { roots: [], remotes: [] };
  }
}

/** Resolve a declared root path relative to the primary workspace. */
export function resolveRootPath(workspace: string, entry: RootEntry): string {
  return isAbsolute(entry.path) ? entry.path : resolve(workspace, entry.path);
}
