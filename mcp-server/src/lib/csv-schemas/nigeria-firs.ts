/**
 * Nigeria FIRS tax CSV schema.
 * Ported from src/sub-agents/csv-exporter/schemas/nigeria-firs.ts
 * Keep in sync with src/sub-agents/csv-exporter/schemas/nigeria-firs.ts.
 *
 * Encodes NG FIRS reporting requirements:
 *   - Capital Gains Tax: 10% flat on disposal (SWAP, TRANSFER_OUT)
 *   - Income Tax: ordinary income on INCOME / YIELD events
 *   - Gas fees: deductible against disposal proceeds
 *   - Currency: NGN; rate = priceUsd × 1550 (CBN reference)
 *
 * Fields:
 *   tx_date | type | asset | amount | price_ngn | cost_basis_ngn | gain_loss_ngn | cumulative_gain_ngn | notes
 */

import type { ClassifiedTx, Disposal } from './types.js';

const NGN_PER_USD = 1550;

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

export interface NigeriaFirsRow {
  tx_date: string;
  type: string;
  asset: string;
  amount: string;
  price_ngn: number;
  cost_basis_ngn: number;
  gain_loss_ngn: number;
  cumulative_gain_ngn: number;
  notes: string;
}

function buildDisposalMap(disposals: Disposal[]): Map<string, Disposal> {
  return new Map(disposals.map((d) => [d.sourceHash, d]));
}

export function buildNigeriaFirsRows(
  classified: ClassifiedTx[],
  disposals: Disposal[],
  _taxYear: number,
): NigeriaFirsRow[] {
  const disposalMap = buildDisposalMap(disposals);
  let cumulativeGain = 0;
  let lastRowYear: number | null = null;

  const rows: NigeriaFirsRow[] = [];

  for (const tx of classified) {
    const date = new Date(tx.timestamp * 1000);
    const assetIn = tx.assetIn;
    const assetOut = tx.assetOut;

    if (tx.type === 'GAS') continue;

    const asset = assetIn?.symbol ?? assetOut?.symbol ?? 'UNKNOWN';
    const amount = assetIn?.amount ?? assetOut?.amount ?? '0';

    const priceUsd = assetIn?.priceUsd ?? assetOut?.priceUsd ?? 0;
    const priceNgn = Math.round(priceUsd * NGN_PER_USD * 100) / 100;

    let costBasisNgn = 0;
    let gainNgn = 0;

    if (firsTypeLabel(tx) === 'disposal') {
      const disposal = disposalMap.get(tx.hash);
      if (disposal) {
        const proceedsNgn = Math.round((Number(disposal.proceedsMicroUsd) / 1_000_000) * NGN_PER_USD * 100) / 100;
        costBasisNgn = Math.round((Number(disposal.costBasisMicroUsd) / 1_000_000) * NGN_PER_USD * 100) / 100;
        gainNgn = Math.round((proceedsNgn - costBasisNgn) * 100) / 100;
      } else {
        const inAmount = parseFloat(assetIn?.amount ?? '0');
        const outAmount = parseFloat(assetOut?.amount ?? '0');
        const proceedsNgn = Math.round(inAmount * (assetIn?.priceUsd ?? 0) * NGN_PER_USD * 100) / 100;
        costBasisNgn = Math.round(outAmount * (assetOut?.priceUsd ?? 0) * NGN_PER_USD * 100) / 100;
        gainNgn = Math.round((proceedsNgn - costBasisNgn) * 100) / 100;
      }
    }

    const txYear = date.getUTCFullYear();
    if (lastRowYear !== null && txYear !== lastRowYear) cumulativeGain = 0;
    lastRowYear = txYear;

    cumulativeGain = Math.round((cumulativeGain + gainNgn) * 100) / 100;

    rows.push({
      tx_date: date.toISOString().split('T')[0]!,
      type: firsTypeLabel(tx),
      asset,
      amount,
      price_ngn: priceNgn,
      cost_basis_ngn: costBasisNgn,
      gain_loss_ngn: gainNgn,
      cumulative_gain_ngn: cumulativeGain,
      notes: tx.notes ?? '',
    });
  }

  return rows;
}

export function renderNigeriaFirsCsv(rows: NigeriaFirsRow[]): string {
  const header = [
    'tx_date', 'type', 'asset', 'amount', 'price_ngn',
    'cost_basis_ngn', 'gain_loss_ngn', 'cumulative_gain_ngn', 'notes',
  ];

  const body = rows.map((r) =>
    [
      r.tx_date, r.type, r.asset, r.amount,
      r.price_ngn.toFixed(2), r.cost_basis_ngn.toFixed(2),
      r.gain_loss_ngn.toFixed(2), r.cumulative_gain_ngn.toFixed(2),
      `"${r.notes.replace(/"/g, '""')}"`,
    ].join(','),
  );

  return [header.join(','), ...body].join('\n');
}
