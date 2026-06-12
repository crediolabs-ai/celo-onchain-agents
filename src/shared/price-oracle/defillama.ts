/**
 * DefiLlama price oracle — historical + spot USD prices for Celo assets.
 *
 * Owner: Credio (shared/price-oracle).
 *
 * Used by:
 *   - PNL calculator (gas cost USD conversion, optional unrealized PNL)
 *   - CSV exporter (annotate rows with the USD value at the time of each tx)
 *   - Orchestrator (final report's "spot" column for remaining inventory)
 *
 * Why DefiLlama over CoinGecko:
 *   - Fully public API at https://coins.llama.fi — no key, no auth, no paid tier.
 *   - Returns multiple coins in a single call (perfect for batch enrichment).
 *   - Historical endpoint returns the nearest point to the requested Unix
 *     timestamp (not day-bucketed), so gas-cost accuracy doesn't drift.
 *   - DefiLlama re-aggregates from many sources; their `confidence` field
 *     tells the caller how reliable a price is.
 *
 * API notes:
 *   - Spot:       GET /prices/current/{coins}                 (coins: comma-sep coingecko:ids)
 *   - Historical: GET /prices/historical/{timestamp}/{coins}  (returns nearest point)
 *
 * ID namespace: DefiLlama uses `coingecko:{id}` prefixes, so the symbol→ID
 * map below reuses the same bare IDs we used for CoinGecko. We prepend
 * `coingecko:` at URL-build time only.
 */

import { z } from 'zod';
import { DefiLlamaError } from '../errors.js';
import { httpFetch } from '../http.js';
import type { Timestamp } from '../types.js';

// ─── Public surface ─────────────────────────────────────────────────────────

/** Map Celo-side token symbols → DefiLlama coin IDs (bare, no prefix). */
export const DEFILLAMA_ID_BY_SYMBOL: Record<string, string> = {
  CELO: 'celo',
  cUSD: 'celo-dollar', // Celo Dollar
  cEUR: 'celo-euro',
  cREAL: 'celo-real-creal',
  USDC: 'usd-coin',
  USDT: 'tether',
  G$: 'gooddollar', // GoodDollar
};

export interface PricePoint {
  /** Unix seconds — the actual moment DefiLlama reports the price for. */
  timestamp: Timestamp;
  /** USD per 1 token, decimal. */
  priceUsd: number;
  /**
   * How many hours stale this snapshot is relative to the requested moment.
   * DefiLlama returns the nearest available point, so this is typically
   * very small (< 1h) for active tokens. Kept for API parity with the
   * previous CoinGecko oracle.
   */
  staleByHours: number;
}

export interface DefiLlamaOracleOptions {
  /**
   * Override the base URL. Defaults to the public endpoint.
   * Exposed for tests and for self-hosted DefiLlama instances.
   */
  baseUrl?: string;
  /**
   * Override the fetch implementation (used by tests to stub responses).
   * Must match the signature of `httpFetch`.
   */
  fetcher?: typeof httpFetch;
}

// ─── Zod schemas for response validation ───────────────────────────────────

const CoinsWrapperSchema = z.object({
  coins: z.record(
    z.string(),
    z.object({
      price: z.number().nonnegative(),
      symbol: z.string().optional(),
      timestamp: z.number().int().nonnegative(),
      confidence: z.number().optional(),
    }),
  ),
});

// ─── Client ─────────────────────────────────────────────────────────────────

export class DefiLlamaOracle {
  private readonly baseUrl: string;
  private readonly fetcher: typeof httpFetch;
  /**
   * In-memory cache: `key = `${symbol}:${timestamp}`` → price.
   * Reset on process exit; the orchestrator can wrap this with a disk cache
   * later if cold-start latency matters.
   */
  private readonly cache = new Map<string, PricePoint>();

  constructor(options: DefiLlamaOracleOptions = {}) {
    this.baseUrl = options.baseUrl ?? 'https://coins.llama.fi';
    this.fetcher = options.fetcher ?? httpFetch;
  }

