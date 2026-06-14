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

import type { AssetLeg, ClassifiedTx, PnlOutput } from '../../../shared/types.js';
import { classifyVaultAction, type Disposal } from '../../pnl-calculator/engine.js';

/** Stablecoin symbols on Celo (per contract data). */
const STABLECOIN_SYMBOLS = new Set([
  'cUSD',
  'USDC',
  'USDT',
  'cEUR',
  'cREAL',
  'G$',
]);

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

/** Map our TxType → CARF tx_type taxonomy. Visible for unit testing.
 *
 * Fix 2026-06-14: YIELD with vaultAddress+no assetOut (vault DEPOSIT) is
 * 'deposit' (not 'payment') so tax authorities can distinguish a
 * principal-funded vault position from yield income. YIELD with
 * vaultAddress+assetOut (vault WITHDRAW) is 'transfer' (shares leaving the
 * wallet).
 */
export function carfTxType(tx: ClassifiedTx): string {
  switch (tx.type) {
    case 'SWAP':
      return 'exchange';
    // Fix 2026-06-14 (Quan): TRANSFER_IN stays 'transfer' (CARF treats any
    // movement of crypto-assets as a reportable transfer, regardless of
    // direction). TRANSFER_OUT is unchanged.
    case 'TRANSFER_IN':
    case 'TRANSFER_OUT':
    case 'BRIDGE':
      return 'transfer';
    case 'YIELD': {
      // Vault events: discriminate DEPOSIT vs WITHDRAW by share position.
      const vaultAction = classifyVaultAction(tx);
      if (vaultAction === 'DEPOSIT') return 'deposit';
      if (vaultAction === 'WITHDRAW') return 'transfer';
      return 'payment';
    }
    case 'INCOME':
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
  tx_type: string;             // exchange | transfer | payment | fee | burn | deposit | other
  gross_proceeds_usd: number;  // USD proceeds (0 for income/payment/deposit)
  cost_basis_usd: number;      // USD cost basis (0 for income)
  pnl_usd: number;             // proceeds - cost basis
  interest_earned_usd: number; // vault WITHDRAW gain (interest), 0 for non-vault
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
 * Fix #7: asset label uses symbol || assetName || shortenedAddress fallback chain.
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

    // Fix 2026-06-14 (Quan): multi-leg txs emit one row per asset leg.
    const legs: Array<'in' | 'out'> = [];
    if (assetIn) legs.push('in');
    if (assetOut) legs.push('out');
    if (legs.length === 0) legs.push('in');

    // Compute disposal figures once per tx (shared across both legs).
    const disposal = disposalMap.get(tx.hash);
    const isExchOrXfer = legs.some((l) => legTypeLabel(tx, l) === 'exchange' || legTypeLabel(tx, l) === 'transfer');
    let grossProceedsUsd = 0, costBasisUsd = 0, interestEarnedUsd = 0;
    if (isExchOrXfer) {
      if (disposal) {
        grossProceedsUsd = Number(disposal.proceedsMicroUsd) / 1_000_000;
        costBasisUsd = Number(disposal.costBasisMicroUsd) / 1_000_000;
        if (disposal.category === 'INTEREST_EARNED') {
          interestEarnedUsd = Number(disposal.gainMicroUsd) / 1_000_000;
        }
      } else {
        // Fallback: proceeds = assetIn value, cost basis = assetOut value.
        const inAmount = parseFloat(assetIn?.amount ?? '0');
        const outAmount = parseFloat(assetOut?.amount ?? '0');
        grossProceedsUsd = inAmount * (assetIn?.priceUsd ?? 0);
        costBasisUsd = outAmount * (assetOut?.priceUsd ?? 0);
      }
    }

    for (const leg of legs) {
      const legAsset = leg === 'in' ? assetIn : assetOut;
      const legLabel = legTypeLabel(tx, leg);

      const asset = assetLabel(legAsset, tx.hash) ?? 'UNKNOWN';
      const txType = legLabel;

      // pnl_usd: capital-gain only on the OUT leg (excludes interest).
      const legPnl = leg === 'out'
        ? Math.round((grossProceedsUsd - costBasisUsd) * 100) / 100
        : 0;
      // interest_earned_usd only on the IN leg of a vault WITHDRAW.
      const legInterest = leg === 'in' ? interestEarnedUsd : 0;

      rows.push({
        reporting_period: String(taxYear),
        tx_date: date.toISOString().split('T')[0]!,
        asset_type: carfAssetType(asset),
        tx_type: txType,
        gross_proceeds_usd: leg === 'out' ? grossProceedsUsd : 0,
        cost_basis_usd: leg === 'out' ? costBasisUsd : 0,
        pnl_usd: legPnl,
        interest_earned_usd: legInterest,
        user_jurisdiction: 'OTHER',
        notes: tx.notes ?? '',
      });
    }
  }

  return rows;
}

/**
 * Per-leg type label for OECD CARF. Symmetric to KE/NG's legTypeLabel.
 *
 * Quan 2026-06-14: a multi-leg tx (e.g. USDC OUT paired with a token
 * mint IN) was previously rendered as a single CARF row keyed on the
 * inbound asset. The outbound leg (the spent USDC) was invisible. We
 * now emit one row per leg, with each leg getting the right CARF
 * tx_type.
 */
function legTypeLabel(tx: ClassifiedTx, leg: 'in' | 'out'): string {
  if (leg === 'in') {
    if (tx.type === 'SWAP') return 'exchange';
    if (tx.type === 'TRANSFER_IN' || tx.type === 'TRANSFER_OUT' || tx.type === 'BRIDGE') return 'transfer';
    const va = classifyVaultAction(tx);
    if (va === 'DEPOSIT') return 'deposit';
    if (va === 'WITHDRAW') return 'transfer';
    if (tx.type === 'INCOME' || tx.type === 'MINT') return 'payment';
    if (tx.type === 'YIELD') return 'payment';
    if (tx.type === 'GAS') return 'fee';
    if (tx.type === 'BURN') return 'burn';
    return 'other';
  }
  // Outbound leg.
  if (tx.type === 'SWAP') return 'exchange';
  if (tx.type === 'TRANSFER_IN' || tx.type === 'TRANSFER_OUT' || tx.type === 'BRIDGE') return 'transfer';
  const va2 = classifyVaultAction(tx);
  if (va2 === 'DEPOSIT') return 'transfer';
  if (va2 === 'WITHDRAW') return 'transfer';
  if (tx.type === 'GAS') return 'fee';
  if (tx.type === 'BURN') return 'burn';
  return 'other';
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
    'interest_earned_usd',
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
      r.interest_earned_usd.toFixed(2),
      r.user_jurisdiction,
      `"${r.notes.replace(/"/g, '""')}"`,
    ].join(','),
  );

  return [header.join(','), ...body].join('\n');
}
