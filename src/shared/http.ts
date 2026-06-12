/**
 * HTTP client with retry, rate-limit backoff, and structured error handling.
 *
 * Used by:
 *  - Celoscan client (src/sub-agents/tx-fetcher/celoscan.ts)
 *  - CoinGecko price oracle (src/shared/price-oracle/coingecko.ts)
 *
 * Design notes:
 *  - Built on global `fetch` (Node 20+), no external HTTP dep.
 *  - Rate-limit aware: respects `Retry-After` and exponential backoff.
 *  - Caps retries so a misconfigured endpoint cannot hang the agent.
 *  - Times out at 30s by default (Celoscan paginated calls can be slow).
 */

import { NetworkError, RateLimitError, isRateLimit } from './errors.js';

export interface HttpRequestOptions {
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: unknown;
  /** Total request timeout in ms (default 30_000). */
  timeoutMs?: number;
  /** Max retry attempts on 5xx / network errors (default 3). */
  maxRetries?: number;
  /** Max retry attempts on 429 (default 5 — we back off harder here). */
  maxRateLimitRetries?: number;
  /** Optional abort signal to cancel from outside. */
  signal?: AbortSignal;
}

export interface HttpResponse<T = unknown> {
  status: number;
  headers: Headers;
  data: T;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_MAX_RATE_LIMIT_RETRIES = 5;

/** Sleep for `ms` milliseconds. Resolves immediately on 0/negative. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

/** Parse `Retry-After` header into ms; falls back to exponential backoff. */
function parseRetryAfter(value: string | null, attempt: number): number {
  if (value) {
    const asNum = Number(value);
    if (Number.isFinite(asNum)) return Math.max(0, asNum * 1000);
    const asDate = Date.parse(value);
    if (!Number.isNaN(asDate)) return Math.max(0, asDate - Date.now());
  }
  // Exponential: 1s, 2s, 4s, 8s, 16s, capped at 30s.
  return Math.min(30_000, 1000 * 2 ** attempt);
}

/**
 * Perform a single HTTP request. Throws on non-2xx, with typed errors.
 * Exposed for callers that want to bypass retry logic (tests, health checks).
 */
export async function httpRequest<T = unknown>(
  url: string,
  options: HttpRequestOptions = {},
): Promise<HttpResponse<T>> {
  const {
    method = 'GET',
    headers = {},
    body,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    signal,
  } = options;

  const controller = new AbortController();
  const linked = signal ? linkSignals(controller, signal) : controller.signal;
  const timeoutHandle = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);

  try {
    const init: RequestInit = {
      method,
      headers: body ? { 'content-type': 'application/json', ...headers } : headers,
      signal: linked,
    };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
    }
    const res = await fetch(url, init);

    const text = await res.text();
    let data: unknown = text;
    const contentType = res.headers.get('content-type') ?? '';
    if (contentType.includes('application/json') && text) {
      try {
        data = JSON.parse(text);
      } catch {
        // Keep raw text — caller can decide.
        data = text;
      }
    }

    if (res.status === 429) {
      throw new RateLimitError(parseRetryAfter(res.headers.get('retry-after'), 0));
    }
    if (!res.ok) {
      throw new NetworkError(
        `HTTP ${res.status} ${res.statusText} for ${url}`,
        res.status,
      );
    }
    return { status: res.status, headers: res.headers, data: data as T };
  } catch (err) {
    if (err instanceof NetworkError) throw err;
    if (err instanceof Error && err.name === 'AbortError') {
      throw new NetworkError(`Request aborted (timeout ${timeoutMs}ms) for ${url}`, 0, err);
    }
    throw new NetworkError(
      `Network failure for ${url}: ${err instanceof Error ? err.message : String(err)}`,
      0,
      err,
    );
  } finally {
    clearTimeout(timeoutHandle);
  }
}

/**
 * Higher-level wrapper with retry and rate-limit backoff.
 * Use this from sub-agents.
 */
export async function httpFetch<T = unknown>(
  url: string,
  options: HttpRequestOptions = {},
): Promise<HttpResponse<T>> {
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const maxRateLimitRetries = options.maxRateLimitRetries ?? DEFAULT_MAX_RATE_LIMIT_RETRIES;

  let rateLimitAttempts = 0;
  let lastErr: unknown;

  for (let attempt = 0; attempt <= maxRetries + maxRateLimitRetries; attempt++) {
    try {
      return await httpRequest<T>(url, options);
    } catch (err) {
      lastErr = err;

      if (isRateLimit(err)) {
        if (rateLimitAttempts >= maxRateLimitRetries) throw err;
        rateLimitAttempts++;
        const wait = err.retryAfterMs ?? parseRetryAfter(null, rateLimitAttempts);
        await sleep(wait);
        continue;
      }

      if (err instanceof NetworkError && err.status && err.status >= 500) {
        if (attempt >= maxRetries) throw err;
        await sleep(500 * 2 ** attempt);
        continue;
      }

      // 4xx other than 429, or non-HTTP error: do not retry.
      throw err;
    }
  }

  /* istanbul ignore next */
  throw lastErr instanceof Error ? lastErr : new NetworkError('httpFetch: exhausted retries');
}

/** Combine an internal AbortController with an external signal. */
function linkSignals(internal: AbortController, external: AbortSignal): AbortSignal {
  if (external.aborted) {
    internal.abort(external.reason);
  } else {
    external.addEventListener('abort', () => internal.abort(external.reason), { once: true });
  }
  return internal.signal;
}
