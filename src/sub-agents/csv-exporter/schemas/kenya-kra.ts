/**
 * Kenya KRA tax CSV schema.
 *
 * Owner: csv-exporter sub-agent.
 *
 * Encodes the KE KRA reporting requirements per the nigeria-kenya-crypto-tax skill:
 *   - Digital Asset Tax (DAT): 3% of gross transfer value — applies to SWAP / TRANSFER_OUT / TRANSFER_IN
 *   - Income Tax: ordinary income on INCOME / YIELD events at marginal rate (handled separately by KRA iTax)
 *   - No cost basis netting — a loss-making swap still incurs 3% DAT on outgoing asset value
 *   - Gas fees: NOT deductible under current KRA guidance
 *   - Currency: KES; rate = priceUsd × hard-coded CBK reference rate (1 USD = 153 KES)
 *
 * Fields:
 *   tx_date | type | asset | amount | price_kes | gross_transfer_value_kes | dat_due_kes | income_kes | notes
 *
 * Reference: Tax Laws (Amendment) Act 2023; Finance Act 2022; skill last updated 2026-06-07.
 */

import type { AssetLeg, ClassifiedTx } from '../../../shared/types.js';

/**
 * KE CBK exchange rate: 1 USD = KES_PER_USD env var, default 130 (2026 H1 CBK average).
 * DefiLlama does not list USD/KES — no live oracle fetch available.
 * Override via KES_PER_USD in .env for current spot rates.
 */
const KES_PER_USD = Number(process.env.KES_PER_USD ?? 130);

/** KRA DAT rate: 3% of gross transfer value. */
const DAT_RATE = 0.03;

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
  const hex = txHash.slice(2, 8).toUpperCase();
  return `Token@${hex}`;
}

/**
 * Map our TxType enum to KRA-friendly type labels.
 *
 * Under the Finance Act 2023, DAT applies to any "transfer" of a digital asset.
 * We treat SWAP and TRANSFER_OUT as transfers triggering DAT. TRANSFER_IN is
 * receipt — no DAT due from the counterparty; the counterparty's outflow is
 * their DAT event.
 *
 * Income = INCOME | YIELD | MINT (ordinary income under s.5 Income Tax Act).
 * Transfer = SWAP | TRANSFER_OUT (DAT applies to outgoing value).
 * Other   = GAS | TRANSFER_IN | BURN | BRIDGE | MENTO_STABILITY | UNKNOWN.
 */
function kraTypeLabel(tx: ClassifiedTx): string {
  switch (tx.type) {
    case 'SWAP':
    case 'TRANSFER_OUT':
      return 'transfer';
    case 'INCOME':
    case 'YIELD':
    case 'MINT':
      return 'income';
    default:
      return 'other';
  }
}

/**
 * KE KRA row shape — one row per ClassifiedTx.
 */
export interface KenyaKraRow {
  tx_date: string;                 // ISO 8601 date (UTC)
  type: string;                   // income | transfer | other
  asset: string;                   // symbol || assetName || shortened address (Fix #7)
  amount: string;                 // raw decimal string (full precision)
  price_kes: number;              // CBK rate × priceUsd, 2 dp
  gross_transfer_value_kes: number; // full outgoing value for DAT base, 2 dp
  dat_due_kes: number;            // 3% × gross_transfer_value_kes, 2 dp
  income_kes: number;             // market value for income events, 2 dp; 0 otherwise
  notes: string;                  // classifier notes
}

/**
 * Build KE KRA rows from classified transactions.
 * Fix #7: asset label uses symbol || assetName || shortenedAddress fallback chain.
 */
export function buildKenyaKraRows(
  classified: ClassifiedTx[],
): KenyaKraRow[] {
  const rows: KenyaKraRow[] = [];

  for (const tx of classified) {
    const date = new Date(tx.timestamp * 1000);
    const assetIn = tx.assetIn;
    const assetOut = tx.assetOut;

    if (tx.type === 'GAS') continue; // Gas not deductible under KRA guidance

    const asset = assetLabel(assetIn, tx.hash) || assetLabel(assetOut, tx.hash) || 'UNKNOWN';
    const amount = assetIn?.amount ?? assetOut?.amount ?? '0';

    const priceUsd = assetIn?.priceUsd ?? assetOut?.priceUsd ?? 0;
    const priceKes = Math.round(priceUsd * KES_PER_USD * 100) / 100;

    const label = kraTypeLabel(tx);

    // Gross transfer value = amount × price × KES rate for transfer events.
    // B3 fix: was using only priceUsd (per-unit); must multiply by full amount.
    const grossTransferValueKes =
      label === 'transfer' && assetOut?.priceUsd !== undefined
        ? Math.round(parseFloat(assetOut.amount) * assetOut.priceUsd * KES_PER_USD * 100) / 100
        : 0;

    // DAT = 3% of gross transfer value (no cost basis netting).
    const datDueKes =
      label === 'transfer'
        ? Math.round(grossTransferValueKes * DAT_RATE * 100) / 100
        : 0;

    // Income value for income-type events (market value on receipt).
    // B5 fix: was using only priceUsd (per-unit); must multiply by full amount.
    const incomeKes =
      label === 'income' && assetIn?.priceUsd !== undefined
        ? Math.round(parseFloat(assetIn.amount) * assetIn.priceUsd * KES_PER_USD * 100) / 100
        : 0;

    rows.push({
      tx_date: date.toISOString().split('T')[0]!,
      type: label,
      asset,
      amount,
      price_kes: priceKes,
      gross_transfer_value_kes: grossTransferValueKes,
      dat_due_kes: datDueKes,
      income_kes: incomeKes,
      notes: tx.notes ?? '',
    });
  }

  return rows;
}

/**
 * Render KE KRA rows as a CSV string.
 */
export function renderKenyaKraCsv(rows: KenyaKraRow[]): string {
  const header = [
    'tx_date',
    'type',
    'asset',
    'amount',
    'price_kes',
    'gross_transfer_value_kes',
    'dat_due_kes',
    'income_kes',
    'notes',
  ];

  const body = rows.map((r) =>
    [
      r.tx_date,
      r.type,
      r.asset,
      r.amount,
      r.price_kes.toFixed(2),
      r.gross_transfer_value_kes.toFixed(2),
      r.dat_due_kes.toFixed(2),
      r.income_kes.toFixed(2),
      `"${r.notes.replace(/"/g, '""')}"`,
    ].join(','),
  );

  return [header.join(','), ...body].join('\n');
}
