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
import { classifyVaultAction, type Disposal } from '../../pnl-calculator/engine.js';

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
 *           Vault WITHDRAW (YIELD + vaultAddress + assetOut) is also a
 *           disposal — shares are leaving. The gain is interest, not capital,
 *           but it still goes through the disposal-map path so the per-row
 *           cost basis / gain numbers are correct.
 * Income   = INCOME | MINT (new value received, taxable as ordinary income).
 * Deposit  = YIELD + vaultAddress (vault DEPOSIT, not income — gain is
 *           realized only at the matching WITHDRAW).
 * Other    = GAS | TRANSFER_IN | BURN | BRIDGE | MENTO_STABILITY | UNKNOWN |
 *           non-vault YIELD (staking rewards — only the interest_earned_ngn
 *           column catches this case via the disposal map if classified as
 *           YIELD elsewhere).
 *
 * Fix 2026-06-14: split YIELD into 'deposit' (vault, no assetOut) vs
 * 'disposal' (vault WITHDRAW) vs 'income' (non-vault staking) — Quan
 * feedback that DEPOSIT must not be misreported as income.
 */
function firsTypeLabel(tx: ClassifiedTx): string {
  switch (tx.type) {
    case 'SWAP':
    case 'TRANSFER_OUT':
      return 'disposal';
    // Fix 2026-06-14 (Quan): TRANSFER_IN is receipt of value, not a
    // disposal. FIRS only taxes disposals and income — IN is neither.
    case 'TRANSFER_IN':
      return 'other';
    case 'INCOME':
    case 'MINT':
      return 'income';
    case 'YIELD': {
      // Vault events: discriminate DEPOSIT vs WITHDRAW by share position.
      const vaultAction = classifyVaultAction(tx);
      if (vaultAction === 'DEPOSIT') return 'deposit';
      if (vaultAction === 'WITHDRAW') return 'disposal';
      return 'income';
    }
    default:
      return 'other';
  }
}

/**
 * NG FIRS row shape — one row per ClassifiedTx.
 */
export interface NigeriaFirsRow {
  tx_date: string;           // ISO 8601 date (UTC)
  type: string;              // income | disposal | deposit | other
  asset: string;             // symbol || assetName || shortened address (Fix #7)
  amount: string;            // raw decimal string (full precision)
  price_ngn: number;        // CBN rate × priceUsd, 2 dp
  cost_basis_ngn: number;   // cost in NGN, 2 dp (0 for income/other)
  gain_loss_ngn: number;    // capital-gain proceeds - cost basis, 2 dp (negative = loss)
  cumulative_gain_ngn: number; // running YTD total, 2 dp
  interest_earned_ngn: number; // vault WITHDRAW gain (interest income), 2 dp
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

    // Fix 2026-06-14 (Quan): multi-leg txs emit one row per asset leg.
    // The KE schema led; port the same pattern here so NG reports don't
    // hide the outbound leg of e.g. an ERC-20 swap.
    const legs: Array<'in' | 'out'> = [];
    if (assetIn) legs.push('in');
    if (assetOut) legs.push('out');
    if (legs.length === 0) legs.push('in'); // safety fallback

    // Compute disposal figures once per tx (shared across both legs).
    const disposal = disposalMap.get(tx.hash);
    const isDisposal = firsTypeLabel(tx) === 'disposal';
    let proceedsNgn = 0, costBasisNgn = 0, gainNgn = 0, interestEarnedNgn = 0;
    if (isDisposal && disposal) {
      proceedsNgn = Math.round((Number(disposal.proceedsMicroUsd) / 1_000_000) * NGN_PER_USD * 100) / 100;
      costBasisNgn = Math.round((Number(disposal.costBasisMicroUsd) / 1_000_000) * NGN_PER_USD * 100) / 100;
      if (disposal.category === 'INTEREST_EARNED') {
        interestEarnedNgn = Math.round((Number(disposal.gainMicroUsd) / 1_000_000) * NGN_PER_USD * 100) / 100;
      } else {
        gainNgn = Math.round((proceedsNgn - costBasisNgn) * 100) / 100;
      }
    } else if (isDisposal) {
      // Fallback when no disposal record (no PNL engine match). Compute
      // from the OUT leg's notional value.
      const inAmount = parseFloat(assetIn?.amount ?? '0');
      const outAmount = parseFloat(assetOut?.amount ?? '0');
      proceedsNgn = Math.round(inAmount * (assetIn?.priceUsd ?? 0) * NGN_PER_USD * 100) / 100;
      costBasisNgn = Math.round(outAmount * (assetOut?.priceUsd ?? 0) * NGN_PER_USD * 100) / 100;
      gainNgn = Math.round((proceedsNgn - costBasisNgn) * 100) / 100;
    }

