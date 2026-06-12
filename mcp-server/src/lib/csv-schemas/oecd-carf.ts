/**
 * OECD CARF-compatible CSV schema (used as OTHER jurisdiction fallback).
 * Ported from src/sub-agents/csv-exporter/schemas/oecd-carf.ts
 * Keep in sync with src/sub-agents/csv-exporter/schemas/oecd-carf.ts.
 *
 * Fields:
 *   reporting_period | tx_date | asset_type | tx_type | gross_proceeds_usd | cost_basis_usd | pnl_usd | user_jurisdiction | notes
 *
 * CARF taxonomy for tx_type:
 *   - "exchange"  = SWAP
 *   - "transfer"  = TRANSFER_IN | TRANSFER_OUT | BRIDGE
 *   - "payment"  = INCOME | YIELD | MINT
 *   - "fee"      = GAS
 *   - "burn"     = BURN
 *   - "other"    = UNKNOWN | MENTO_STABILITY
 */

import type { ClassifiedTx, Disposal } from './types.js';

const STABLECOIN_SYMBOLS = new Set([
  'cUSD', 'USDC', 'USDT', 'cEUR', 'cREAL', 'G$',
]);

export function carfTxType(tx: ClassifiedTx): string {
  switch (tx.type) {
    case 'SWAP':          return 'exchange';
    case 'TRANSFER_IN':
    case 'TRANSFER_OUT':
    case 'BRIDGE':        return 'transfer';
    case 'INCOME':
    case 'YIELD':
    case 'MINT':          return 'payment';
    case 'GAS':           return 'fee';
    case 'BURN':          return 'burn';
    default:               return 'other';
  }
}

function carfAssetType(symbol: string): string {
  return STABLECOIN_SYMBOLS.has(symbol) ? 'stablecoin' : 'other_crypto';
}

export interface OecdCarfRow {
  reporting_period: string;
  tx_date: string;
  asset_type: string;
  tx_type: string;
  gross_proceeds_usd: number;
  cost_basis_usd: number;
  pnl_usd: number;
  user_jurisdiction: string;
  notes: string;
}

function buildDisposalMap(disposals: Disposal[]): Map<string, Disposal> {
  return new Map(disposals.map((d) => [d.sourceHash, d]));
}

export function buildOecdCarfRows(
  classified: ClassifiedTx[],
  disposals: Disposal[],
  taxYear: number,
): OecdCarfRow[] {
  const disposalMap = buildDisposalMap(disposals);
  const rows: OecdCarfRow[] = [];

  for (const tx of classified) {
    if (tx.type === 'GAS') continue;

    const date = new Date(tx.timestamp * 1000);
    const assetIn = tx.assetIn;
    const assetOut = tx.assetOut;

    const asset = assetIn?.symbol ?? assetOut?.symbol ?? 'UNKNOWN';
    const txType = carfTxType(tx);

    let grossProceedsUsd = 0;
    let costBasisUsd = 0;

    if (txType === 'exchange') {
      const disposal = disposalMap.get(tx.hash);
      if (disposal) {
        grossProceedsUsd = Number(disposal.proceedsMicroUsd) / 1_000_000;
        costBasisUsd = Number(disposal.costBasisMicroUsd) / 1_000_000;
      } else {
        const inAmount = parseFloat(assetIn?.amount ?? '0');
        const outAmount = parseFloat(assetOut?.amount ?? '0');
        grossProceedsUsd = inAmount * (assetIn?.priceUsd ?? 0);
        costBasisUsd = outAmount * (assetOut?.priceUsd ?? 0);
      }
    }

    const pnlUsd = Math.round((grossProceedsUsd - costBasisUsd) * 100) / 100;

    rows.push({
      reporting_period: String(taxYear),
      tx_date: date.toISOString().split('T')[0]!,
      asset_type: carfAssetType(asset),
      tx_type: txType,
      gross_proceeds_usd: grossProceedsUsd,
      cost_basis_usd: costBasisUsd,
      pnl_usd: pnlUsd,
      user_jurisdiction: 'OTHER',
      notes: tx.notes ?? '',
    });
  }

  return rows;
}

export function renderOecdCarfCsv(rows: OecdCarfRow[]): string {
  const header = [
    'reporting_period', 'tx_date', 'asset_type', 'tx_type',
    'gross_proceeds_usd', 'cost_basis_usd', 'pnl_usd',
    'user_jurisdiction', 'notes',
  ];

  const body = rows.map((r) =>
    [
      r.reporting_period, r.tx_date, r.asset_type, r.tx_type,
      r.gross_proceeds_usd.toFixed(2), r.cost_basis_usd.toFixed(2),
      r.pnl_usd.toFixed(2), r.user_jurisdiction,
      `"${r.notes.replace(/"/g, '""')}"`,
    ].join(','),
  );

  return [header.join(','), ...body].join('\n');
}
