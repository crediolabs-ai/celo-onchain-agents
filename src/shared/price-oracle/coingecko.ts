/**
 * CoinGecko price oracle — historical + spot USD prices for Celo assets.
 *
 * Owner: Credio (shared/price-oracle).
 *
 * Used by:
 *   - PNL calculator (gas cost USD conversion, optional unrealized PNL)
 *   - CSV exporter (annotate rows with the USD value at the time of each tx)
 *   - Orchestrator (final report's "spot" column for remaining inventory)
 *
 * Why CoinGecko over Celoscan-derived price heuristics:
 *   - Celo Mento stablecoins (cUSD, cEUR, cREAL) trade tightly to USD/EUR/BRL,
 *     but the on-chain Mento broker price is not always queryable per-block.
 *   - Gas is paid in CELO; we need a CELO spot for gas-USD math, and CoinGecko's
 *     `/coins/celo/history` is the cheapest reliable source.
 *   - CoinGecko Pro allows ~500 calls/min with an API key; free tier is
 *     ~10–30 calls/min. The batch helper below collapses year-long ranges
 *     into one call per symbol to stay well within both limits.
 *
 * API notes:
 *   - Free:  `https://api.coingecko.com/api/v3/...`
 *   - Pro:   `https://pro-api.coingecko.com/api/v3/...`  (header `x-cg-pro-api-key`)
 *   - Historical: GET /coins/{id}/history?date=DD-MM-YYYY
 *   - Market range: GET /coins/{id}/market_chart/range?vs_currency=usd&from=ts&to=ts
 *
 * Idiosyncrasy: the "history" endpoint returns a single daily snapshot, not
 * intraday. For most tax work that's fine (we bucket by day), but gas-cost
 * accuracy can drift by a few percent on high-volatility days. We surface
 * the `staleByHours` field on the response so the caller can decide.
 */

import { z } from 'zod';
import { CoinGeckoError } from '../errors.js';
import { httpFetch } from '../http.js';
import type { Timestamp } from '../types.js';

// ─── Public surface ─────────────────────────────────────────────────────────

/** Map Celo-side token symbols → CoinGecko coin IDs. The free API keys off IDs. */
export const COINGECKO_ID_BY_SYMBOL: Record<string, string> = {
  CELO: 'celo',
  cUSD: 'celo-dollar', // Celo Dollar
  cEUR: 'celo-euro',
  cREAL: 'celo-real-creal',
  USDC: 'usd-coin',
  USDT: 'tether',
  G$: 'gooddollar', // GoodDollar
};

export interface PricePoint {
  /** Unix seconds — the actual moment CoinGecko reports the price for. */
  timestamp: Timestamp;
  /** USD per 1 token, decimal. */
  priceUsd: number;
  /**
   * How many hours stale this snapshot is relative to the requested moment.
   * - 0  for market_chart (intraday bucket)
   * - 0–12 for "history" (the day-bucket is centered at 00:00 UTC)
   * Used so the orchestrator can warn on stale prices (e.g. on volatile days).
   */
  staleByHours: number;
}

export interface CoinGeckoOracleOptions {
  /**
   * Override the base URL. Defaults to the free endpoint; pass the Pro URL
   * when `apiKey` is set.
   */
  baseUrl?: string;
  /** Pro API key; if set, the client sends `x-cg-pro-api-key`. */
  apiKey?: string;
  /**
   * Override the fetch implementation (used by tests to stub responses).
   * Must match the signature of `httpFetch`.
   */
  fetcher?: typeof httpFetch;
}

// ─── Zod schemas for response validation ───────────────────────────────────

const MarketChartSchema = z.object({
  prices: z.array(z.tuple([z.number(), z.number()])),
});

const CoinHistorySchema = z.object({
  market_data: z
    .object({
      current_price: z
        .object({
          usd: z.number().nonnegative().optional(),
        })
        .optional(),
    })
    .optional(),
});

// ─── Client ─────────────────────────────────────────────────────────────────

export class CoinGeckoOracle {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetcher: typeof httpFetch;
  /**
   * In-memory cache: `key = `${symbol}:${requestedTs}:${resolution}`` → price.
   * Reset on process exit; the orchestrator can wrap this with a disk cache
   * later if cold-start latency matters.
   */
  private readonly cache = new Map<string, PricePoint>();

  constructor(options: CoinGeckoOracleOptions = {}) {
    this.apiKey = options.apiKey ?? '';
    this.baseUrl =
      options.baseUrl ??
      (this.apiKey ? 'https://pro-api.coingecko.com/api/v3' : 'https://api.coingecko.com/api/v3');
    this.fetcher = options.fetcher ?? httpFetch;
  }

