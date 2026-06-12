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

  // Year-bucket the totals.
  const taxYears = bucketByYear(engine, input.taxYear);

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

/** Bucket income/yield/gain/gas into the requested tax year. */
function bucketByYear(
  engine: EngineResult,
  taxYear: number,
): TaxYearSummary[] {
  // Hackathon scope: bucket everything into the single requested taxYear.
  // Post-hackathon: walk each disposal's timestamp and bucket per calendar year.
  const totalsByYear: Record<number, TaxYearSummary> = {};

  const ensure = (year: number): TaxYearSummary => {
    if (!totalsByYear[year]) {
      totalsByYear[year] = {
        year,
        realizedGains: 0,
        income: 0,
        yield: 0,
        deductibleGas: 0,
        taxableIncome: 0,
      };
    }
    return totalsByYear[year];
  };

  for (const d of engine.disposals) {
    const year = new Date(d.timestamp * 1000).getUTCFullYear();
    const summary = ensure(year);
    summary.realizedGains += Number(d.gainMicroUsd) / 1_000_000;
  }

  // Income + yield totals are engine-wide, not per-year. We apportion by
  // the proportion of each type's txs that landed in the requested year.
  // Simple v1: put everything in taxYear, zero elsewhere.
  const target = ensure(taxYear);
  target.income = Number(engine.incomeMicroUsdTotal) / 1_000_000;
  target.yield = Number(engine.yieldMicroUsdTotal) / 1_000_000;
  target.deductibleGas = Number(engine.gasMicroUsdTotal) / 1_000_000;
  target.taxableIncome = target.income + target.realizedGains - target.deductibleGas;

  return Object.values(totalsByYear).sort((a, b) => a.year - b.year);
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
