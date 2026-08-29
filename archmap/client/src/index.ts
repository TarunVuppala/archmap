export type JsonObject = Record<string, unknown>;

export interface ApiEnvelope<T = unknown> extends JsonObject {
  ok: boolean;
  nodes: JsonObject[];
  edges: JsonObject[];
  paths: JsonObject[];
  counts: JsonObject;
  risk: string[];
  evidence_used: boolean;
  data?: T;
  error?: string;
}

export interface ArchitectureMapperClientOptions {
  /** Base daemon URL, for example http://127.0.0.1:8765. */
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
}

/** Language-neutral client for the daemon's shared JSON operations. */
export class ArchitectureMapperClient {
  private readonly baseUrl: string;
  private readonly fetcher: typeof globalThis.fetch;

  constructor(options: ArchitectureMapperClientOptions = {}) {
    this.baseUrl = (options.baseUrl || 'http://127.0.0.1:8765').replace(/\/$/, '');
    this.fetcher = options.fetch || globalThis.fetch.bind(globalThis);
  }

  async request<T = unknown>(operation: string, body: JsonObject = {}): Promise<ApiEnvelope<T>> {
    const response = await this.fetcher(`${this.baseUrl}/v1/${operation}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const payload = await response.json() as ApiEnvelope<T>;
    if (!response.ok) throw new Error(payload.error || `Architecture Mapper request failed: ${response.status}`);
    return payload;
  }

  sync(workspace?: string): Promise<ApiEnvelope> { return this.request('sync', workspace ? { workspace } : {}); }
  search(q: string, options: JsonObject = {}): Promise<ApiEnvelope> { return this.request('search', { q, ...options }); }
  symbol(id: string, options: JsonObject = {}): Promise<ApiEnvelope> { return this.request('symbol', { id, ...options }); }
  neighbors(id: string, direction = 'both', options: JsonObject = {}): Promise<ApiEnvelope> { return this.request('neighbors', { id, direction, ...options }); }
  blastRadius(id: string, options: JsonObject = {}): Promise<ApiEnvelope> { return this.request('blast_radius', { id, ...options }); }
  whyPath(from: string, to: string, options: JsonObject = {}): Promise<ApiEnvelope> { return this.request('why_path', { from, to, ...options }); }
  diffImpact(options: JsonObject = {}): Promise<ApiEnvelope> { return this.request('diff_impact', options); }
  planChange(options: JsonObject): Promise<ApiEnvelope> { return this.request('plan_change', options); }
  testsToRun(id: string, options: JsonObject = {}): Promise<ApiEnvelope> { return this.request('tests_to_run', { id, ...options }); }
  docsFor(name: string, options: JsonObject = {}): Promise<ApiEnvelope> { return this.request('docs_for', { name, ...options }); }
  health(options: JsonObject = {}): Promise<ApiEnvelope> { return this.request('health', options); }
  usage(options: JsonObject = {}): Promise<ApiEnvelope> { return this.request('usage', options); }
  route(task: string, options: JsonObject = {}): Promise<ApiEnvelope> { return this.request('route', { task, ...options }); }
  orchestrate(task: string, options: JsonObject = {}): Promise<ApiEnvelope> { return this.request('orchestrate', { task, ...options }); }
}
