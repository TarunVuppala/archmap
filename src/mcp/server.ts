/**
 * MCP stdio server (thin client over the Core dispatch).
 *
 * Dependency-free JSON-RPC over newline-delimited stdin/stdout. Tools map 1:1
 * to Core operations, so MCP clients receive the same canonical JSON as the
 * CLI. No graph or impact logic lives here.
 */

import { createInterface } from "node:readline";
import { dispatch, CORE_OPERATIONS, type DispatchArgs } from "../core/operations.js";
import { errorEnvelope } from "../core/contracts.js";

const PROTOCOL_VERSION = "2024-11-05";
const SERVER_INFO = { name: "architecture-mapper", version: "0.1.0" };

const WORKSPACE_PROP = { type: "string", description: "workspace path; defaults to the server workspace" };
const DB_PROP = { type: "string", description: "SQLite path (relative to workspace by default)" };

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

function obj(props: Record<string, unknown>, required: string[] = []): Record<string, unknown> {
  return { type: "object", properties: { ...props, workspace: WORKSPACE_PROP, db: DB_PROP }, required };
}

export const TOOLS: ToolDef[] = [
  { name: "sync", description: "Index or re-index the workspace into the one graph.", inputSchema: obj({ force: { type: "boolean" } }) },
  { name: "impact", description: "Bounded blast radius + why-paths for a node.", inputSchema: obj({ id: { type: "string" }, direction: { type: "string", enum: ["downstream", "upstream"] }, depth: { type: "integer" } }, ["id"]) },
  { name: "why_path", description: "Evidence-backed paths between two nodes.", inputSchema: obj({ from: { type: "string" }, to: { type: "string" } }, ["from", "to"]) },
  { name: "search", description: "Graph + RAG search.", inputSchema: obj({ q: { type: "string" }, kind: { type: "string" } }, ["q"]) },
  { name: "symbol", description: "A node plus its neighbors.", inputSchema: obj({ id: { type: "string" } }, ["id"]) },
  { name: "neighbors", description: "Adjacent edges and nodes.", inputSchema: obj({ id: { type: "string" }, direction: { type: "string", enum: ["in", "out", "both"] } }, ["id"]) },
  { name: "tests_to_run", description: "Tests reachable from a change + inferred command.", inputSchema: obj({ id: { type: "string" } }, ["id"]) },
  { name: "diff_impact", description: "Symbol-level diff impact.", inputSchema: obj({ base: { type: "string" }, head: { type: "string" } }) },
  { name: "graph", description: "Export a bounded graph view.", inputSchema: obj({ view: { type: "string" } }) },
  { name: "health", description: "Graph consistency + inference health.", inputSchema: obj({}) },
  { name: "validate_graph", description: "Graph consistency checks.", inputSchema: obj({}) },
  { name: "evaluate_policy", description: "Policy warnings for a change.", inputSchema: obj({ id: { type: "string" } }, ["id"]) },
  { name: "pin", description: "Add a user-confirmed edge.", inputSchema: obj({ type: { type: "string" }, from: { type: "string" }, to: { type: "string" }, note: { type: "string" } }, ["type", "from", "to"]) },
];

const TOOL_NAMES = new Set(TOOLS.map((t) => t.name));

export interface JsonRpcMessage {
  jsonrpc?: string;
  id?: unknown;
  method?: string;
  params?: Record<string, unknown>;
}

export class McpServer {
  constructor(private readonly workspace: string) {}

  handle(message: JsonRpcMessage): Record<string, unknown> | null {
    const id = message.id;
    const method = message.method;
    if (typeof method !== "string") return this.error(id, -32600, "method is required");
    switch (method) {
      case "initialize":
        return this.result(id, {
          protocolVersion: (message.params?.protocolVersion as string) ?? PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
          instructions: "Run sync before graph queries when the workspace changed.",
        });
      case "notifications/initialized":
        return null;
      case "ping":
        return this.result(id, {});
      case "tools/list":
        return this.result(id, { tools: TOOLS });
      case "tools/call":
        return this.callTool(id, message.params ?? {});
      default:
        return this.error(id, -32601, `method not found: ${method}`);
    }
  }

  private callTool(id: unknown, params: Record<string, unknown>): Record<string, unknown> {
    const name = params.name as string;
    const args = (params.arguments as Record<string, unknown>) ?? {};
    if (!TOOL_NAMES.has(name)) return this.toolResponse(id, errorEnvelope(`unknown tool: ${name}`));
    // impact tool maps to the blast_radius core operation.
    const op = name === "impact" ? "blast_radius" : name;
    const dispatchArgs: DispatchArgs = { workspace: this.workspace, ...args };
    if (name === "sync") {
      // sync is not a pure graph read; keep MCP read-focused by advising the CLI.
      return this.toolResponse(id, errorEnvelope("run `archmap sync` from the CLI; the MCP server is read-only over the indexed graph"));
    }
    if (!(CORE_OPERATIONS as readonly string[]).includes(op)) {
      return this.toolResponse(id, errorEnvelope(`unsupported tool: ${name}`));
    }
    const payload = dispatch(op, dispatchArgs, this.workspace);
    return this.toolResponse(id, payload as Record<string, unknown>);
  }

  private toolResponse(id: unknown, payload: Record<string, unknown>): Record<string, unknown> {
    return this.result(id, {
      content: [{ type: "text", text: JSON.stringify(payload) }],
      structuredContent: payload,
      isError: !(payload.ok as boolean),
    });
  }

  private result(id: unknown, result: Record<string, unknown>): Record<string, unknown> {
    return { jsonrpc: "2.0", id: id ?? null, result };
  }

  private error(id: unknown, code: number, message: string): Record<string, unknown> {
    return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
  }
}

export function runStdio(workspace: string): Promise<number> {
  const server = new McpServer(workspace);
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  return new Promise((resolve) => {
    rl.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let response: Record<string, unknown> | null;
      try {
        response = server.handle(JSON.parse(trimmed) as JsonRpcMessage);
      } catch {
        response = { jsonrpc: "2.0", id: null, error: { code: -32700, message: "invalid JSON" } };
      }
      if (response) process.stdout.write(JSON.stringify(response) + "\n");
    });
    rl.on("close", () => resolve(0));
  });
}
