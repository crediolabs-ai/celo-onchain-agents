/**
 * PNL calculator — main entrypoint.
 *
 * Owner: Credio (pnl-calculator sub-agent).
 *
 * Public surface: `computePnl(input: PnlInput): Promise<PnlOutput>`.
 *
 * Dispatches to the FIFO / LIFO / WAC engine based on `input.method`.
 * Wraps the engine result in the `PnlOutput` shape consumed by the
 * orchestrator and the CSV exporter.
 *
 * Year-bucketing: each disposal, income event, and yield event is bucketed
 * into the `taxYear` of its timestamp for the `taxYears` summary.
 * `methodJurisdictionCompat` is computed up front so the orchestrator can
 * surface illegal combos (e.g. LIFO + NG) before the engine runs.
 */

import {
  type PnlInput,
  type PnlOutput,
  type ClassifiedTx,
  type CostBasisMethod,
  type Jurisdiction,
  type TaxYearSummary,
  type MethodJurisdictionCompat,
  type Timestamp,
} from '../../shared/types.js';
import { computeFifo, type FifoInput } from './fifo.js';
import { computeLifo, type LifoInput } from './lifo.js';
import { computeWac, type WacInput } from './wac.js';
import type { EngineResult } from './engine.js';

export interface ComputePnlDeps {
  /**
   * Optional callback the engines call for gas price lookups. The orchestrator
   * wires this to the CoinGecko oracle; tests can pass a deterministic stub.
   */
  gasPriceUsdByTimestamp?: (timestamp: Timestamp) => number | undefined;
  /**
   * Optional map of token decimals by symbol, for non-standard ERC-20s.
   * Defaults cover the common Celo tokens (CELO, cUSD, USDC, USDT, cEUR, cREAL, G$).
   */
  decimalsBySymbol?: Record<string, number>;
}

