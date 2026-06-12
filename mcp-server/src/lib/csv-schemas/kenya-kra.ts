/**
 * Kenya KRA tax CSV schema.
 * Ported from src/sub-agents/csv-exporter/schemas/kenya-kra.ts
 * Keep in sync with src/sub-agents/csv-exporter/schemas/kenya-kra.ts.
 *
 * Encodes KE KRA reporting requirements:
 *   - Digital Asset Tax (DAT): 3% of gross transfer value on SWAP / TRANSFER_OUT
 *   - Income Tax: ordinary income on INCOME / YIELD events
 *   - Gas fees: NOT deductible under KRA guidance
 *   - Currency: KES; rate = priceUsd × 153 (CBK reference)
 *
 * Fields:
 *   tx_date | type | asset | amount | price_kes | gross_transfer_value_kes | dat_due_kes | income_kes | notes
 */

import type { ClassifiedTx } from './types.js';

const KES_PER_USD = 153;
const DAT_RATE = 0.03;

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

export interface KenyaKraRow {
  tx_date: string;
  type: string;
  asset: string;
  amount: string;
  price_kes: number;
  gross_transfer_value_kes: number;
  dat_due_kes: number;
  income_kes: number;
  notes: string;
}

export function buildKenyaKraRows(classified: ClassifiedTx[]): KenyaKraRow[] {
  const rows: KenyaKraRow[] = [];

  for (const tx of classified) {
    const date = new Date(tx.timestamp * 1000);
    const assetIn = tx.assetIn;
    const assetOut = tx.assetOut;

    if (tx.type === 'GAS') continue;

    const asset = assetIn?.symbol ?? assetOut?.symbol ?? 'UNKNOWN';
    const amount = assetIn?.amount ?? assetOut?.amount ?? '0';

    const priceUsd = assetIn?.priceUsd ?? assetOut?.priceUsd ?? 0;
    const priceKes = Math.round(priceUsd * KES_PER_USD * 100) / 100;

    const label = kraTypeLabel(tx);

    const grossTransferValueKes =
      label === 'transfer' && assetOut?.priceUsd !== undefined
        ? Math.round(parseFloat(assetOut.amount) * assetOut.priceUsd * KES_PER_USD * 100) / 100
        : 0;

    const datDueKes =
      label === 'transfer'
        ? Math.round(grossTransferValueKes * DAT_RATE * 100) / 100
        : 0;

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

export function renderKenyaKraCsv(rows: KenyaKraRow[]): string {
  const header = [
    'tx_date', 'type', 'asset', 'amount', 'price_kes',
    'gross_transfer_value_kes', 'dat_due_kes', 'income_kes', 'notes',
  ];

  const body = rows.map((r) =>
    [
      r.tx_date, r.type, r.asset, r.amount,
      r.price_kes.toFixed(2), r.gross_transfer_value_kes.toFixed(2),
      r.dat_due_kes.toFixed(2), r.income_kes.toFixed(2),
      `"${r.notes.replace(/"/g, '""')}"`,
    ].join(','),
  );

  return [header.join(','), ...body].join('\n');
}
