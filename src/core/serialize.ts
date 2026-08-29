/**
 * Canonical serialization for Core results: deterministic JSON with sorted keys
 * so byte-for-byte comparison works across runs and conformance fixtures.
 */

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

export function serialize(payload: unknown): string {
  return JSON.stringify(sortKeys(payload));
}

export function deserialize(text: string): unknown {
  return JSON.parse(text) as unknown;
}
