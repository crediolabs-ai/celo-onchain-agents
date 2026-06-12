/**
 * calculate_tax_liability — computes realized capital gains, income, yield, and tax owed
 * for a Celo wallet over a tax year in the given jurisdiction.
 *
 * Pipeline: fetch (Celoscan paginated) → classify (rule-only) → price (CoinGecko) → FIFO PNL → tax rules.
 */

import { z } from 'zod';
import { fetchWithRetry, sleep } from '../lib/http.js';
import { COINGECKO_IDS, fetchCoinGeckoMarketChart } from '../lib/coingecko.js';
import { classifyAndComputeTax, DEFAULT_DECIMALS } from '../lib/pipeline-core.js';

// ─── Schema ──────────────────────────────────────────────────────────────────

const InputSchema = z.object({
  address: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  network: z.enum(['mainnet','alfajores']).default('mainnet'),
  taxYear: z.number().int().min(2020).max(2030),
  jurisdiction: z.enum(['NG','KE','OTHER']).default('NG'),
  method: z.enum(['FIFO','LIFO','WAC']).default('FIFO'),
  fromBlock: z.number().int().nonnegative().optional(),
  toBlock: z.number().int().nonnegative().optional(),
});

// ─── Celoscan paginated fetch ─────────────────────────────────────────────────

const CHAIN_IDS = { mainnet: 42220, alfajores: 44787 };
const PAGE_SIZE = 100;

async function fetchCeloscanPage(
  address: string, network: 'mainnet'|'alfajores', action: string,
  fromBlock?: number, toBlock?: number, page = 1,
): Promise<unknown[]> {
  const apiUrl = process.env.CELOSCAN_API_URL ?? 'https://api.etherscan.io/v2/api';
  const apiKey = process.env.CELOSCAN_API_KEY ?? '';
  const params = new URLSearchParams({
    module: 'account', action, address,
    startblock: String(fromBlock ?? 0), endblock: String(toBlock ?? 99_999_999),
    page: String(page), offset: String(PAGE_SIZE), sort: 'asc',
    chainid: String(CHAIN_IDS[network]),
  });
  if (apiKey) params.set('apikey', apiKey);
  const raw = await fetchWithRetry<{ status: string; message: string; result: unknown[] }>(
    `${apiUrl}?${params}`, {},
  );
  if (raw.status === '0' && raw.message !== 'No transactions found') return [];
  return raw.result ?? [];
}

async function fetchAllTxs(
  address: string, network: 'mainnet'|'alfajores', action: string,
  fromBlock?: number, toBlock?: number,
): Promise<unknown[]> {
  const all: unknown[] = [];
  for (let page = 1; page <= 10; page++) {
    const batch = await fetchCeloscanPage(address, network, action, fromBlock, toBlock, page);
    all.push(...batch);
    if (batch.length < PAGE_SIZE) break;
    await sleep(110);
  }
  return all;
}

// ─── Price lookup ─────────────────────────────────────────────────────────────

async function buildPriceLookup(
  symbols: string[], txs: { timestamp: number }[], network: 'mainnet'|'alfajores',
): Promise<Record<string, Record<string, number>>> {
  const apiKey = process.env.COINGECKO_API_KEY ?? '';
  const result: Record<string, Record<string, number>> = {};
  if (!txs.length) return result;

  // Simple range: min date -1 day to max date +1 day per symbol
  const timestamps = txs.map(t => t.timestamp).sort((a, b) => a - b);
  const minTs = timestamps[0]! - 86400;
  const maxTs = timestamps[timestamps.length - 1]! + 86400;

  for (const sym of symbols) {
    const coinId = COINGECKO_IDS[sym];
    if (!coinId) continue;
    try {
      const chart = await fetchCoinGeckoMarketChart(coinId, minTs, maxTs, apiKey);
      result[sym] = {};
      for (const [unixMs, price] of chart.prices) {
        result[sym][new Date(unixMs).toISOString().split('T')[0]!] = price;
      }
    } catch { /* CoinGecko failure — prices remain 0 */ }
    await sleep(110);
  }
  return result;
}

// ─── Normalizers ──────────────────────────────────────────────────────────────

function normTx(tx: Record<string, string>) {
  return {
    hash: tx.hash as `0x${string}`, blockNumber: parseInt(tx.blockNumber, 10),
    timestamp: parseInt(tx.timestamp, 10), from: tx.from as `0x${string}`,
    to: (tx.to ?? null) as `0x${string}` | null, value: tx.value,
    gasUsed: '0', gasPrice: '0', input: tx.input ?? '0x',
    methodName: tx.methodName, isError: tx.isError as '0'|'1',
  };
}

function normTransfer(tx: Record<string, string>) {
  return {
    hash: tx.hash as `0x${string}`, blockNumber: parseInt(tx.blockNumber, 10),
    timestamp: parseInt(tx.timestamp, 10),
    from: tx.from as `0x${string}`, to: tx.to as `0x${string}`,
    contractAddress: tx.contractAddress as `0x${string}`,
    tokenSymbol: tx.tokenSymbol, tokenDecimals: 18, value: tx.value,
  };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export async function calculateTaxLiability(
  rawArgs: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const parsed = InputSchema.safeParse(rawArgs);
  if (!parsed.success) {
    return { error: 'INVALID_INPUT',
      message: parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ') };
  }
  const { address, network, taxYear, jurisdiction, method, fromBlock, toBlock } = parsed.data;

  const [rawNormalTxs, rawTokenTxs] = await Promise.all([
    fetchAllTxs(address, network, 'txlist', fromBlock, toBlock),
    fetchAllTxs(address, network, 'tokentx', fromBlock, toBlock),
  ]);

  const yearStart = new Date(taxYear, 0, 1).getTime() / 1000;
  const yearEnd = new Date(taxYear, 11, 31, 23, 59, 59).getTime() / 1000;

  const yearTxs = (rawNormalTxs as Record<string, string>[])
    .map(normTx).filter(tx => tx.timestamp >= yearStart && tx.timestamp <= yearEnd);
  const yearTransfers = (rawTokenTxs as Record<string, string>[])
    .map(normTransfer).filter(t => t.timestamp >= yearStart && t.timestamp <= yearEnd);

  const allSymbols = ['CELO', ...new Set(yearTransfers.map(t => t.tokenSymbol))];
  const priceLookup = await buildPriceLookup(allSymbols, yearTxs, network);
  const result = classifyAndComputeTax(yearTxs, yearTransfers, [], address, taxYear, jurisdiction, method, priceLookup);

  const summary = {
    realizedGainsUsd: result.breakdown.realizedGainsUsd,
    incomeUsd: result.breakdown.incomeUsd,
    yieldUsd: result.breakdown.yieldUsd,
    deductibleGasUsd: result.breakdown.deductibleGasUsd,
    taxableIncomeUsd: result.breakdown.taxableIncomeUsd,
  };

  return {
    address, network, taxYear, jurisdiction, method, summary,
    taxDue: result.taxDue,
    taxYearSummary: { year: taxYear, realizedGains: result.breakdown.realizedGainsUsd,
      income: result.breakdown.incomeUsd, yield: result.breakdown.yieldUsd,
      deductibleGas: result.breakdown.deductibleGasUsd, taxableIncome: result.breakdown.taxableIncomeUsd },
    methodJurisdictionCompat: result.methodJurisdictionCompat,
    priceGaps: result.priceGaps, disposalsCount: result.disposalsCount,
    computedAt: new Date().toISOString(),
  };
}
