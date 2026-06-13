/**
 * Nigeria FIRS tax CSV schema.
 *
 * Owner: csv-exporter sub-agent.
 *
 * Encodes the NG FIRS reporting requirements per the nigeria-kenya-crypto-tax skill:
 *   - Capital Gains Tax: 10% flat on disposal (SWAP, TRANSFER_OUT)
 *   - Income Tax: ordinary income on INCOME / YIELD events
 *   - Gas fees: deductible against disposal proceeds ( CGT basis)
 *   - Currency: NGN; rate = priceUsd × hard-coded CBN reference rate (1 USD = 1550 NGN)
 *
 * Fields:
 *   tx_date | type | asset | amount | price_ngn | cost_basis_ngn | gain_loss_ngn | cumulative_gain_ngn | notes
 *
 * Reference: FIRS Information Circular No. 2021/02; skill last updated 2026-06-07.
 */

import type { AssetLeg, ClassifiedTx, PnlOutput } from '../../../shared/types.js';
import type { Disposal } from '../../pnl-calculator/engine.js';

/**
 * NG FIRS exchange rate: 1 USD = NGN_PER_USD env var, default 1500 (2026 H1 CBN average).
 * DefiLlama does not list USD/NGN — no live oracle fetch available.
 * Override via NGN_PER_USD in .env for current spot rates.
 */
const NGN_PER_USD = Number(process.env.NGN_PER_USD ?? 1500);

/**
 * Pick the best human-readable label from an AssetLeg.
 * Fallback chain: symbol || assetName || Token@<first-6-hex-of-tx-hash>
 * Fix #7: prevents bare contract names (e.g. "KarmenMezz_JOT") from appearing
 * in CSV when a proper symbol is unavailable.
 */
function assetLabel(leg: AssetLeg | undefined, txHash: string): string {
  if (!leg) return 'UNKNOWN';
  if (leg.symbol) return leg.symbol;
  if (leg.assetName) return leg.assetName;
  // Shortened address derived from the tx hash — txHash is always 0x-prefixed.
  const hex = txHash.slice(2, 8).toUpperCase();
  return `Token@${hex}`;
}

/**
 * Map our TxType enum to FIRS-friendly type labels.
 *
 * Disposal = SWAP | TRANSFER_OUT (asset leaves the wallet for consideration).
 * Income   = INCOME | YIELD | MINT (new value received).
 * Other    = GAS | TRANSFER_IN | BURN | BRIDGE | MENTO_STABILITY | UNKNOWN.
 */
function firsTypeLabel(tx: ClassifiedTx): string {
  switch (tx.type) {
    case 'SWAP':
    case 'TRANSFER_OUT':
      return 'disposal';
    case 'INCOME':
    case 'YIELD':
    case 'MINT':
      return 'income';
    default:
      return 'other';
  }
}

/**
 * NG FIRS row shape — one row per ClassifiedTx.
 */
export interface NigeriaFirsRow {
  tx_date: string;           // ISO 8601 date (UTC)
  type: string;              // income | disposal | other
  asset: string;             // symbol || assetName || shortened address (Fix #7)
  amount: string;            // raw decimal string (full precision)
  price_ngn: number;        // CBN rate × priceUsd, 2 dp
  cost_basis_ngn: number;   // cost in NGN, 2 dp (0 for income/other)
  gain_loss_ngn: number;    // proceeds - cost basis, 2 dp (negative = loss)
  cumulative_gain_ngn: number; // running YTD total, 2 dp
  notes: string;             // classifier notes or 'Gas deductible' for SWAP gas
}

/**
 * Build a Map from tx hash → Disposal for O(1) lookup.
 * Populated by the PNL engine via `PnlOutput.disposals` (interface contract
 * amendment #6, 2026-06-10) so individual disposal CGT figures are available
 * per-row in the CSV.
 */
function buildDisposalMap(pnl: PnlOutput): Map<string, Disposal> {
  return new Map(pnl.disposals.map((d) => [d.sourceHash, d]));
}

/**
 * Build NG FIRS rows from classified transactions.
 *
 * The PNL engine provides per-disposal CGT figures via `pnl.disposals`. For each
 * disposal row we pull `proceedsMicroUsd` and `costBasisMicroUsd` directly,
 * converting micro-USD → NGN.  Gas is included as a deductible cost against
 * gains — not as a separate deduction — because FIRS treats it as a cost of
 * disposal.
 *
 * D2: `cumulative_gain_ngn` is YTD only — it resets to 0 whenever the
 * calendar year changes so that the running total always reflects the current
 * tax year's CGT liability, not lifetime gains.
 *
 * Fix #7: asset label uses symbol || assetName || shortenedAddress fallback chain.
 */
