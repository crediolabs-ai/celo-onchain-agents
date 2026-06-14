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

import type { AssetLeg, ClassifiedTx, PnlOutput } from '../../../shared/types.js';
import { classifyVaultAction, type Disposal } from '../../pnl-calculator/engine.js';

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
 * Income     = INCOME | MINT (ordinary income under s.5 Income Tax Act).
 * Deposit    = YIELD with vaultAddress (vault DEPOSIT — not income, the gain is
 *              realized only at the matching WITHDRAW).
 * Transfer   = SWAP | TRANSFER_OUT (DAT applies to outgoing value).
 * Other      = GAS | TRANSFER_IN | BURN | BRIDGE | MENTO_STABILITY | UNKNOWN.
 *
 * Note: vault WITHDRAW (YIELD with vaultAddress + assetOut) falls through to
 * 'transfer' via the explicit case below; its interest gain is reported in
 * the `interest_earned_kes` column instead of `income_kes`.
 *
 * Fix 2026-06-14: split YIELD into 'deposit' (vault, assetIn=share) vs the
 * existing 'income' (non-vault staking rewards) — Quan feedback that DEPOSIT
 * must not be misreported as income.
 */
/**
 * Resolve the KRA label for one specific leg of a classified tx.
 *
 * Quan 2026-06-14: a multi-leg tx (e.g. raw tx 0xf1727091 on wallet
 * 0xBE19, which sent 5,000 USDC OUT and received 5,000 KarmenMezz IN)
 * was previously rendered as a single CSV row keyed on the inbound
 * asset. The outbound leg (the USDC) was invisible. We now emit two
 * rows for multi-leg events: one for the inbound leg (leg='in') and
 * one for the outbound leg (leg='out'). Each leg gets a label
 * appropriate for its direction.
 */
function legTypeLabel(tx: ClassifiedTx, leg: 'in' | 'out'): string {
  if (leg === 'in') {
    // Inbound leg — what the wallet received.
    if (tx.type === 'TRANSFER_IN') return 'other';        // receipt, no DAT
    if (tx.type === 'INCOME' || tx.type === 'MINT') return 'income';
    const va = classifyVaultAction(tx);
    if (va === 'DEPOSIT') return 'deposit';
    if (va === 'WITHDRAW') return 'transfer';             // WITHDRAW's IN is the underlying
    if (tx.type === 'YIELD') {
      // Quan 2026-06-14: yield-protocol returns (e.g. 0xBE19 IN from
      // 0x5b7ba647) surface as a distinct 'yield' label so tax
      // authorities see them separate from generic staking income.
      // The engine's tax summary already separates them via the
      // Yield vs Income bucket; the CSV row label should too.
      if (tx.notes?.includes('yield.known_protocol_in')) return 'yield';
      return 'income';                                   // non-vault staking
    }
    return 'other';
  }
  // Outbound leg — what the wallet sent.
  if (tx.type === 'SWAP' || tx.type === 'TRANSFER_OUT') return 'transfer';
  const va2 = classifyVaultAction(tx);
  if (va2 === 'DEPOSIT') return 'other';                  // DEPOSIT's OUT is the underlying
  if (va2 === 'WITHDRAW') return 'transfer';              // WITHDRAW's OUT is the share
  return 'other';
}

/**
 * KE KRA row shape — one row per ClassifiedTx.
 */
export interface KenyaKraRow {
  tx_date: string;                 // ISO 8601 date (UTC)
  type: string;                   // income | transfer | deposit | other
  asset: string;                   // symbol || assetName || shortened address (Fix #7)
  amount: string;                 // raw decimal string (full precision)
  price_kes: number;              // CBK rate × priceUsd, 2 dp
  gross_transfer_value_kes: number; // full outgoing value for DAT base, 2 dp
  dat_due_kes: number;            // 3% × gross_transfer_value_kes, 2 dp
  income_kes: number;             // market value for income events, 2 dp; 0 otherwise
  interest_earned_kes: number;    // vault WITHDRAW gain (interest), 2 dp; 0 otherwise
  notes: string;                  // classifier notes
}

/**
 * Build a Map from tx hash → Disposal for O(1) lookup of vault-withdraw
 * interest gains. Populated by the PNL engine via `PnlOutput.disposals`
 * (interface contract amendment #6, 2026-06-10). The disposal's `category`
 * (added 2026-06-14) tells us whether the gain is interest or capital.
 */
