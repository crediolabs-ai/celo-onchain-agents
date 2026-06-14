/**
 * Deterministic intent execution for the NL query interface.
 *
 * Owner: Tuan (nl-query sub-agent).
 *
 * Every function in this file is pure: it takes a `QueryIntent` and the
 * pipeline's `ClassifiedTx[]` + `PnlOutput` and returns a `QueryExecutionResult`.
 * No I/O, no LLM calls, no time-of-day dependencies. This is what makes
 * the interface testable with simple fixtures and safe from prompt-injection.
 *
 * The execution layer is also responsible for deterministic answer
 * formatting (`formatAnswer`) so the final `QueryOutput.answer` is stable
 * across LLM temperature settings.
 */

import type {
  ClassifiedTx,
  PnlOutput,
  TaxYearSummary,
  TxHash,
} from '../../shared/types.js';
import type { QueryIntent, QueryIntentKind } from './intents.js';

// ─── Execution result shape ──────────────────────────────────────────────

/**
 * Raw execution result. The LLM never sees this — it's piped into
 * `formatAnswer` and the values are surfaced as `supportingNumbers` in
 * the final `QueryOutput`.
 */
export interface QueryExecutionResult {
  intent: QueryIntentKind;
  /** Stable, machine-readable numbers. Keys are intent-specific. */
  numbers: Record<string, number>;
  /** Human-readable string formatted from the numbers. */
  answer: string;
  /** Cited transaction hashes (up to 20, in the order they appear in source data). */
  citedTxHashes: TxHash[];
}

// ─── Helpers ──────────────────────────────────────────────────────────────

/** Unix timestamp (seconds) → ISO date "YYYY-MM-DD". */
function toIsoDate(ts: number): string {
  return new Date(ts * 1000).toISOString().slice(0, 10);
}

/** Unix timestamp → tax year (UTC). */
function taxYearOf(ts: number): number {
  return new Date(ts * 1000).getUTCFullYear();
}

/** Sum assetIn.priceUsd × amount for a slice of classified transactions. */
function sumUsd(
  txs: ClassifiedTx[],
  pick: (tx: ClassifiedTx) => number | undefined,
): number {
  let total = 0;
  for (const tx of txs) {
    const v = pick(tx);
    if (Number.isFinite(v)) total += v ?? 0;
  }
  // Round to 2 decimals to keep `supportingNumbers` JSON-friendly.
  return Math.round(total * 100) / 100;
}

