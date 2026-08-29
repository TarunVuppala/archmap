/**
 * Localhost HTTP daemon (thin client over the Core dispatch).
 *
 * POST 127.0.0.1:<port>/v1/<operation> with a JSON body -> canonical envelope.
 * GET /health for a liveness probe. Writes .archmap/daemon.json with the port.
 * No graph or impact logic here.
 */

import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { dispatch } from "../core/operations.js";
import { errorEnvelope, type Envelope } from "../core/contracts.js";
import { syncWorkspace } from "../index/indexer.js";

function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      if (!raw) return resolve({});
      try {
        const parsed = JSON.parse(raw) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) resolve(parsed as Record<string, unknown>);
        else reject(new Error("request body must be a JSON object"));
      } catch {
        reject(new Error("invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function send(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}

export function createDaemon(workspace: string): Server {
  return createServer((req, res) => {
    void handle(req, res, workspace);
  });
}

async function handle(req: IncomingMessage, res: ServerResponse, workspace: string): Promise<void> {
  const url = req.url ?? "";
  if (req.method === "GET" && url === "/health") {
    send(res, 200, { ok: true, service: "architecture-mapper" });
    return;
  }
  if (req.method !== "POST" || !url.startsWith("/v1/")) {
    send(res, 404, errorEnvelope("not found"));
    return;
  }
  const op = url.slice("/v1/".length).replace(/\/+$/, "");
  try {
    const args = await readBody(req);
    args.workspace = (args.workspace as string) ?? workspace;
    let payload: Envelope;
    if (op === "sync") payload = await syncWorkspace(String(args.workspace), join(String(args.workspace), ".archmap", "index.db"), Boolean(args.force));
    else payload = dispatch(op === "impact" ? "blast_radius" : op, args, workspace);
    send(res, payload.ok ? 200 : 400, payload);
  } catch (error) {
    send(res, 400, errorEnvelope(error instanceof Error ? error.message : String(error)));
  }
}

export function runDaemon(workspace: string, port = 0): Promise<{ port: number; close: () => void }> {
  const server = createDaemon(workspace);
  const statePath = join(workspace, ".archmap", "daemon.json");
  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      const addr = server.address();
      const actualPort = typeof addr === "object" && addr ? addr.port : port;
      mkdirSync(join(workspace, ".archmap"), { recursive: true });
      writeFileSync(statePath, JSON.stringify({ pid: process.pid, port: actualPort }, null, 2) + "\n", "utf8");
      const close = (): void => {
        server.close();
        try {
          rmSync(statePath, { force: true });
        } catch {
          /* ignore */
        }
      };
      process.on("SIGINT", close);
      process.on("SIGTERM", close);
      resolve({ port: actualPort, close });
    });
  });
}
