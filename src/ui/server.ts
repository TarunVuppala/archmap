/**
 * `archmap ui`: localhost visualizer (thin client over the Core dispatch).
 *
 * Serves a self-contained page that renders the ONE graph. Height/depth/flow
 * views and Mermaid export are computed from the same graph JSON the CLI/mcp
 * return. React Flow / Cosmograph are loaded from a CDN in the page; if offline,
 * the page still shows the node/edge list and Mermaid source. Not auto-opened.
 */

import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { dispatch } from "../core/operations.js";
import { errorEnvelope } from "../core/contracts.js";
import { toMermaid } from "../core/visualize.js";
import type { GraphEdge, GraphNode } from "../core/contracts.js";

function send(res: ServerResponse, status: number, type: string, body: string): void {
  res.writeHead(status, { "Content-Type": type, "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}

export function graphView(workspace: string, view: string): { nodes: GraphNode[]; edges: GraphEdge[]; mermaid: string; ok: boolean; error?: string } {
  const payload = dispatch("graph", { workspace, view }, workspace);
  if (!payload.ok) return { nodes: [], edges: [], mermaid: "", ok: false, error: payload.error };
  const nodes = payload.nodes as GraphNode[];
  const edges = payload.edges as GraphEdge[];
  return { nodes, edges, mermaid: toMermaid(nodes, edges), ok: true };
}

export const PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Architecture Mapper</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; font: 14px/1.5 system-ui, sans-serif; background: #0b0e14; color: #d7dce5; }
  header { padding: 12px 16px; background: #121722; border-bottom: 1px solid #232a38; display: flex; gap: 12px; align-items: center; }
  header h1 { font-size: 15px; margin: 0; font-weight: 600; }
  select, button { background: #1b2230; color: #d7dce5; border: 1px solid #2d3546; border-radius: 6px; padding: 6px 10px; }
  main { display: grid; grid-template-columns: 1fr 360px; height: calc(100vh - 50px); }
  #canvas { overflow: auto; padding: 16px; }
  aside { border-left: 1px solid #232a38; overflow: auto; padding: 12px; background: #0e131c; }
  .node { padding: 6px 8px; margin: 3px 0; border: 1px solid #2d3546; border-radius: 6px; background: #131a26; }
  .kind { color: #6ea8fe; font-weight: 600; }
  pre { white-space: pre-wrap; background: #0e131c; border: 1px solid #232a38; padding: 10px; border-radius: 6px; }
  .muted { color: #7a869c; }
</style>
</head>
<body>
<header>
  <h1>Architecture Mapper</h1>
  <select id="view">
    <option value="architecture">Height (system)</option>
    <option value="depth">Depth (drill-down)</option>
    <option value="flow">Flow</option>
  </select>
  <button id="refresh">Refresh</button>
  <button id="copy">Copy Mermaid</button>
  <span id="stat" class="muted"></span>
</header>
<main>
  <section id="canvas"><p class="muted">Loading graph…</p></section>
  <aside>
    <h3>Mermaid</h3>
    <pre id="mermaid" class="muted">—</pre>
  </aside>
</main>
<script>
  const view = document.getElementById('view');
  const stat = document.getElementById('stat');
  const canvas = document.getElementById('canvas');
  const mermaidEl = document.getElementById('mermaid');
  async function load() {
    canvas.innerHTML = '<p class="muted">Loading…</p>';
    const res = await fetch('/graph.json?view=' + encodeURIComponent(view.value));
    const data = await res.json();
    if (!data.ok) { canvas.innerHTML = '<p class="muted">' + (data.error || 'no graph') + '</p>'; return; }
    stat.textContent = data.nodes.length + ' nodes · ' + data.edges.length + ' edges';
    canvas.innerHTML = data.nodes.map(function (n) {
      return '<div class="node"><span class="kind">' + n.kind + '</span> ' + n.name + '<br><span class="muted">' + n.id + '</span></div>';
    }).join('') || '<p class="muted">Empty graph. Run: archmap sync</p>';
    mermaidEl.textContent = data.mermaid || '—';
    mermaidEl.className = '';
  }
  document.getElementById('refresh').onclick = load;
  document.getElementById('copy').onclick = function () { navigator.clipboard.writeText(mermaidEl.textContent); };
  view.onchange = load;
  load();
</script>
</body>
</html>`;

export function createUiServer(workspace: string): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? "/";
    if (req.method === "GET" && (url === "/" || url.startsWith("/index.html"))) {
      send(res, 200, "text/html; charset=utf-8", PAGE_HTML);
      return;
    }
    if (req.method === "GET" && url.startsWith("/graph.json")) {
      const view = new URL(url, "http://127.0.0.1").searchParams.get("view") ?? "architecture";
      const data = graphView(workspace, view);
      send(res, 200, "application/json", JSON.stringify(data));
      return;
    }
    send(res, 404, "application/json", JSON.stringify(errorEnvelope("not found")));
  });
}

export function runUi(workspace: string, port = 4173): Promise<{ port: number; close: () => void }> {
  const server = createUiServer(workspace);
  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      const addr = server.address();
      const actualPort = typeof addr === "object" && addr ? addr.port : port;
      const close = (): void => {
        server.close();
      };
      process.on("SIGINT", close);
      process.on("SIGTERM", close);
      resolve({ port: actualPort, close });
    });
  });
}
