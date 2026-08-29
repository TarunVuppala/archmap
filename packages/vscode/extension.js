const vscode = require('vscode');
const childProcess = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');

const SERVER_NAME = 'architecture-mapper';

function activate(context) {
  const folder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
  if (!folder) return;
  const root = folder.uri.fsPath;
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  status.text = 'ArchMap · looking…';
  status.tooltip = 'Architecture Mapper';
  status.show();
  context.subscriptions.push(status);

  mergeMcpConfig(root);
  const daemonPromise = ensureDaemon(root);
  const codeLens = new ArchitectureCodeLensProvider(root);
  context.subscriptions.push(vscode.languages.registerCodeLensProvider([{ scheme: 'file' }], codeLens));
  context.subscriptions.push(vscode.languages.registerHoverProvider([{ scheme: 'file' }], new ArchitectureHoverProvider(root)));
  context.subscriptions.push(vscode.commands.registerCommand('architectureMapper.showImpact', (id) => showImpact(root, id)));
  context.subscriptions.push(vscode.commands.registerCommand('architectureMapper.openGraph', () => vscode.commands.executeCommand('workbench.view.extension.architectureMapper')));
  context.subscriptions.push(vscode.window.registerWebviewViewProvider('architectureMapper.sidebar', new ArchitectureViewProvider(context.extensionUri, root)));
  registerMcpProvider(context, root);

  waitForDaemon(root).then((port) => {
    if (!port) {
      status.text = 'ArchMap · unavailable';
      return;
    }
    status.text = 'ArchMap · syncing…';
    return requestJson(port, '/v1/sync', { workspace: root }).then((payload) => {
      status.text = payload.ok ? 'ArchMap · live' : 'ArchMap · warning';
    }).catch(() => { status.text = 'ArchMap · unavailable'; });
  });
  daemonPromise.then((daemon) => {
    if (daemon) context.subscriptions.push({ dispose: () => daemon.kill() });
  });
}

function deactivate() {}

async function ensureDaemon(root) {
  const existing = readDaemonPort(root);
  if (existing) {
    try { await requestJson(existing, '/health'); return null; } catch (_) {
      try { fs.unlinkSync(path.join(root, '.archmap', 'daemon.json')); } catch (_) {}
    }
  }
  return childProcess.spawn('python3', ['-m', 'packages.daemon', '--workspace', root], {
    cwd: root,
    stdio: 'ignore',
    detached: false,
  });
}

function readDaemonPort(root) {
  try {
    const state = JSON.parse(fs.readFileSync(path.join(root, '.archmap', 'daemon.json'), 'utf8'));
    return Number.isInteger(state.port) ? state.port : null;
  } catch (_) { return null; }
}

async function waitForDaemon(root) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const port = readDaemonPort(root);
    if (port) {
      try { await requestJson(port, '/health'); return port; } catch (_) {}
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return null;
}

function requestJson(port, endpoint, body) {
  return new Promise((resolve, reject) => {
    const encoded = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const request = http.request({
      host: '127.0.0.1', port, path: endpoint, method: body === undefined ? 'GET' : 'POST',
      headers: encoded ? { 'Content-Type': 'application/json', 'Content-Length': encoded.length } : {},
    }, (response) => {
      let data = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { data += chunk; });
      response.on('end', () => {
        try {
          const payload = JSON.parse(data);
          if (response.statusCode >= 400) reject(new Error(payload.error || 'daemon request failed'));
          else resolve(payload);
        } catch (error) { reject(error); }
      });
    });
    request.on('error', reject);
    if (encoded) request.write(encoded);
    request.end();
  });
}

