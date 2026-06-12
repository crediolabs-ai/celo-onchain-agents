/**
 * generate_tax_report — composes a full tax report for a Celo wallet + tax year
 * in the requested jurisdiction CSV format.
 *
 * Pipeline: calls calculateTaxLiability() for summary + taxDue →
 * re-runs the pipeline to get classified txs + disposals → builds CSV via
 * jurisdiction schema → returns report (json/csv/both) or writes to outputFile.
 *
 * Composes Tool 2 (calculate_tax_liability) — reuses its logic directly.
 */

import { z } from 'zod';
import { calculateTaxLiability } from './calculate-tax-liability.js';
import { COINGECKO_IDS, fetchCoinGeckoMarketChart } from '../lib/coingecko.js';
import { classifyAndComputeTax, DEFAULT_DECIMALS } from '../lib/pipeline-core.js';
import type { ClassifiedTx, Disposal } from '../lib/pipeline-core.js';
import { fetchWithRetry, sleep } from '../lib/http.js';
import {
  buildNigeriaFirsRows, renderNigeriaFirsCsv,
} from '../lib/csv-schemas/nigeria-firs.js';
import {
  buildKenyaKraRows, renderKenyaKraCsv,
} from '../lib/csv-schemas/kenya-kra.js';
import {
  buildOecdCarfRows, renderOecdCarfCsv,
} from '../lib/csv-schemas/oecd-carf.js';

// ─── Schema ───────────────────────────────────────────────────────────────────

const InputSchema = z.object({
  address:      z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  network:      z.enum(['mainnet','alfajores']).default('mainnet'),
  taxYear:      z.number().int().min(2020).max(2030),
  jurisdiction: z.enum(['NG','KE','OTHER']).default('NG'),
  method:       z.enum(['FIFO','LIFO','WAC']).default('FIFO'),
  outputFormat: z.enum(['json','csv','both']).default('both'),
  outputFile:   z.string().optional(),
});

type Input = z.infer<typeof InputSchema>;

// ─── Celoscan fetch helpers (duplicated from calculate-tax-liability.ts) ────────

const CHAIN_IDS = { mainnet: 42220, alfajores: 44787 };
const PAGE_SIZE = 100;

async function fetchCeloscanPage(
  address: string, network: 'mainnet'|'alfajores', action: string, page = 1,
): Promise<unknown[]> {
  const apiUrl = process.env.CELOSCAN_API_URL ?? 'https://api.etherscan.io/v2/api';
  const apiKey = process.env.CELOSCAN_API_KEY ?? '';
  const params = new URLSearchParams({
    module: 'account', action, address,
    startblock: '0', endblock: '99999999',
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
): Promise<unknown[]> {
  const all: unknown[] = [];
  for (let page = 1; page <= 10; page++) {
    const batch = await fetchCeloscanPage(address, network, action, page);
    all.push(...batch);
    if (batch.length < PAGE_SIZE) break;
    await sleep(110);
  }
  return all;
}

// ─── Price lookup ─────────────────────────────────────────────────────────────

async function buildPriceLookup(
  symbols: string[], txs: { timestamp: number }[],
): Promise<Record<string, Record<string, number>>> {
  const apiKey = process.env.COINGECKO_API_KEY ?? '';
  const result: Record<string, Record<string, number>> = {};
  if (!txs.length) return result;

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
    } catch { /* prices remain 0 */ }
    await sleep(110);
  }
  return result;
}

// ─── Normalizers ─────────────────────────────────────────────────────────────

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

// ─── Pipeline result (re-runs the pipeline to get classified + disposals) ───────

interface PipelineResult {
  classified: ClassifiedTx[];
  disposals: Disposal[];
  priceGaps: { asset: string; timestamp: number }[];
}