    for (const leg of legs) {
      const legAsset = leg === 'in' ? assetIn : assetOut;
      const legLabel = legTypeLabel(tx, leg);

      const asset = assetLabel(legAsset, tx.hash) ?? 'UNKNOWN';
      const amount = legAsset?.amount ?? '0';
      const priceUsd = legAsset?.priceUsd ?? 0;
      const priceNgn = Math.round(priceUsd * NGN_PER_USD * 100) / 100;

      // D2: reset cumulative at year boundary.
      const txYear = date.getUTCFullYear();
      if (lastRowYear !== null && txYear !== lastRowYear) {
        cumulativeGain = 0;
      }
      lastRowYear = txYear;

      // Only the OUT leg contributes to capital-gain cumulative (CGT
      // is computed on the outbound leg of disposals). The IN leg
      // doesn't add to cumulative gain.
      const legGainNgn = leg === 'out' ? gainNgn : 0;
      const legInterestNgn = leg === 'in' ? interestEarnedNgn : 0;
      cumulativeGain = Math.round((cumulativeGain + legGainNgn) * 100) / 100;

      const notes = tx.notes ?? '';

      rows.push({
        tx_date: date.toISOString().split('T')[0]!, // YYYY-MM-DD
        type: legLabel,
        asset,
        amount,
        price_ngn: priceNgn,
        cost_basis_ngn: leg === 'out' ? costBasisNgn : 0,
        gain_loss_ngn: legGainNgn,
        cumulative_gain_ngn: cumulativeGain,
        interest_earned_ngn: legInterestNgn,
        notes,
      });
    }
  }

  return rows;
}

/**
 * Per-leg type label for NG FIRS. Symmetric to KE's legTypeLabel.
 *
 * Quan 2026-06-14: a multi-leg tx (e.g. USDC OUT paired with a token
 * mint IN) was previously rendered as a single NG row keyed on the
 * inbound asset. The outbound leg (the spent USDC) was invisible. We
 * now emit two rows for multi-leg events: one for the inbound leg
 * (leg='in') and one for the outbound leg (leg='out').
 */
function legTypeLabel(tx: ClassifiedTx, leg: 'in' | 'out'): string {
  if (leg === 'in') {
    if (tx.type === 'TRANSFER_IN') return 'other';
    if (tx.type === 'INCOME' || tx.type === 'MINT') return 'income';
    const va = classifyVaultAction(tx);
    if (va === 'DEPOSIT') return 'deposit';
    if (va === 'WITHDRAW') return 'disposal';
    if (tx.type === 'YIELD') return 'income';
    return 'other';
  }
  // Outbound leg.
  if (tx.type === 'SWAP' || tx.type === 'TRANSFER_OUT') return 'disposal';
  const va2 = classifyVaultAction(tx);
  if (va2 === 'DEPOSIT') return 'other';
  if (va2 === 'WITHDRAW') return 'disposal';
  return 'other';
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
    'interest_earned_ngn',
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
      r.interest_earned_ngn.toFixed(2),
      `"${r.notes.replace(/"/g, '""')}"`,
    ].join(','),
  );

  return [header.join(','), ...body].join('\n');
}
