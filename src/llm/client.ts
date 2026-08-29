/**
 * Optional, provider-neutral LLM client.
 *
 * Configured entirely by environment / config: works with ANY OpenAI-compatible
 * chat endpoint (local models like Ollama/LM Studio or cloud) via a base URL +
 * API key + model name. When nothing is configured, the client reports
 * unconfigured and callers fall back to deterministic behavior. No provider is
 * hard-coded; no network call happens unless explicitly configured.
 *
 *   ARCHMAP_LLM_BASE_URL   e.g. http://localhost:11434/v1  or  https://api.openai.com/v1
 *   ARCHMAP_LLM_API_KEY    optional (local models often need none)
 *   ARCHMAP_LLM_MODEL      e.g. llama3.1 / gpt-4o-mini
 */

export interface LlmConfig {
  configured: boolean;
  baseUrl?: string;
  apiKey?: string;
  model?: string;
}

export function loadLlmConfig(env: NodeJS.ProcessEnv = process.env): LlmConfig {
  const baseUrl = env.ARCHMAP_LLM_BASE_URL?.trim();
  const model = env.ARCHMAP_LLM_MODEL?.trim();
  if (!baseUrl || !model) return { configured: false };
  return {
    configured: true,
    baseUrl: baseUrl.replace(/\/+$/, ""),
    apiKey: env.ARCHMAP_LLM_API_KEY?.trim(),
    model,
  };
}

export interface CompletionResult {
  ok: boolean;
  configured: boolean;
  text: string;
  model?: string;
  error?: string;
}

/**
 * Best-effort chat completion. Never throws: returns ok:false with a reason so
 * callers can degrade gracefully. Requires an explicit config.
 */
export async function complete(
  prompt: string,
  options: { system?: string; maxTokens?: number; timeoutMs?: number; config?: LlmConfig } = {}
): Promise<CompletionResult> {
  const config = options.config ?? loadLlmConfig();
  if (!config.configured || !config.baseUrl || !config.model) {
    return { ok: false, configured: false, text: "", error: "no LLM configured" };
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 30_000);
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;
    const messages = [
      ...(options.system ? [{ role: "system", content: options.system }] : []),
      { role: "user", content: prompt },
    ];
    const res = await fetch(`${config.baseUrl}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ model: config.model, messages, max_tokens: options.maxTokens ?? 512, temperature: 0.2 }),
      signal: controller.signal,
    });
    if (!res.ok) return { ok: false, configured: true, text: "", model: config.model, error: `LLM HTTP ${res.status}` };
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const text = data.choices?.[0]?.message?.content ?? "";
    return { ok: true, configured: true, text, model: config.model };
  } catch (error) {
    return { ok: false, configured: true, text: "", model: config.model, error: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timeout);
  }
}