function mergeMcpConfig(root) {
  const configPath = path.join(root, '.mcp.json');
  let config = {};
  if (fs.existsSync(configPath)) {
    try { config = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch (_) { return; }
    if (!config || typeof config !== 'object' || Array.isArray(config)) return;
  }
  config.mcpServers = config.mcpServers || {};
  config.mcpServers[SERVER_NAME] = {
    command: 'python3', args: ['-m', 'packages.cli', 'mcp'], cwd: '${workspaceFolder}',
  };
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

function registerMcpProvider(context, root) {
  try {
    if (!vscode.lm || !vscode.lm.registerMcpServerDefinitionProvider || !vscode.McpStdioServerDefinition) return;
    const provider = {
      provideMcpServerDefinitions: () => {
        const definition = new vscode.McpStdioServerDefinition(
          'Architecture Mapper', 'python3', ['-m', 'packages.cli', 'mcp'],
        );
        definition.cwd = root;
        return [definition];
      },
    };
    context.subscriptions.push(vscode.lm.registerMcpServerDefinitionProvider(SERVER_NAME, provider));
  } catch (_) {
    // Older VS Code builds can still use the merged .mcp.json configuration.
  }
}

class ArchitectureCodeLensProvider {
  constructor(root) { this.root = root; }

  provideCodeLenses(document) {
    const relative = path.relative(this.root, document.uri.fsPath).split(path.sep).join('/');
    const lenses = [];
    document.getText().split(/\r?\n/).forEach((line, index) => {
      const match = line.match(/^\s*(?:(?:export\s+)?(?:async\s+)?function|(?:async\s+)?def|class)\s+([A-Za-z_$][\w$]*)/);
      if (!match) return;
      const kind = /class\s+/.test(line) ? 'cls' : 'fn';
      const id = `${kind}:${relative}:${match[1]}`;
      const range = new vscode.Range(index, 0, index, line.length);
      lenses.push(new vscode.CodeLens(range, {
        title: '$(graph) impact', command: 'architectureMapper.showImpact', arguments: [id],
      }));
    });
    return lenses;
  }
}

class ArchitectureHoverProvider {
  constructor(root) { this.root = root; }

  async provideHover(document, position) {
    const range = document.getWordRangeAtPosition(position, /[A-Za-z_$][\w$]*/);
    if (!range) return undefined;
    const name = document.getText(range);
    const relative = path.relative(this.root, document.uri.fsPath).split(path.sep).join('/');
    const candidates = [`fn:${relative}:${name}`, `cls:${relative}:${name}`];
    const port = readDaemonPort(this.root);
    if (!port) return undefined;
    for (const id of candidates) {
      try {
        const payload = await requestJson(port, '/v1/blast_radius', { id, workspace: this.root });
        return new vscode.Hover(new vscode.MarkdownString(formatImpact(payload)));
      } catch (_) {}
    }
    return undefined;
  }
}

class ArchitectureViewProvider {
  constructor(extensionUri, root) { this.extensionUri = extensionUri; this.root = root; }

  resolveWebviewView(view) {
    view.webview.options = { enableScripts: true, localResourceRoots: [this.extensionUri] };
    const script = view.webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview.js'));
    view.webview.html = `<!doctype html><html><body><div id="root"></div><script src="${script}"></script></body></html>`;
    view.webview.onDidReceiveMessage(async (message) => {
      if (message.command !== 'refresh') return;
      const port = readDaemonPort(this.root);
      if (!port) return;
      try {
        await requestJson(port, '/v1/sync', { workspace: this.root });
        const graph = await requestJson(port, '/v1/graph', { workspace: this.root, view: message.view || 'architecture' });
        view.webview.postMessage({ type: 'graph', payload: graph });
      } catch (error) { view.webview.postMessage({ type: 'error', message: error.message }); }
    });
    view.webview.postMessage({ type: 'ready' });
  }
}

async function showImpact(root, id) {
  const port = readDaemonPort(root);
  if (!port) { vscode.window.showWarningMessage('Architecture Mapper daemon is not available.'); return; }
  try {
    const payload = await requestJson(port, '/v1/blast_radius', { id, workspace: root });
    const count = Object.values(payload.counts || {}).reduce((sum, value) => sum + value, 0);
    vscode.window.showInformationMessage(`${id}: ${count} impacted nodes${payload.risk?.length ? ` · ${payload.risk.join(', ')}` : ''}`);
  } catch (error) { vscode.window.showErrorMessage(`Architecture Mapper: ${error.message}`); }
}

function formatImpact(payload) {
  const lines = ['**Architecture Mapper**', '', `Impact: ${JSON.stringify(payload.counts || {})}`];
  if (payload.risk?.length) lines.push(`Risk: ${payload.risk.join(', ')}`);
  if (payload.docs?.length) lines.push(`Docs: ${payload.docs.map((doc) => doc.name).join(', ')}`);
  const path = payload.paths?.[0];
  if (path) lines.push(`Why: ${path.nodes.join(' → ')}`);
  return lines.join('\n\n');
}

module.exports = { activate, deactivate };
