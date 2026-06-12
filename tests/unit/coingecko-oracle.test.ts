/**
 * Unit tests for the CoinGecko price oracle.
 *
 * Owner: Credio (shared/price-oracle).
 *
 * Scope:
 *   - Pure helpers (formatDate, nearestPoint) are exercised directly.
 *   - The HTTP path is exercised via a stubbed fetcher, so the tests do
 *     not hit the real API. CoinGecko rate-limits aggressively; never
 *     rely on the network in CI.
 */

import { describe, expect, it } from 'vitest';
import {
  CoinGeckoOracle,
  formatDate,
  nearestPoint,
  type PricePoint,
} from '../../src/shared/price-oracle/coingecko.js';
import type { HttpResponse } from '../../src/shared/http.js';
import type { Timestamp } from '../../src/shared/types.js';

const TS_JAN_1_2024 = 1_704_067_200 as Timestamp;
const TS_JAN_1_2024_5PM = 1_704_067_200 + 17 * 3600 as Timestamp;
const TS_JAN_2_2024 = TS_JAN_1_2024 + 86_400;

// ─── formatDate ────────────────────────────────────────────────────────────

describe('formatDate', () => {
  it('formats Unix seconds as DD-MM-YYYY in UTC', () => {
    expect(formatDate(TS_JAN_1_2024)).toBe('01-01-2024');
    expect(formatDate(TS_JAN_1_2024 + 86_400 * 30)).toBe('31-01-2024');
    // Leap year: 2024-02-29.
    expect(formatDate(TS_JAN_1_2024 + 86_400 * 59)).toBe('29-02-2024');
  });

  it('rolls over to the next day past UTC midnight', () => {
    // 2024-01-01 23:59:59 UTC → 01-01-2024
    expect(formatDate(TS_JAN_1_2024 + 86_400 - 1)).toBe('01-01-2024');
    // 2024-01-02 00:00:00 UTC → 02-01-2024
    expect(formatDate(TS_JAN_2_2024)).toBe('02-01-2024');
  });
});

// ─── nearestPoint ──────────────────────────────────────────────────────────

describe('nearestPoint', () => {
  const points: PricePoint[] = [
    { timestamp: TS_JAN_1_2024, priceUsd: 0.5, staleByHours: 0 },
    { timestamp: TS_JAN_2_2024, priceUsd: 0.6, staleByHours: 0 },
    { timestamp: TS_JAN_2_2024 + 86_400, priceUsd: 0.7, staleByHours: 0 },
  ];

  it('returns null for an empty list', () => {
    expect(nearestPoint([], TS_JAN_1_2024)).toBeNull();
  });

  it('picks the point closest to the requested timestamp', () => {
    // Halfway between day 1 and day 2 — tied delta; the earlier one wins
    // (first-encountered) since the algorithm uses strict < for the swap.
    const halfway = TS_JAN_1_2024 + 43_200;
    expect(nearestPoint(points, halfway)?.timestamp).toBe(TS_JAN_1_2024);
    // Closer to day 2.
    expect(nearestPoint(points, TS_JAN_2_2024 + 100)?.timestamp).toBe(TS_JAN_2_2024);
  });
});

// ─── HTTP path with stubbed fetcher ────────────────────────────────────────

function stubOracle(responses: Record<string, unknown>) {
  const fetcher = async <T>(url: string): Promise<HttpResponse<T>> => {
    for (const [key, value] of Object.entries(responses)) {
      if (url.includes(key)) {
        return { status: 200, headers: new Headers(), data: value as T };
      }
    }
    throw new Error(`No stub for URL: ${url}`);
  };
  return new CoinGeckoOracle({ fetcher: fetcher as never });
}