export function buildNigeriaFirsRows(
  classified: ClassifiedTx[],
  pnl: PnlOutput,
  _taxYear: number,
): NigeriaFirsRow[] {
  const disposalMap = buildDisposalMap(pnl);

  // Cumulative gain runs as we iterate; reset at each calendar-year boundary.
  let cumulativeGain = 0;
  let lastRowYear: number | null = null;

  const rows: NigeriaFirsRow[] = [];

  for (const tx of classified) {
    const date = new Date(tx.timestamp * 1000);
    const assetIn = tx.assetIn;
    const assetOut = tx.assetOut;

    // Skip GAS-only txs (gas cost is captured in disposal rows as a deductible).
    if (tx.type === 'GAS') continue;

    const asset = assetLabel(assetIn, tx.hash) || assetLabel(assetOut, tx.hash) || 'UNKNOWN';
    const amount = assetIn?.amount ?? assetOut?.amount ?? '0';

    // Convert price to NGN.
    const priceUsd = assetIn?.priceUsd ?? assetOut?.priceUsd ?? 0;
    const priceNgn = Math.round(priceUsd * NGN_PER_USD * 100) / 100;

    /**
     * Cost basis and gain/loss — B1/B2 fix:
     * Use the PNL engine's per-disposal record (proceeds + FIFO cost basis).
     * Fall back to the directional formula only when no disposal record exists.
     */
    let costBasisNgn = 0;
    let gainNgn = 0;

    if (firsTypeLabel(tx) === 'disposal') {
      const disposal = disposalMap.get(tx.hash);
      if (disposal) {
        // proceeds and costBasis are in micro-USD → convert to NGN.
        const proceedsNgn = Math.round((Number(disposal.proceedsMicroUsd) / 1_000_000) * NGN_PER_USD * 100) / 100;
        costBasisNgn = Math.round((Number(disposal.costBasisMicroUsd) / 1_000_000) * NGN_PER_USD * 100) / 100;
        gainNgn = Math.round((proceedsNgn - costBasisNgn) * 100) / 100;
      } else {
        // Fallback: proceeds = assetIn value, cost basis = assetOut value.
        // For TRANSFER_OUT (no assetIn) this is just market-value disposal.
        const inAmount = parseFloat(assetIn?.amount ?? '0');
        const outAmount = parseFloat(assetOut?.amount ?? '0');
        const proceedsNgn = Math.round(inAmount * (assetIn?.priceUsd ?? 0) * NGN_PER_USD * 100) / 100;
        costBasisNgn = Math.round(outAmount * (assetOut?.priceUsd ?? 0) * NGN_PER_USD * 100) / 100;
        gainNgn = Math.round((proceedsNgn - costBasisNgn) * 100) / 100;
      }
    }

    // D2: reset cumulative at year boundary.
    const txYear = date.getUTCFullYear();
    if (lastRowYear !== null && txYear !== lastRowYear) {
      cumulativeGain = 0;
    }
    lastRowYear = txYear;

    cumulativeGain = Math.round((cumulativeGain + gainNgn) * 100) / 100;

    const notes = tx.notes ?? '';

    rows.push({
      tx_date: date.toISOString().split('T')[0]!, // YYYY-MM-DD
      type: firsTypeLabel(tx),
      asset,
      amount,
      price_ngn: priceNgn,
      cost_basis_ngn: costBasisNgn,
      gain_loss_ngn: gainNgn,
      cumulative_gain_ngn: cumulativeGain,
      notes,
    });
  }

  return rows;
}

/**
 * Render NG FIRS rows as a CSV string.
 */
export function renderNigeriaFirsCsv(rows: NigeriaFirsRow[]): string {
  const header = [
    'tx_date',
    'type',
    'asset',
    'amount',
    'price_ngn',
    'cost_basis_ngn',
    'gain_loss_ngn',
    'cumulative_gain_ngn',
    'notes',
  ];

  const body = rows.map((r) =>
    [
      r.tx_date,
      r.type,
      r.asset,
      r.amount,
      r.price_ngn.toFixed(2),
      r.cost_basis_ngn.toFixed(2),
      r.gain_loss_ngn.toFixed(2),
      r.cumulative_gain_ngn.toFixed(2),
      `"${r.notes.replace(/"/g, '""')}"`,
    ].join(','),
  );

  return [header.join(','), ...body].join('\n');
}
