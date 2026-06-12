/**
 * Unit tests for the DefiLlama price oracle.
 *
 * Owner: Credio (shared/price-oracle).
 *
 * Scope:
 *   - Pure helper (`nearestPoint`) is exercised directly.
 *   - The HTTP path is exercised via a stubbed fetcher, so the tests do
 *     not hit the real API. DefiLlama has no documented rate limit, but
 *     we still stub the network to keep CI deterministic.
 */

import { describe, expect, it } from 'vitest';
import {
  DefiLlamaOracle,
  nearestPoint,
  type PricePoint,
} from '../../src/shared/price-oracle/defillama.js';
import type { HttpResponse } from '../../src/shared/http.js';
import type { Timestamp } from '../../src/shared/types.js';

const TS_JAN_1_2024 = 1_704_067_200 as Timestamp;
const TS_JAN_2_2024 = TS_JAN_1_2024 + 86_400;

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
  return new DefiLlamaOracle({ fetcher: fetcher as never });
}

describe('DefiLlamaOracle', () => {
  it('resolves a historical price from the /prices/historical endpoint', async () => {
    const oracle = stubOracle({
      '/prices/historical/1704067200/coingecko:celo': {
        coins: {
          'coingecko:celo': {
            price: 0.61234,
            symbol: 'CELO',
            timestamp: TS_JAN_1_2024,
            confidence: 0.99,
          },
        },
      },
    });

    const point = await oracle.getHistoricalPrice('CELO', TS_JAN_1_2024);
    expect(point).not.toBeNull();
    expect(point!.priceUsd).toBeCloseTo(0.61234, 5);
    expect(point!.staleByHours).toBe(0);
  });

  it('returns null for unknown symbols (no DefiLlama ID)', async () => {
    const oracle = stubOracle({});
    const point = await oracle.getHistoricalPrice('FAKECOIN', TS_JAN_1_2024);
    expect(point).toBeNull();
  });

  it('returns null when DefiLlama has no data for the requested coin', async () => {
    const oracle = stubOracle({
      '/prices/historical/': { coins: {} }, // empty coins object
    });
    const point = await oracle.getHistoricalPrice('CELO', TS_JAN_1_2024);
    expect(point).toBeNull();
  });

  it('computes staleByHours from the timestamp gap', async () => {
    // DefiLlama returns a point 30 min after the requested time.
    const oracle = stubOracle({
      '/prices/historical/': {
        coins: {
          'coingecko:celo': {
            price: 0.6,
            symbol: 'CELO',
            timestamp: TS_JAN_1_2024 + 1800, // 30 min later
            confidence: 0.99,
          },
        },
      },
    });
    const point = await oracle.getHistoricalPrice('CELO', TS_JAN_1_2024);
    expect(point!.staleByHours).toBeCloseTo(0.5, 5);
  });

  it('batchHistoricalPrices issues one call per (symbol, timestamp) pair', async () => {
    const seenUrls: string[] = [];
    const fetcher = async <T>(url: string): Promise<HttpResponse<T>> => {
      seenUrls.push(url);
      // Return a stub for any /prices/historical URL.
      const match = url.match(/\/prices\/historical\/(\d+)\/coingecko:([\w-]+)/);
      if (match) {
        return {
          status: 200,
          headers: new Headers(),
          data: {
            coins: {
              [`coingecko:${match[2]}`]: {
                price: 1.0,
                symbol: match[2]!.toUpperCase(),
                timestamp: Number(match[1]),
                confidence: 0.99,
              },
            },
          } as T,
        };
      }
      throw new Error(`Unexpected URL in test: ${url}`);
    };
    const oracle = new DefiLlamaOracle({ fetcher: fetcher as never });

    const out = await oracle.batchHistoricalPrices([
      { symbol: 'CELO', timestamp: TS_JAN_1_2024 },
      { symbol: 'CELO', timestamp: TS_JAN_2_2024 },
      { symbol: 'USDC', timestamp: TS_JAN_1_2024 },
      { symbol: 'USDC', timestamp: TS_JAN_2_2024 },
      { symbol: 'FAKECOIN', timestamp: TS_JAN_1_2024 }, // unknown → null, no call
    ]);

    // 4 calls (one per known pair). FAKECOIN returns null with zero calls.
    expect(seenUrls).toHaveLength(4);
    expect(seenUrls.every((u) => u.includes('/prices/historical/'))).toBe(true);
    expect(seenUrls.every((u) => u.includes('coingecko:'))).toBe(true);

    expect(out.get(`CELO:${TS_JAN_1_2024}`)?.priceUsd).toBe(1.0);
    expect(out.get(`CELO:${TS_JAN_2_2024}`)?.priceUsd).toBe(1.0);
    expect(out.get(`USDC:${TS_JAN_1_2024}`)?.priceUsd).toBe(1.0);
    expect(out.get(`USDC:${TS_JAN_2_2024}`)?.priceUsd).toBe(1.0);
    expect(out.get(`FAKECOIN:${TS_JAN_1_2024}`)).toBeNull();
  });

  it('getSpotPrice returns a PricePoint with the current time', async () => {
    const oracle = stubOracle({
      '/prices/current/coingecko:celo': {
        coins: {
          'coingecko:celo': {
            price: 0.42,
            symbol: 'CELO',
            timestamp: Math.floor(Date.now() / 1000),
            confidence: 0.99,
          },
        },
      },
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