export async function computePnl(
  input: PnlInput,
  deps: ComputePnlDeps = {},
): Promise<PnlOutput> {
  const compat = methodJurisdictionCompat(input.method, input.taxYear, 'NG');
  // We do not hard-fail on illegal combos — the caller (orchestrator) decides
  // whether to surface or proceed. Engine still runs and the compat list is
  // attached to the output for transparency.

  const engineInputBase = {
    classified: input.classified,
    ...(deps.decimalsBySymbol !== undefined && { decimalsBySymbol: deps.decimalsBySymbol }),
    ...(deps.gasPriceUsdByTimestamp !== undefined && {
      gasPriceUsdByTimestamp: deps.gasPriceUsdByTimestamp,
    }),
  };

  let engine: EngineResult;
  switch (input.method) {
    case 'FIFO':
      engine = computeFifo(engineInputBase as FifoInput);
      break;
    case 'LIFO':
      engine = computeLifo(engineInputBase as LifoInput);
      break;
    case 'WAC':
      engine = computeWac(engineInputBase as WacInput);
      break;
  }

  // Year-bucket the totals (passing classified for yield round-trip
  // auto-attribute — Quan 2026-06-14 second pass).
  const taxYears = bucketByYear(engine, input.taxYear, input.classified);

  // Convert micro-USD bigint totals → USD number for the contract shape.
  // (CSV exporter and orchestrator consume decimal numbers; we lose sub-cent
  // precision here, which is acceptable for tax reporting.)
  const microToUsd = (m: bigint): number => Number(m) / 1_000_000;

  return {
    address: input.address,
    method: input.method,
    taxYears,
    realizedPnlByAsset: Object.fromEntries(
      Object.entries(engine.realizedPnlMicroUsdByAsset).map(([k, v]) => [k, microToUsd(v)]),
    ),
    unrealizedPnlByAsset: computeUnrealized(engine, input.taxYear),
    incomeTotal: microToUsd(engine.incomeMicroUsdTotal),
    yieldTotal: microToUsd(engine.yieldMicroUsdTotal),
    interestEarnedTotal: microToUsd(engine.interestEarnedMicroUsdTotal),
    priceGaps: engine.priceGaps,
    methodJurisdictionCompat: compat,
    disposals: engine.disposals,
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Compute unrealized PNL per asset using the latest known cost basis and
 * (for the demo) a current price assumed equal to the cost basis — the
 * orchestrator overwrites this with a CoinGecko spot price once the report
 * is finalized. For now we return 0 so the contract is honored.
 *
 * TODO(orchestrator): wire a CoinGecko current-price call and replace the
 * `0` with `(spot - costBasis) * remainingAmount`.
 */
function computeUnrealized(
  _engine: EngineResult,
  _taxYear: number,
): Record<string, number> {
  return {};
}

/** Bucket income/yield/interest/gain/gas into per-calendar-year summaries.
 *
 *  Income, yield, and interestEarned are tracked per-year inside the engine
 *  (see `incomeMicroUsdByYear` / `yieldMicroUsdByYear` /
 *  `interestEarnedMicroUsdByYear` on `EngineResult`), so a 2024 deposit is
 *  credited to the 2024 summary, not the user's currently-requested year.
 *  Realized capital gains are bucketed per-disposal from the disposals array
 *  (this preserves correct per-year attribution across partial lot disposals).
 *  Gas is engine-wide (still a placeholder — see TODO in fifo.ts:160).
 *
 *  Taxable income formula:
 *    = income + yield + interestEarned + realizedGains - deductibleGas.
 *  Fix 2026-06-14: the previous formula dropped `yield` and `interestEarned`
 *  on the floor — for a KE 0xBE19-style wallet that deposited into a vault
 *  and never withdrew, the report showed `Yield: $5,374.90, Taxable income:
 *  $0.00` — internally inconsistent. The yield/interest now feed into the
 *  taxable line so the report is consistent.
 *
 *  Fix 2026-06-14 (Quan, second pass): yield round-trip auto-attribute.
 *  A YIELD-IN classified by the `yield.known_protocol_in@v1` rule (e.g.
 *  0xBE19's 5,374.90 USDC IN from 0x5b7ba647) was previously reported as
 *  GROSS yield in the Yield line. But the user's earlier OUT of 5,000
 *  USDC to the yield protocol is the cost basis — the net yield (gain) is
 *  only 374.90 USDC. To match sếp Quân's expectation that the report
 *  surfaces the net gain ("income should be $374, not $5,371"), we
 *  subtract the gross IN from the Yield bucket and route the net gain
 *  to Interest earned. The "matching OUT" is identified by same-symbol,
 *  same-year, and earlier-timestamp heuristic. (Future work: tighten the
 *  match by also comparing the OUT's recipient address to a known
 *  yield-protocol registry — currently the matching is loose.)
 */
function bucketByYear(
  engine: EngineResult,
  taxYear: number,
  classified: readonly ClassifiedTx[] = [],
): TaxYearSummary[] {
  const totalsByYear: Record<number, TaxYearSummary> = {};

  const ensure = (year: number): TaxYearSummary => {
    if (!totalsByYear[year]) {
      totalsByYear[year] = {
        year,
        realizedGains: 0,
        income: 0,
        yield: 0,
        interestEarned: 0,
        deductibleGas: 0,
        taxableIncome: 0,
      };
    }
    return totalsByYear[year];
  };

  for (const d of engine.disposals) {
    const year = new Date(d.timestamp * 1000).getUTCFullYear();
    const summary = ensure(year);
    // Vault withdraws route to interestEarned per disposal.category. Capital
    // gains (TRANSFER_OUT / SWAP) land in realizedGains as before.
    if (d.category === 'INTEREST_EARNED') {
      summary.interestEarned += Number(d.gainMicroUsd) / 1_000_000;
    } else {
      summary.realizedGains += Number(d.gainMicroUsd) / 1_000_000;
    }
  }

  // Income + yield: walk the per-year maps the engine populated. The
  // requested `taxYear` summary is always present (even if zero) so the
  // CLI summary line is never missing.
  for (const [yearStr, microUsd] of Object.entries(engine.incomeMicroUsdByYear)) {
    const year = Number(yearStr);
    const summary = ensure(year);
    summary.income += Number(microUsd) / 1_000_000;
  }
  for (const [yearStr, microUsd] of Object.entries(engine.yieldMicroUsdByYear)) {
    const year = Number(yearStr);
    const summary = ensure(year);
    summary.yield += Number(microUsd) / 1_000_000;
  }

  // ─── Yield round-trip auto-attribute (Quan 2026-06-14 second pass) ──
  // Subtract the gross YIELD-IN from the Yield bucket; route the net
  // gain (gross IN − matching prior OUT) to Interest earned.
  const adjustments = computeYieldRoundTripAdjustments(classified);
  for (const [year, reduction] of adjustments.yieldReductionByYear) {
    const summary = ensure(year);
    summary.yield -= reduction;
    summary.interestEarned += adjustments.interestEarnedByYear.get(year) ?? 0;
  }

  const requested = ensure(taxYear);
  // Gas is engine-wide (still a placeholder — see TODO in fifo.ts:160).
  requested.deductibleGas = Number(engine.gasMicroUsdTotal) / 1_000_000;
  for (const summary of Object.values(totalsByYear)) {
    summary.taxableIncome =
      summary.income +
      summary.yield +
      summary.interestEarned +
      summary.realizedGains -
      summary.deductibleGas;
  }

  return Object.values(totalsByYear).sort((a, b) => a.year - b.year);
}

/**
 * Default token decimals for common Celo tokens. Mirror of
 * `engine.ts:DEFAULT_DECIMALS` — kept here to avoid a cross-module
 * import for one inline helper.
 */
const ROUND_TRIP_DEFAULT_DECIMALS: Record<string, number> = {
  USDC: 6,
  USDT: 6,
  USDyc: 6,
  cUSD: 18,
  cEUR: 18,
  cREAL: 18,
  G$: 18,
  CELO: 18,
};

/** Compute the USD value of an asset leg using the engine's decimals. */
function legUsd(leg: { symbol: string; amount: string; priceUsd: number }): number {
  const decimals = ROUND_TRIP_DEFAULT_DECIMALS[leg.symbol] ?? 18;
  return (Number(leg.amount) * leg.priceUsd) / Math.pow(10, decimals);
}

/**
 * Find yield-protocol round-trips and produce per-year adjustments
 * that net the gross IN out of the Yield bucket and route the net
 * gain to Interest earned.
 *
 * Match heuristic (loose — see Quan 2026-06-14 follow-up):
 *  - The YIELD-IN must be classified by the `yield.known_protocol_in@v1`
 *    rule (notes contain "yield.known_protocol_in").
 *  - The matching OUT is the EARLIEST earlier classified event in the
 *    same year with the same asset symbol whose `assetOut` is set.
 *  - The net gain is `IN.value − OUT.value` (USD). If `IN.value <
 *    OUT.value`, the round-trip was a loss; we still attribute to
 *    Interest earned (negative).
 *  - The gross IN is subtracted from the Yield bucket.
 *
 * Future work: tighten the match by also requiring the OUT's recipient
 * to be in a yield-protocol registry. For now, the heuristic works for
 * the documented 0xBE19 case (5,000 USDC OUT May 13, 5,374.90 USDC IN
 * Dec 14, same symbol + same year).
 */
export function computeYieldRoundTripAdjustments(
  classified: readonly ClassifiedTx[],
): { yieldReductionByYear: Map<number, number>; interestEarnedByYear: Map<number, number> } {
  const yieldReductionByYear = new Map<number, number>();
  const interestEarnedByYear = new Map<number, number>();

  for (const c of classified) {
    // Only consider non-vault YIELD-IN classified by the yield.known_protocol_in rule.
    if (c.type !== 'YIELD') continue;
    if (c.vaultAddress !== undefined) continue;
    if (!c.notes?.includes('yield.known_protocol_in')) continue;
    if (!c.assetIn) continue;

    const txYear = new Date(c.timestamp * 1000).getUTCFullYear();
    const symbol = c.assetIn.symbol;
    const inUsd = legUsd(c.assetIn);

    // Find the EARLIEST earlier OUT with the same symbol in the same year.
    // Only match one OUT per YIELD-IN (the deposit), not all prior OUTs —
    // summing would incorrectly include unrelated USDC transfers (e.g. a
    // subsequent vault DEPOSIT after the yield IN).
    let outUsd = 0;
    let earliestTs = Infinity;
    for (const prev of classified) {
      if (prev.timestamp >= c.timestamp) continue;
      if (new Date(prev.timestamp * 1000).getUTCFullYear() !== txYear) continue;
      if (!prev.assetOut || prev.assetOut.symbol !== symbol) continue;
      if (prev.timestamp < earliestTs) {
        earliestTs = prev.timestamp;
        outUsd = legUsd(prev.assetOut);
      }
    }

    if (outUsd > 0) {
      const gain = inUsd - outUsd;
      yieldReductionByYear.set(txYear, (yieldReductionByYear.get(txYear) ?? 0) + inUsd);
      interestEarnedByYear.set(txYear, (interestEarnedByYear.get(txYear) ?? 0) + gain);
    }
  }

  return { yieldReductionByYear, interestEarnedByYear };
}

/** Compat entry: which (method, jurisdiction) combos are legal. */
export function methodJurisdictionCompat(
  method: CostBasisMethod,
  _taxYear: number,
  jurisdiction?: Jurisdiction,
): MethodJurisdictionCompat[] {
  const all: Jurisdiction[] = ['NG', 'KE', 'OTHER'];
  return all.map((j) => {
    const entry: MethodJurisdictionCompat = { method, jurisdiction: j, ok: true };
    if (method === 'LIFO' && j === 'NG') {
      entry.ok = false;
      entry.reason = 'LIFO is not permitted under NG FIRS — use FIFO.';
    }
    if (method === 'FIFO' && (j === 'NG' || j === 'KE') && jurisdiction === j) {
      entry.reason = 'FIFO is the legally required default for this jurisdiction.';
    }
    return entry;
  });
}

export { computeFifo } from './fifo.js';
export { computeLifo } from './lifo.js';
export { computeWac } from './wac.js';
export type { EngineResult, AssetLot, Disposal } from './engine.js';