function buildDisposalMap(pnl: PnlOutput | undefined): Map<string, Disposal> {
  if (!pnl) return new Map();
  return new Map(pnl.disposals.map((d) => [d.sourceHash, d]));
}

/**
 * Build KE KRA rows from classified transactions.
 * Fix #7: asset label uses symbol || assetName || shortenedAddress fallback chain.
 * Fix 2026-06-14: vault DEPOSIT no longer reports as 'income'; vault WITHDRAW
 * gain surfaces in `interest_earned_kes`.
 *
 * `pnl` is optional for backward compat with the orchestrator path that calls
 * this with just classified. When provided, vault WITHDRAW rows get their
 * interest gain routed to the new column.
 */
export function buildKenyaKraRows(
  classified: ClassifiedTx[],
  pnl?: PnlOutput,
): KenyaKraRow[] {
  const disposalMap = buildDisposalMap(pnl);
  const rows: KenyaKraRow[] = [];

  for (const tx of classified) {
    const date = new Date(tx.timestamp * 1000);
    const assetIn = tx.assetIn;
    const assetOut = tx.assetOut;

    if (tx.type === 'GAS') continue; // Gas not deductible under KRA guidance

    // Disposal lookup happens once per tx, shared across all legs.
    const disposal = disposalMap.get(tx.hash);
    const interestEarnedKes =
      disposal && disposal.category === 'INTEREST_EARNED'
        ? Math.round((Number(disposal.gainMicroUsd) / 1_000_000) * KES_PER_USD * 100) / 100
        : 0;

    // Build one row per asset leg. Quan 2026-06-14: multi-leg txs
    // (e.g. USDC OUT 5,000 paired with a token mint IN) were losing
    // the outbound leg in the CSV. Each leg is now its own row with
    // the right type label and the right per-direction math.
    const legs: Array<'in' | 'out'> = [];
    if (assetIn) legs.push('in');
    if (assetOut) legs.push('out');
    // Fallback for events with neither leg (shouldn't happen, but be safe).
    if (legs.length === 0) legs.push('in');

    for (const leg of legs) {
      const legAsset = leg === 'in' ? assetIn : assetOut;
      const legLabel = legTypeLabel(tx, leg);

      const asset = assetLabel(legAsset, tx.hash) ?? 'UNKNOWN';
      const amount = legAsset?.amount ?? '0';
      const priceUsd = legAsset?.priceUsd ?? 0;
      const priceKes = Math.round(priceUsd * KES_PER_USD * 100) / 100;

      // Gross transfer value = amount × price × KES rate for transfer events
      // (only on the OUT leg — DAT applies to outflows).
      // B3 fix: was using only priceUsd (per-unit); must multiply by full amount.
      const grossTransferValueKes =
        legLabel === 'transfer' && leg === 'out' && assetOut?.priceUsd !== undefined
          ? Math.round(parseFloat(assetOut.amount) * assetOut.priceUsd * KES_PER_USD * 100) / 100
          : 0;

      // DAT = 3% of gross transfer value (no cost basis netting).
      const datDueKes =
        legLabel === 'transfer' && leg === 'out'
          ? Math.round(grossTransferValueKes * DAT_RATE * 100) / 100
          : 0;

      // Income value for income-type events (only on the IN leg).
      // B5 fix: was using only priceUsd (per-unit); must multiply by full amount.
      const incomeKes =
        legLabel === 'income' && leg === 'in' && assetIn?.priceUsd !== undefined
          ? Math.round(parseFloat(assetIn.amount) * assetIn.priceUsd * KES_PER_USD * 100) / 100
          : 0;

      rows.push({
        tx_date: date.toISOString().split('T')[0]!,
        type: legLabel,
        asset,
        amount,
        price_kes: priceKes,
        gross_transfer_value_kes: grossTransferValueKes,
        dat_due_kes: datDueKes,
        income_kes: incomeKes,
        // Only surface interest_earned on the IN leg of a vault WITHDRAW
        // (the underlying received is the leg with proceeds). On the OUT
        // leg of a DEPOSIT, this stays 0.
        interest_earned_kes: leg === 'in' ? interestEarnedKes : 0,
        notes: tx.notes ?? '',
      });
    }
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
    'interest_earned_kes',
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
      r.interest_earned_kes.toFixed(2),
      `"${r.notes.replace(/"/g, '""')}"`,
    ].join(','),
  );

  return [header.join(','), ...body].join('\n');
}
