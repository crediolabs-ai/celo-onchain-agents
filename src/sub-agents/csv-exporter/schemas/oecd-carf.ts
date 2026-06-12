/**
 * OECD CARF-compatible CSV schema (used as the OTHER jurisdiction fallback).
 *
 * Owner: csv-exporter sub-agent.
 *
 * Encodes the OECD CARF reporting requirements per the nigeria-kenya-crypto-tax skill.
 * When jurisdiction = OTHER, the exporter uses USD as the reporting currency and
 * leaves tax treatment fields blank, prompting the user to specify their jurisdiction.
 *
 * Fields:
 *   reporting_period | tx_date | asset_type | tx_type | gross_proceeds_usd | cost_basis_usd | pnl_usd | user_jurisdiction | notes
 *
 * Asset type mapping: stablecoins (cUSD, USDC, USDT, cEUR, cREAL, G$) → "stablecoin";
 * CELO → "other_crypto"; everything else → "other_crypto".
 *
 * CARF taxonomy for tx_type:
 *   - "exchange"   = SWAP
 *   - "transfer"   = TRANSFER_IN | TRANSFER_OUT | BRIDGE | TRANSFER
 *   - "payment"    = INCOME | YIELD | MINT
 *   - "fee"        = GAS
 *   - "burn"       = BURN
 *   - "other"      = UNKNOWN | MENTO_STABILITY
 *
 * Reference: OECD Crypto-Asset Reporting Framework (2022); adoption wave 2027.
 * Skill last updated 2026-06-07.
 */

import type { ClassifiedTx, PnlOutput } from '../../../shared/types.js';
import type { Disposal } from '../../pnl-calculator/engine.js';

/** Stablecoin symbols on Celo (per contract data). */
const STABLECOIN_SYMBOLS = new Set([
  'cUSD',
  'USDC',
  'USDT',
  'cEUR',
  'cREAL',
  'G$',
]);

/** Map our TxType → CARF tx_type taxonomy. Visible for unit testing. */
export function carfTxType(tx: ClassifiedTx): string {
  switch (tx.type) {
    case 'SWAP':
      return 'exchange';
    case 'TRANSFER_IN':
    case 'TRANSFER_OUT':
    case 'BRIDGE':
      return 'transfer';
    case 'INCOME':
    case 'YIELD':
    case 'MINT':
      return 'payment';
    case 'GAS':
      return 'fee';
    case 'BURN':
      return 'burn';
    default:
      return 'other';
  }
}

/** Map token symbol → CARF asset_type. */
function carfAssetType(symbol: string): string {
  return STABLECOIN_SYMBOLS.has(symbol) ? 'stablecoin' : 'other_crypto';
}

/**
 * OECD CARF row shape — one row per ClassifiedTx.
 */
export interface OecdCarfRow {
  reporting_period: string;   // "YYYY" tax year
  tx_date: string;             // ISO 8601 date (UTC)
  asset_type: string;          // stablecoin | other_crypto
  tx_type: string;             // exchange | transfer | payment | fee | burn | other
  gross_proceeds_usd: number;  // USD proceeds (0 for income/payment)
  cost_basis_usd: number;      // USD cost basis (0 for income)
  pnl_usd: number;             // proceeds - cost basis
  user_jurisdiction: string;   // "OTHER" (no tax calc in this schema)
  notes: string;               // classifier notes
}

/**
 * Build a Map from tx hash → Disposal for O(1) lookup in the CSV builder.
 * Populated by the PNL engine via `PnlOutput.disposals` (interface contract
 * amendment #6, 2026-06-10) so individual disposal CGT figures are available
 * per-row in the CSV.
 */
function buildDisposalMap(pnl: PnlOutput): Map<string, Disposal> {
  return new Map(pnl.disposals.map((d) => [d.sourceHash, d]));
}

/**
 * Build OECD CARF rows from classified transactions + PNL output.
 */
export function buildOecdCarfRows(
  classified: ClassifiedTx[],
  pnl: PnlOutput,
  taxYear: number,
): OecdCarfRow[] {
  const disposalMap = buildDisposalMap(pnl);
  const rows: OecdCarfRow[] = [];

  for (const tx of classified) {
    // GAS txs are fees, not taxable events — skip them (consistent with NG/KE schemas).
    if (tx.type === 'GAS') continue;

    const date = new Date(tx.timestamp * 1000);
    const assetIn = tx.assetIn;
    const assetOut = tx.assetOut;

    const asset = assetIn?.symbol ?? assetOut?.symbol ?? 'UNKNOWN';
    const txType = carfTxType(tx);

    // CARF proceeds/cost-basis: only meaningful for "exchange" (SWAP) events.
    // For "payment" (INCOME/YIELD/MINT), both are 0 — no disposal occurred.
    // For "transfer", "fee", "burn", "other", all three values are 0.
    //
    // B4 fix: proceeds = value of incoming token (assetIn), cost basis = FIFO cost
    // from EngineResult.disposals[]. Previously the two were swapped.
    let grossProceedsUsd = 0;
    let costBasisUsd = 0;

    if (txType === 'exchange') {
      const disposal = disposalMap.get(tx.hash);
      if (disposal) {
        // Use the PNL engine's per-disposal CGT figures (in micro-USD → USD).
        grossProceedsUsd = Number(disposal.proceedsMicroUsd) / 1_000_000;
        costBasisUsd = Number(disposal.costBasisMicroUsd) / 1_000_000;
      } else {
        // Fallback: proceeds = assetIn value, cost basis = assetOut value.
        // This is the correct directional formula even without a disposal record.
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

/**
 * Render OECD CARF rows as a CSV string.
 */
export function renderOecdCarfCsv(rows: OecdCarfRow[]): string {
  const header = [
    'reporting_period',
    'tx_date',
    'asset_type',
    'tx_type',
    'gross_proceeds_usd',
    'cost_basis_usd',
    'pnl_usd',
    'user_jurisdiction',
    'notes',
  ];

  const body = rows.map((r) =>
    [
      r.reporting_period,
      r.tx_date,
      r.asset_type,
      r.tx_type,
      r.gross_proceeds_usd.toFixed(2),
      r.cost_basis_usd.toFixed(2),
      r.pnl_usd.toFixed(2),
      r.user_jurisdiction,
      `"${r.notes.replace(/"/g, '""')}"`,
    ].join(','),
  );

  return [header.join(','), ...body].join('\n');
}