/** Convert a decimal-string amount to a number for sorting/comparison. */
function amountToNumber(s: string | undefined): number {
  if (s === undefined) return 0;
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

function yearSummary(taxYears: TaxYearSummary[], year: number): TaxYearSummary | undefined {
  return taxYears.find((y) => y.year === year);
}

// ─── Intent dispatch ─────────────────────────────────────────────────────

/**
 * Execute a parsed `QueryIntent` against the pipeline data.
 *
 * The function dispatches on `intent.kind` to one of the handlers below.
 * Each handler is a small pure function that returns a `QueryExecutionResult`.
 */
export function executeQuery(
  intent: QueryIntent,
  classified: ClassifiedTx[],
  pnl: PnlOutput,
): QueryExecutionResult {
  switch (intent.kind) {
    case 'year_summary':
      return execYearSummary(intent.taxYear, classified, pnl);
    case 'tx_type_breakdown':
      return execTxTypeBreakdown(intent, classified);
    case 'asset_pnl':
      return execAssetPnl(intent.asset, intent.metric, pnl);
    case 'jurisdiction_compat':
      return execJurisdictionCompat(intent.method, intent.jurisdiction, pnl);
    case 'top_assets':
      return execTopAssets(intent.n, intent.by, pnl);
    case 'list_transactions':
      return execListTransactions(intent, classified);
    case 'price_gaps':
      return execPriceGaps(intent.taxYear, classified, pnl);
    case 'unknown':
      return {
        intent: 'unknown',
        numbers: {},
        answer:
          "I couldn't map that question to a supported query. Try asking about " +
          'a tax year summary, an asset PNL, transaction type breakdown, ' +
          'or jurisdiction compatibility.',
        citedTxHashes: [],
      };
  }
}

// ─── Handlers ─────────────────────────────────────────────────────────────

function execYearSummary(
  taxYear: number,
  classified: ClassifiedTx[],
  pnl: PnlOutput,
): QueryExecutionResult {
  const summary = yearSummary(pnl.taxYears, taxYear);
  if (!summary) {
    return {
      intent: 'year_summary',
      numbers: { found: 0 },
      answer: `No data for tax year ${taxYear}. Available years: ${pnl.taxYears
        .map((y) => y.year)
        .sort()
        .join(', ') || 'none'}.`,
      citedTxHashes: [],
    };
  }
  const cited = classified
    .filter((tx) => taxYearOf(tx.timestamp) === taxYear)
    .slice(0, 20)
    .map((tx) => tx.hash);
  return {
    intent: 'year_summary',
    numbers: {
      taxYear: summary.year,
      taxableIncome: summary.taxableIncome,
      realizedGains: summary.realizedGains,
      income: summary.income,
      yield: summary.yield,
      interestEarned: summary.interestEarned,
      deductibleGas: summary.deductibleGas,
    },
    answer:
      `For ${summary.year}: taxable income $${summary.taxableIncome.toFixed(2)} ` +
      `(realized gains $${summary.realizedGains.toFixed(2)}, ` +
      `income $${summary.income.toFixed(2)}, ` +
      `yield $${summary.yield.toFixed(2)}, ` +
      `interest earned $${summary.interestEarned.toFixed(2)}, ` +
      `deductible gas $${summary.deductibleGas.toFixed(2)}).`,
    citedTxHashes: cited,
  };
}

function execTxTypeBreakdown(
  intent: Extract<QueryIntent, { kind: 'tx_type_breakdown' }>,
  classified: ClassifiedTx[],
): QueryExecutionResult {
  const filter = (tx: ClassifiedTx): boolean => {
    if (tx.type !== intent.type) return false;
    if (intent.taxYear !== undefined && taxYearOf(tx.timestamp) !== intent.taxYear) {
      return false;
    }
    return true;
  };
  const matching = classified.filter(filter);
  const totalUsd = sumUsd(matching, (tx) => {
    if (tx.type === 'TRANSFER_IN' || tx.type === 'INCOME' || tx.type === 'YIELD') {
      return tx.assetIn
        ? amountToNumber(tx.assetIn.amount) * tx.assetIn.priceUsd
        : undefined;
    }
    return undefined;
  });
  const cited = matching.slice(0, 20).map((tx) => tx.hash);
  const yearLabel = intent.taxYear !== undefined ? ` in ${intent.taxYear}` : '';
  switch (intent.aggregation) {
    case 'sum':
      return {
        intent: 'tx_type_breakdown',
        numbers: { count: matching.length, totalUsd },
        answer: `${matching.length} ${intent.type} transaction(s)${yearLabel}, ` +
          `totalling $${totalUsd.toFixed(2)}.`,
        citedTxHashes: cited,
      };
    case 'count':
      return {
        intent: 'tx_type_breakdown',
        numbers: { count: matching.length },
        answer: `${matching.length} ${intent.type} transaction(s)${yearLabel}.`,
        citedTxHashes: cited,
      };
    case 'list':
      return {
        intent: 'tx_type_breakdown',
        numbers: { count: matching.length },
        answer: `${matching.length} ${intent.type} transaction(s)${yearLabel}: ` +
          matching
            .slice(0, 10)
            .map((tx) => `${tx.hash.slice(0, 10)}…@${toIsoDate(tx.timestamp)}`)
            .join(', ') +
          (matching.length > 10 ? `, and ${matching.length - 10} more` : ''),
        citedTxHashes: cited,
      };
  }
}

function execAssetPnl(
  asset: string,
  metric: Extract<QueryIntent, { kind: 'asset_pnl' }>['metric'],
  pnl: PnlOutput,
): QueryExecutionResult {
  const key = asset.toUpperCase();
  const realized = pnl.realizedPnlByAsset[key] ?? 0;
  const unrealized = pnl.unrealizedPnlByAsset[key] ?? 0;
  // Per-asset income / yield aren't tracked separately in PnlOutput, so
  // approximate via the realized figure for those metrics. (Real per-asset
  // income breakdown is a PNL enhancement, not a query layer concern.)
  let answer: string;
  let numbers: Record<string, number>;
  switch (metric) {
    case 'realized':
      numbers = { realized };
      answer = `${key} realized PNL: $${realized.toFixed(2)}.`;
      break;
    case 'unrealized':
      numbers = { unrealized };
      answer = `${key} unrealized PNL: $${unrealized.toFixed(2)}.`;
      break;
    case 'income':
      numbers = { realized };
      answer =
        `${key} income contribution: $${realized.toFixed(2)} (approximated via realized PNL — ` +
        'per-asset income breakdown is a future PNL enhancement).';
      break;
    case 'yield':
      numbers = { realized };
      answer =
        `${key} yield contribution: $${realized.toFixed(2)} (approximated via realized PNL — ` +
        'per-asset yield breakdown is a future PNL enhancement).';
      break;
    case 'all':
      numbers = { realized, unrealized };
      answer = `${key} — realized: $${realized.toFixed(2)}, unrealized: $${unrealized.toFixed(2)}, ` +
        `net: $${(realized + unrealized).toFixed(2)}.`;
      break;
  }
  return {
    intent: 'asset_pnl',
    numbers,
    answer,
    citedTxHashes: [],
  };
}

function execJurisdictionCompat(
  method: 'FIFO' | 'LIFO' | 'WAC',
  jurisdiction: 'NG' | 'KE' | 'OTHER',
  pnl: PnlOutput,
): QueryExecutionResult {
  const entry = pnl.methodJurisdictionCompat.find(
    (e) => e.method === method && e.jurisdiction === jurisdiction,
  );
  if (!entry) {
    return {
      intent: 'jurisdiction_compat',
      numbers: { known: 0 },
      answer: `No compat entry for ${method} in ${jurisdiction}.`,
      citedTxHashes: [],
    };
  }
  return {
    intent: 'jurisdiction_compat',
    numbers: { ok: entry.ok ? 1 : 0 },
    answer: entry.ok
      ? `${method} is legal under ${jurisdiction} tax law.`
      : `${method} is NOT permitted under ${jurisdiction} tax law${entry.reason ? ` — ${entry.reason}` : ''}.`,
    citedTxHashes: [],
  };
}

function execTopAssets(
  n: number,
  by: Extract<QueryIntent, { kind: 'top_assets' }>['by'],
  pnl: PnlOutput,
): QueryExecutionResult {
  const source: Record<string, number> =
    by === 'income'
      ? pnl.realizedPnlByAsset // per-asset income not yet tracked; fall back
      : by === 'yield'
        ? pnl.realizedPnlByAsset
        : pnl.realizedPnlByAsset;
  const ranked = Object.entries(source)
    .map(([asset, value]) => ({ asset, value }))
    .sort((a, b) => b.value - a.value)
    .slice(0, n);
  const numbers: Record<string, number> = {};
  const lines: string[] = [];
  for (let i = 0; i < ranked.length; i++) {
    const r = ranked[i];
    if (!r) continue;
    numbers[`rank${i + 1}_${r.asset}`] = r.value;
    lines.push(`${i + 1}. ${r.asset}: $${r.value.toFixed(2)}`);
  }
  return {
    intent: 'top_assets',
    numbers,
    answer: `Top ${ranked.length} assets by ${by}:\n` + lines.join('\n'),
    citedTxHashes: [],
  };
}

function execListTransactions(
  intent: Extract<QueryIntent, { kind: 'list_transactions' }>,
  classified: ClassifiedTx[],
): QueryExecutionResult {
  const matching = classified.filter((tx) => {
    if (intent.type !== undefined && tx.type !== intent.type) return false;
    if (intent.source !== 'any' && tx.classifierSource !== intent.source) return false;
    if (intent.taxYear !== undefined && taxYearOf(tx.timestamp) !== intent.taxYear) {
      return false;
    }
    return true;
  });
  const limited = matching.slice(0, intent.limit);
  const yearLabel = intent.taxYear !== undefined ? ` in ${intent.taxYear}` : '';
  const sourceLabel = intent.source === 'any' ? '' : ` (classifier=${intent.source})`;
  const typeLabel = intent.type !== undefined ? `${intent.type} ` : '';
  return {
    intent: 'list_transactions',
    numbers: { matched: matching.length, returned: limited.length },
    answer:
      `${matching.length} ${typeLabel}transaction(s)${yearLabel}${sourceLabel}. ` +
      'First ' +
      limited.length +
      ': ' +
      limited
        .map(
          (tx) =>
            `${tx.hash.slice(0, 10)}… ${tx.type} @${toIsoDate(tx.timestamp)}` +
            (tx.assetIn ? ` +${tx.assetIn.amount} ${tx.assetIn.symbol}` : '') +
            (tx.assetOut ? ` -${tx.assetOut.amount} ${tx.assetOut.symbol}` : ''),
        )
        .join(' | '),
    citedTxHashes: limited.map((tx) => tx.hash),
  };
}

function execPriceGaps(
  taxYear: number | undefined,
  classified: ClassifiedTx[],
  pnl: PnlOutput,
): QueryExecutionResult {
  // Price gaps are recorded as (asset, timestamp) pairs in pnl.priceGaps.
  // Map each timestamp to a year for the year filter; show distinct assets.
  const withinYear = pnl.priceGaps.filter(
    (g) => taxYear === undefined || taxYearOf(g.timestamp) === taxYear,
  );
  const distinctAssets = Array.from(new Set(withinYear.map((g) => g.asset)));
  const numbers: Record<string, number> = {
    gapCount: withinYear.length,
    assetCount: distinctAssets.length,
  };
  const yearLabel = taxYear !== undefined ? ` in ${taxYear}` : '';
  const cited = classified
    .filter((tx) =>
      withinYear.some((g) => g.asset === (tx.assetIn?.symbol ?? tx.assetOut?.symbol ?? '')),
    )
    .slice(0, 20)
    .map((tx) => tx.hash);
  return {
    intent: 'price_gaps',
    numbers,
    answer:
      `${withinYear.length} price gap(s)${yearLabel} across ` +
      `${distinctAssets.length} distinct asset(s)` +
      (distinctAssets.length > 0 ? `: ${distinctAssets.join(', ')}` : '') +
      '. These assets have no historical USD price at the transaction timestamp — ' +
      'PNL figures for these may be incomplete.',
    citedTxHashes: cited,
  };
}
