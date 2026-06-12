/**
 * get_token_price_history — returns historical USD price series for Celo native tokens.
 *
 * Input:
 *   tokens    — array of symbols (default: all 6 native tokens)
 *   fromDate  — YYYY-MM-DD (inclusive, UTC)
 *   toDate    — YYYY-MM-DD (inclusive, UTC)
 *   interval  — 'daily' (default, only supported value)
 *
 * Output:
 *   { fromDate, toDate, interval, series: { [symbol]: [{ date, priceUsd }] }, fetchedAt }
 *
 * Data source: CoinGecko `/coins/{id}/market_chart/range` (1 call per token).
 */

import { z } from 'zod';

import { COINGECKO_IDS, fetchCoinGeckoMarketChart } from '../lib/coingecko.js';

// ─── Constants ─────────────────────────────────────────────────────────────────

const NATIVE_TOKEN_SYMBOLS = ['CELO', 'cUSD', 'cEUR', 'cREAL', 'USDC', 'USDT'] as const;

const MAX_RANGE_DAYS = 365;

// ─── Input schema ─────────────────────────────────────────────────────────────

const InputSchema = z.object({
  tokens: z
    .array(z.enum(NATIVE_TOKEN_SYMBOLS))
    .optional()
    .default([...NATIVE_TOKEN_SYMBOLS]),
  fromDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD')
    .describe('Start date YYYY-MM-DD (inclusive, UTC)'),
  toDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD')
    .describe('End date YYYY-MM-DD (inclusive, UTC)'),
  interval: z.enum(['daily']).default('daily').describe('Price granularity (daily only)'),
});

type Input = z.infer<typeof InputSchema>;

// ─── Date helpers ──────────────────────────────────────────────────────────────

/** Parse a YYYY-MM-DD date string as UTC midnight. */
function parseDate(s: string): Date {
  return new Date(s + 'T00:00:00Z');
}

/** Format a Date as YYYY-MM-DD in UTC. */
function formatDate(d: Date): string {
  return d.toISOString().split('T')[0]!;
}

/** Add N days to a Date (UTC-based). */
function addDays(d: Date, n: number): Date {
  const result = new Date(d);
  result.setUTCDate(result.getUTCDate() + n);
  return result;
}

// ─── Main tool handler ─────────────────────────────────────────────────────────

export async function getTokenPriceHistory(
  rawArgs: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const parsed = InputSchema.safeParse(rawArgs);
  if (!parsed.success) {
    return {
      error: 'INVALID_INPUT',
      message: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    };
  }

  const { tokens, fromDate, toDate } = parsed.data;

  const from = parseDate(fromDate);
  const to = parseDate(toDate);

  // Validate fromDate <= toDate
  if (from > to) {
    return {
      error: 'INVALID_INPUT',
      message: `fromDate (${fromDate}) must be before or equal to toDate (${toDate})`,
    };
  }

  // Validate range <= 365 days (CoinGecko free tier limit)
  const rangeDays = Math.round((to.getTime() - from.getTime()) / (1000 * 60 * 60 * 24));
  if (rangeDays > MAX_RANGE_DAYS) {
    return {
      error: 'INVALID_INPUT',
      message: `Date range (${rangeDays} days) exceeds CoinGecko free-tier maximum of ${MAX_RANGE_DAYS} days.`,
    };
  }

  const apiKey = process.env.COINGECKO_API_KEY ?? '';

  // ── Fetch per token ────────────────────────────────────────────────────────

  type PricePoint = { date: string; priceUsd: number | null };

  const series: Record<string, PricePoint[]> = {};
  const gaps: { token: string; reason: string }[] = [];

  for (const symbol of tokens) {
    const coinId = COINGECKO_IDS[symbol];
    if (!coinId) {
      gaps.push({ token: symbol, reason: 'Unknown token symbol' });
      series[symbol] = [];
      continue;
    }

    const fromUnix = Math.floor(from.getTime() / 1000);
    const toUnix = Math.floor(to.getTime() / 1000);

    let marketData: { prices: [number, number][] };
    try {
      marketData = await fetchCoinGeckoMarketChart(coinId, fromUnix, toUnix, apiKey);
    } catch (err) {
      gaps.push({ token: symbol, reason: `Fetch error: ${err instanceof Error ? err.message : String(err)}` });
      series[symbol] = [];
      continue;
    }

    // Build a map of date → price for the data points returned
    const priceByDate = new Map<string, number>();
    for (const [unixMs, price] of marketData.prices) {
      priceByDate.set(formatDate(new Date(unixMs)), price);
    }

    // Walk every calendar day in range; emit null for missing days
    const points: PricePoint[] = [];
    let cursor = addDays(from, 0);
    while (cursor <= to) {
      const dateStr = formatDate(cursor);
      points.push({ date: dateStr, priceUsd: priceByDate.get(dateStr) ?? null });
      cursor = addDays(cursor, 1);
    }

    series[symbol] = points;
  }

  return {
    fromDate,
    toDate,
    interval: 'daily',
    series,
    ...(gaps.length > 0 && { gaps }),
    fetchedAt: new Date().toISOString(),
  };
}

// ─── Tool export ───────────────────────────────────────────────────────────────

export const getTokenPriceHistoryTool = {
  name: 'get_token_price_history',
  description:
    'Returns historical USD price series for Celo native tokens (CELO, cUSD, cEUR, cREAL, USDC, USDT) over a date range. Uses CoinGecko market_chart/range endpoint (1 API call per token). Gaps in data are returned as null prices.',
  inputSchema: InputSchema,
  handler: getTokenPriceHistory,
};