  /**
   * Look up the USD price for `symbol` at (or near) `timestamp`.
   *
   * Strategy: prefer the "history" endpoint (single snapshot, lowest rate-limit
   * cost) and fall back to the nearest intraday point on the market_chart
   * endpoint when "history" returns no data. Callers should not depend on
   * either path being hit; both yield the same `PricePoint` shape.
   */
  async getHistoricalPrice(symbol: string, timestamp: Timestamp): Promise<PricePoint | null> {
    const id = COINGECKO_ID_BY_SYMBOL[symbol];
    if (!id) {
      // Unknown symbol — return null so the caller records a price gap.
      return null;
    }
    const cacheKey = `${symbol}:${timestamp}:history`;
    const cached = this.cache.get(cacheKey);
    if (cached) return cached;

    const date = formatDate(timestamp);
    const url = `${this.baseUrl}/coins/${id}/history?date=${date}&localization=false`;
    const headers = this.apiKey ? { 'x-cg-pro-api-key': this.apiKey } : {};

    let res;
    try {
      res = await this.fetcher<unknown>(url, { headers });
    } catch (err) {
      // History endpoint 404s on dates before the token's listing. Fall through
      // to market_chart, which has wider coverage.
      const fallback = await this.getMarketChartNearest(id, timestamp);
      if (fallback) this.cache.set(cacheKey, fallback);
      return fallback;
    }

    const parsed = CoinHistorySchema.safeParse(res.data);
    if (!parsed.success) {
      throw new CoinGeckoError(
        `CoinGecko /history returned an unexpected shape for ${symbol}@${date}`,
        parsed.error,
      );
    }
    const usd = parsed.data.market_data?.current_price?.usd;
    if (usd === undefined) {
      return this.getMarketChartNearest(id, timestamp);
    }
    const point: PricePoint = {
      timestamp: dateToUtcMidnight(date),
      priceUsd: usd,
      staleByHours: hoursStale(timestamp, dateToUtcMidnight(date)),
    };
    this.cache.set(cacheKey, point);
    return point;
  }

  /**
   * Batch helper: fetch prices for many (symbol, timestamp) pairs with a
   * single API call per symbol by querying the union timestamp range and
   * snapping each request to the nearest returned point. Cuts CoinGecko
   * usage by ~10× for a year of txs.
   */
  async batchHistoricalPrices(
    requests: { symbol: string; timestamp: Timestamp }[],
  ): Promise<Map<string, PricePoint | null>> {
    const out = new Map<string, PricePoint | null>();
    if (requests.length === 0) return out;

    // Group by symbol.
    const bySymbol = new Map<string, Timestamp[]>();
    for (const r of requests) {
      const arr = bySymbol.get(r.symbol) ?? [];
      arr.push(r.timestamp);
      bySymbol.set(r.symbol, arr);
    }

    // For each symbol, issue one market_chart call covering the full range.
    await Promise.all(
      Array.from(bySymbol.entries()).map(async ([symbol, timestamps]) => {
        const id = COINGECKO_ID_BY_SYMBOL[symbol];
        if (!id) {
          for (const ts of timestamps) out.set(`${symbol}:${ts}`, null);
          return;
        }
        const from = Math.min(...timestamps);
        const to = Math.max(...timestamps);
        const points = await this.fetchMarketChartRange(id, from, to);
        for (const ts of timestamps) {
          const nearest = nearestPoint(points, ts);
          if (nearest) {
            out.set(`${symbol}:${ts}`, nearest);
            this.cache.set(`${symbol}:${ts}:history`, nearest);
          } else {
            out.set(`${symbol}:${ts}`, null);
          }
        }
      }),
    );
    return out;
  }

  /**
   * Spot price for a symbol right now. Used by the orchestrator for the
   * final "unrealized PNL" column.
   */
  async getSpotPrice(symbol: string): Promise<PricePoint | null> {
    const id = COINGECKO_ID_BY_SYMBOL[symbol];
    if (!id) return null;
    const now = Math.floor(Date.now() / 1000);
    const url = `${this.baseUrl}/simple/price?ids=${id}&vs_currencies=usd`;
    const headers = this.apiKey ? { 'x-cg-pro-api-key': this.apiKey } : {};

    type SimplePrice = Record<string, { usd?: number }>;
    const res = await this.fetcher<SimplePrice>(url, { headers });
    const usd = res.data[id]?.usd;
    if (usd === undefined) return null;
    return { timestamp: now, priceUsd: usd, staleByHours: 0 };
  }

  // ─── Internals ───────────────────────────────────────────────────────────

  private async getMarketChartNearest(
    id: string,
    timestamp: Timestamp,
  ): Promise<PricePoint | null> {
    const points = await this.fetchMarketChartRange(id, timestamp - 86_400, timestamp + 86_400);
    return nearestPoint(points, timestamp);
  }

  private async fetchMarketChartRange(
    id: string,
    from: Timestamp,
    to: Timestamp,
  ): Promise<PricePoint[]> {
    const url =
      `${this.baseUrl}/coins/${id}/market_chart/range` +
      `?vs_currency=usd&from=${from}&to=${to}`;
    const headers = this.apiKey ? { 'x-cg-pro-api-key': this.apiKey } : {};
    const res = await this.fetcher<unknown>(url, { headers });
    const parsed = MarketChartSchema.safeParse(res.data);
    if (!parsed.success) {
      throw new CoinGeckoError(
        `CoinGecko /market_chart/range returned an unexpected shape for ${id} (${from}..${to})`,
        parsed.error,
      );
    }
    return parsed.data.prices.map(([tsMs, priceUsd]) => ({
      timestamp: Math.floor(tsMs / 1000),
      priceUsd,
      staleByHours: 0,
    }));
  }
}

// ─── Pure helpers (exported for tests) ──────────────────────────────────────

/** "DD-MM-YYYY" — the format CoinGecko's /history endpoint requires. */
export function formatDate(timestamp: Timestamp): string {
  const d = new Date(timestamp * 1000);
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${dd}-${mm}-${d.getUTCFullYear()}`;
}

/** Convert "DD-MM-YYYY" back to the UTC-midnight Unix timestamp. */
function dateToUtcMidnight(date: string): Timestamp {
  const [dd, mm, yyyy] = date.split('-').map(Number) as [number, number, number];
  return Math.floor(Date.UTC(yyyy, mm - 1, dd) / 1000);
}

/** Hours between a requested timestamp and the snapshot it was rounded to. */
function hoursStale(requested: Timestamp, snapshotAt: Timestamp): number {
  return Math.abs(requested - snapshotAt) / 3600;
}

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