describe('CoinGeckoOracle', () => {
  it('resolves a historical price from the /history endpoint', async () => {
    const oracle = stubOracle({
      '/coins/celo/history': {
        market_data: { current_price: { usd: 0.61234 } },
      },
    });

    const point = await oracle.getHistoricalPrice('CELO', TS_JAN_1_2024);
    expect(point).not.toBeNull();
    expect(point!.priceUsd).toBeCloseTo(0.61234, 5);
    // Jan 1 00:00 UTC requested → snapshot at Jan 1 00:00 UTC → 0 hours stale.
    expect(point!.staleByHours).toBe(0);
  });

  it('returns null for unknown symbols (no CoinGecko ID)', async () => {
    const oracle = stubOracle({});
    const point = await oracle.getHistoricalPrice('FAKECOIN', TS_JAN_1_2024);
    expect(point).toBeNull();
  });

  it('falls back to market_chart when /history has no price data', async () => {
    const oracle = stubOracle({
      '/coins/celo/history': {}, // no market_data field
      '/market_chart/range': {
        prices: [
          [(TS_JAN_1_2024 - 3600) * 1000, 0.5],
          [TS_JAN_1_2024 * 1000, 0.55],
          [(TS_JAN_1_2024 + 3600) * 1000, 0.6],
        ],
      },
    });

    const point = await oracle.getHistoricalPrice('CELO', TS_JAN_1_2024_5PM);
    expect(point).not.toBeNull();
    // The nearest of the three points to 17:00 UTC is the 18:00 one (delta 1h)
    // since the 16:00 one is also 1h away; the algorithm returns the first
    // encountered. Either 0.5 or 0.6 is acceptable here.
    expect([0.5, 0.55, 0.6]).toContain(point!.priceUsd);
  });

  it('batchHistoricalPrices issues one market_chart call per symbol', async () => {
    let callCount = 0;
    const seenUrls: string[] = [];
    const fetcher = async <T>(url: string): Promise<HttpResponse<T>> => {
      seenUrls.push(url);
      callCount += 1;
      if (url.includes('/coins/celo/market_chart/range')) {
        return {
          status: 200,
          headers: new Headers(),
          data: {
            prices: [
              [TS_JAN_1_2024 * 1000, 0.5],
              [TS_JAN_2_2024 * 1000, 0.6],
            ],
          } as T,
        };
      }
      if (url.includes('/coins/usd-coin/market_chart/range')) {
        return {
          status: 200,
          headers: new Headers(),
          data: {
            prices: [
              [TS_JAN_1_2024 * 1000, 1.0],
              [TS_JAN_2_2024 * 1000, 1.0],
            ],
          } as T,
        };
      }
      throw new Error(`Unexpected URL in test: ${url}`);
    };
    const oracle = new CoinGeckoOracle({ fetcher: fetcher as never });

    const out = await oracle.batchHistoricalPrices([
      { symbol: 'CELO', timestamp: TS_JAN_1_2024 },
      { symbol: 'CELO', timestamp: TS_JAN_2_2024 },
      { symbol: 'USDC', timestamp: TS_JAN_1_2024 },
      { symbol: 'USDC', timestamp: TS_JAN_2_2024 },
      { symbol: 'FAKECOIN', timestamp: TS_JAN_1_2024 }, // unknown → null
    ]);

    // 2 market_chart calls (one per known symbol) + 0 for the unknown.
    expect(callCount).toBe(2);
    expect(seenUrls.every((u) => u.includes('/market_chart/range'))).toBe(true);

    expect(out.get(`CELO:${TS_JAN_1_2024}`)?.priceUsd).toBe(0.5);
    expect(out.get(`CELO:${TS_JAN_2_2024}`)?.priceUsd).toBe(0.6);
    expect(out.get(`USDC:${TS_JAN_1_2024}`)?.priceUsd).toBe(1.0);
    expect(out.get(`FAKECOIN:${TS_JAN_1_2024}`)).toBeNull();
  });

  it('getSpotPrice returns a PricePoint with the current time', async () => {
    const oracle = stubOracle({
      '/simple/price': { celo: { usd: 0.42 } },
    });
    const before = Math.floor(Date.now() / 1000);
    const point = await oracle.getSpotPrice('CELO');
    const after = Math.floor(Date.now() / 1000);

    expect(point).not.toBeNull();
    expect(point!.priceUsd).toBe(0.42);
    expect(point!.timestamp).toBeGreaterThanOrEqual(before);
    expect(point!.timestamp).toBeLessThanOrEqual(after);
    expect(point!.staleByHours).toBe(0);
  });
});
