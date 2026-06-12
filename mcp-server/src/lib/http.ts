/**
 * Shared HTTP utilities for MCP server tools.
 *
 * Reused by all tools that call external APIs (CoinGecko, Celoscan).
 */

/** Simple fetch with retries and exponential backoff. */
export async function fetchWithRetry<T>(
  url: string,
  opts: { retries?: number; headers?: Record<string, string> } = {},
): Promise<T> {
  const { retries = 3, headers = {} } = opts;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { headers });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      }
      return res.json() as T;
    } catch (err) {
      lastErr = err;
      if (attempt < retries) {
        await sleep(500 * 2 ** attempt);
      }
    }
  }
  throw lastErr;
}

/** Promise-based setTimeout. */
export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