  /**
   * Look up the USD price for `symbol` at (or near) `timestamp`.
   *
   * DefiLlama's `/prices/historical/{ts}` returns the single nearest point,
   * so there's no fall-back path to maintain (unlike CoinGecko's
   * `/history` vs `/market_chart/range` split).
   */
  async getHistoricalPrice(symbol: string, timestamp: Timestamp): Promise<PricePoint | null> {
    const id = DEFILLAMA_ID_BY_SYMBOL[symbol];
    if (!id) {
      // Unknown symbol — return null so the caller records a price gap.
      return null;
    }
    const cacheKey = `${symbol}:${timestamp}`;
    const cached = this.cache.get(cacheKey);
    if (cached) return cached;

    const url = `${this.baseUrl}/prices/historical/${timestamp}/coingecko:${id}`;
    const res = await this.fetcher<unknown>(url);
    const parsed = CoinsWrapperSchema.safeParse(res.data);
    if (!parsed.success) {
      throw new DefiLlamaError(
        `DefiLlama /prices/historical returned an unexpected shape for ${symbol}@${timestamp}`,
        parsed.error,
      );
    }
    const coin = parsed.data.coins[`coingecko:${id}`];
    if (!coin) return null;

    const point: PricePoint = {
      timestamp: coin.timestamp as Timestamp,
      priceUsd: coin.price,
      staleByHours: Math.abs(coin.timestamp - timestamp) / 3600,
    };
    this.cache.set(cacheKey, point);
    return point;
  }

  /**
   * Batch helper: fetch prices for many (symbol, timestamp) pairs.
   *
   * DefiLlama's historical endpoint is point-in-time (not range), so the
   * optimal batching strategy is one call per (symbol, timestamp) pair.
   * For an 8-tx wallet with 3 unique assets, that's ~24 parallel calls —
   * well within DefiLlama's generous public quota (no documented rate limit).
   *
   * Returns a Map keyed by `${symbol}:${timestamp}`. Unknown symbols map
   * to `null` (consistent with `getHistoricalPrice`).
   */
  async batchHistoricalPrices(
    requests: { symbol: string; timestamp: Timestamp }[],
  ): Promise<Map<string, PricePoint | null>> {
    const out = new Map<string, PricePoint | null>();
    if (requests.length === 0) return out;

    await Promise.all(
      requests.map(async (r) => {
        const key = `${r.symbol}:${r.timestamp}`;
        // De-dupe: skip if already resolved (e.g. duplicate request).
        if (out.has(key)) return;
        const point = await this.getHistoricalPrice(r.symbol, r.timestamp);
        out.set(key, point);
      }),
    );
    return out;
  }

  /**
   * Spot price for a symbol right now. Used by the orchestrator for the
   * final "unrealized PNL" column.
   */
  async getSpotPrice(symbol: string): Promise<PricePoint | null> {
    const id = DEFILLAMA_ID_BY_SYMBOL[symbol];
    if (!id) return null;
    const url = `${this.baseUrl}/prices/current/coingecko:${id}`;
    const res = await this.fetcher<unknown>(url);
    const parsed = CoinsWrapperSchema.safeParse(res.data);
    if (!parsed.success) {
      throw new DefiLlamaError(
        `DefiLlama /prices/current returned an unexpected shape for ${symbol}`,
        parsed.error,
      );
    }
    const coin = parsed.data.coins[`coingecko:${id}`];
    if (!coin) return null;
    return {
      timestamp: coin.timestamp as Timestamp,
      priceUsd: coin.price,
      staleByHours: 0,
    };
  }
}

// ─── Pure helpers (exported for tests) ──────────────────────────────────────

/** Snap a list of points to the one nearest a target timestamp. */
export function nearestPoint(points: PricePoint[], target: Timestamp): PricePoint | null {
  if (points.length === 0) return null;
  let best = points[0]!;
  let bestDelta = Math.abs(best.timestamp - target);
  for (let i = 1; i < points.length; i++) {
    const p = points[i]!;
    const delta = Math.abs(p.timestamp - target);
    if (delta < bestDelta) {
      best = p;
      bestDelta = delta;
    }
  }
  return best;
}