async function runPipeline(
  address: string, network: 'mainnet'|'alfajores',
  taxYear: number, jurisdiction: string, method: string,
): Promise<PipelineResult> {
  const [rawNormalTxs, rawTokenTxs] = await Promise.all([
    fetchAllTxs(address, network, 'txlist'),
    fetchAllTxs(address, network, 'tokentx'),
  ]);

  const yearStart = new Date(taxYear, 0, 1).getTime() / 1000;
  const yearEnd   = new Date(taxYear, 11, 31, 23, 59, 59).getTime() / 1000;

  const yearTxs = (rawNormalTxs as Record<string, string>[])
    .map(normTx).filter(tx => tx.timestamp >= yearStart && tx.timestamp <= yearEnd);
  const yearTransfers = (rawTokenTxs as Record<string, string>[])
    .map(normTransfer).filter(t => t.timestamp >= yearStart && t.timestamp <= yearEnd);

  const allSymbols = ['CELO', ...new Set(yearTransfers.map(t => t.tokenSymbol))];
  const priceLookup = await buildPriceLookup(allSymbols, yearTxs);

  const pipeline = classifyAndComputeTax(
    yearTxs, yearTransfers, [], address, taxYear,
    jurisdiction as 'NG'|'KE'|'OTHER',
    method as 'FIFO'|'LIFO'|'WAC',
    priceLookup,
  );

  // classifyAndComputeTax returns classified + disposals at runtime but the TS
  // interface only exposes the summary fields — cast through any to access them.
  const rt = pipeline as unknown as {
    classified: ClassifiedTx[];
    disposals: Disposal[];
    priceGaps: { asset: string; timestamp: number }[];
  };

  return { classified: rt.classified, disposals: rt.disposals, priceGaps: rt.priceGaps };
}

// ─── CSV builders ─────────────────────────────────────────────────────────────

function buildCsvRows(
  classified: ClassifiedTx[], disposals: Disposal[],
  jurisdiction: string, taxYear: number,
): string {
  switch (jurisdiction) {
    case 'NG':
      return renderNigeriaFirsCsv(buildNigeriaFirsRows(classified, disposals, taxYear));
    case 'KE':
      return renderKenyaKraCsv(buildKenyaKraRows(classified));
    case 'OTHER':
    default:
      return renderOecdCarfCsv(buildOecdCarfRows(classified, disposals, taxYear));
  }
}

function schemaName(j: string): string {
  return j === 'NG' ? 'nigeria-firs' : j === 'KE' ? 'kenya-kra' : 'oecd-carf';
}

function reportFilename(address: string, taxYear: number, j: string): string {
  const s = address.slice(0, 6) + '…' + address.slice(-4);
  return `agent-06-${taxYear}-${schemaName(j)}-${s}.csv`.toLowerCase();
}

// ─── Main ─────────────────────────────────────────────────────────────────────

const DISCLAIMER =
  'This report is generated by an automated system. Verify with a qualified tax professional before filing.';

export async function generateTaxReport(
  rawArgs: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const parsed = InputSchema.safeParse(rawArgs);
  if (!parsed.success) {
    return {
      error: 'INVALID_INPUT',
      message: parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; '),
    };
  }

  const { address, network, taxYear, jurisdiction, method, outputFormat, outputFile } =
    parsed.data as Input;

  // Delegate tax computation to calculate_tax_liability (Tool 2)
  const taxResult = await calculateTaxLiability({
    address, network, taxYear, jurisdiction, method,
  });

  if ('error' in taxResult) return taxResult;

  // Re-run pipeline to get classified txs + disposals for CSV generation
  const { classified, disposals, priceGaps } = await runPipeline(
    address, network, taxYear, jurisdiction, method,
  );

  const csv       = buildCsvRows(classified, disposals, jurisdiction, taxYear);
  const csvBase64 = Buffer.from(csv, 'utf-8').toString('base64');

  const response: Record<string, unknown> = {
    address,
    taxYear,
    jurisdiction,
    method,
    schema: schemaName(jurisdiction),
    filename: reportFilename(address, taxYear, jurisdiction),
    rowCount: disposals.length,
    summary: {
      realizedGainsUsd:    (taxResult.summary as Record<string, number>).realizedGainsUsd,
      incomeUsd:          (taxResult.summary as Record<string, number>).incomeUsd,
      yieldUsd:           (taxResult.summary as Record<string, number>).yieldUsd,
      deductibleGasUsd:   (taxResult.summary as Record<string, number>).deductibleGasUsd,
      taxableIncomeUsd:   (taxResult.summary as Record<string, number>).taxableIncomeUsd,
    },
    taxDue:    taxResult.taxDue,
    priceGaps,
    disclaimer: DISCLAIMER,
    computedAt: new Date().toISOString(),
  };

  if (outputFormat === 'csv' || outputFormat === 'both') {
    if (outputFile) {
      const { writeFileSync } = await import('fs');
      writeFileSync(outputFile, csv, 'utf-8');
      response.csvFile = outputFile;
      response.report = `Report written to ${outputFile}`;
    } else {
      response.csv       = csv;
      response.csvBase64 = csvBase64;
    }
  }

  if (outputFormat === 'json' || outputFormat === 'both') {
    response.report = JSON.stringify(taxResult, null, 2);
  }

  return response;
}
