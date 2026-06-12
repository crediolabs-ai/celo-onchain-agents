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

import type { ClassifiedTx } from '../../../shared/types.js';

/** KE CBK exchange rate: 1 USD = 153 KES (2024 average). */
const KES_PER_USD = 153;

/** KRA DAT rate: 3% of gross transfer value. */
const DAT_RATE = 0.03;

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
  asset: string;                   // token symbol
  amount: string;                 // raw decimal string (full precision)
  price_kes: number;              // CBK rate × priceUsd, 2 dp
  gross_transfer_value_kes: number; // full outgoing value for DAT base, 2 dp
  dat_due_kes: number;            // 3% × gross_transfer_value_kes, 2 dp
  income_kes: number;             // market value for income events, 2 dp; 0 otherwise
  notes: string;                  // classifier notes
}

/**
 * Build KE KRA rows from classified transactions.
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

    const asset = assetIn?.symbol ?? assetOut?.symbol ?? 'UNKNOWN';
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
    const incomeKes =
      label === 'income' && assetIn?.priceUsd !== undefined
        ? Math.round(assetIn.priceUsd * KES_PER_USD * 100) / 100
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
