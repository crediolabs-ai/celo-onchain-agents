/**
 * Shared CoinGecko API helpers for MCP server tools.
 *
 * Moved from get-celo-portfolio.ts. All 5 Phase C tools need these.
 */

import { fetchWithRetry } from './http.js';

// ─── Token IDs ─────────────────────────────────────────────────────────────────

export const COINGECKO_IDS: Record<string, string> = {
  CELO: 'celo',
  'cUSD': 'celo-dollar',
  'cEUR': 'celo-euro',
  'cREAL': 'celo-real-creal',
  USDC: 'usd-coin',
  USDT: 'tether',
};

// ─── Spot prices ───────────────────────────────────────────────────────────────

/** Fetch CoinGecko spot USD prices for an array of symbols. Returns map of symbol → USD price. */
export async function fetchCoinGeckoPrices(
  symbols: string[],
  apiKey: string,
): Promise<Record<string, number>> {
  const ids = symbols
    .map((s) => COINGECKO_IDS[s])
    .filter((id): id is string => id !== undefined);

  if (ids.length === 0) return {};

  const base = apiKey ? 'https://pro-api.coingecko.com/api/v3' : 'https://api.coingecko.com/api/v3';
  const url = `${base}/simple/price?ids=${ids.join(',')}&vs_currencies=usd`;
  const headers: Record<string, string> = {};
  if (apiKey) headers['x-cg-pro-api-key'] = apiKey;

  try {
    const data = (await fetchWithRetry<Record<string, { usd?: number }>>(url, {
      retries: 3,
      headers,
    })) as Record<string, { usd?: number }>;
    const result: Record<string, number> = {};
    for (const [id, price] of Object.entries(data)) {
      if (price.usd !== undefined) {
        const symbol = Object.entries(COINGECKO_IDS).find(([, v]) => v === id)?.[0];
        if (symbol) result[symbol] = price.usd;
      }
    }
    return result;
  } catch {
    return {};
  }
}

// ─── Price-on-date (for price-history tool) ───────────────────────────────────

/**
 * Fetch the USD price for a single coin on a specific date.
 * Uses CoinGecko's `/coins/{id}/history` endpoint.
 */
export async function fetchCoinGeckoPriceOnDate(
  coinId: string,
  date: Date,
  apiKey: string,
): Promise<number | null> {
  const base = apiKey ? 'https://pro-api.coingecko.com/api/v3' : 'https://api.coingecko.com/api/v3';
  // CoinGecko expects date as DD-MM-YYYY
  const day = String(date.getUTCDate()).padStart(2, '0');
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const year = date.getUTCFullYear();
  const url = `${base}/coins/${coinId}/history?date=${day}-${month}-${year}&localization=false`;
  const headers: Record<string, string> = {};
  if (apiKey) headers['x-cg-pro-api-key'] = apiKey;

  try {
    const data = (await fetchWithRetry<{ market_data?: { current_price?: { usd?: number } } }>(
      url,
      { retries: 3, headers },
    )) as { market_data?: { current_price?: { usd?: number } } };
    return data.market_data?.current_price?.usd ?? null;
  } catch {
    return null;
  }
}

// ─── Market chart (bulk daily prices) ─────────────────────────────────────────

/**
 * Fetch daily USD price series for a coin over a date range.
 * Uses CoinGecko's `/coins/{id}/market_chart/range` endpoint.
 *
 * Returns { prices: [unix_ms, price][] } suitable for transforming into daily OHLC or close.
 */
export async function fetchCoinGeckoMarketChart(
  coinId: string,
  fromUnix: number,
  toUnix: number,
  apiKey: string,
): Promise<{ prices: [number, number][] }> {
  const base = apiKey ? 'https://pro-api.coingecko.com/api/v3' : 'https://api.coingecko.com/api/v3';
  const url =
    `${base}/coins/${coinId}/market_chart/range` +
    `?vs_currency=usd&from=${fromUnix}&to=${toUnix}`;
  const headers: Record<string, string> = {};
  if (apiKey) headers['x-cg-pro-api-key'] = apiKey;

  try {
    const data = (await fetchWithRetry<{ prices?: [number, number][] }>(url, {
      retries: 3,
      headers,
    })) as { prices?: [number, number][] };
    return { prices: data.prices ?? [] };
  } catch {
    return { prices: [] };
  }
}
