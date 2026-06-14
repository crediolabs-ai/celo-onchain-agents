/**
 * Shared types and helpers for the PNL calculator engines.
 *
 * Owner: Credio (pnl-calculator sub-agent).
 *
 * Three engines share the same shape; only the lot-queue policy differs:
 *   - FIFO: dequeue from the front
 *   - LIFO: dequeue from the back
 *   - WAC:  maintain a single running average
 *
 * Amounts are kept as bigint (in the token's smallest unit) until the very
 * edge where we convert to USD. Preserving precision through disposal math
 * is the only way to avoid cent-level drift on long histories.
 */

import type { Address, TxHash, ClassifiedTx, AssetLeg, Timestamp, DisposalCategory } from '../../shared/types.js';

export interface AssetLot {
  /** Token amount in smallest unit (e.g. wei for CELO, 6-dec for USDC). */
  amount: bigint;
  /** USD cost basis for the entire lot, in micro-USD (1e-6 precision). */
  costBasisMicroUsd: bigint;
  /** Token symbol — e.g. "CELO", "USDC", "cUSD". */
  symbol: string;
  /** Token decimals — used only for unit conversion at the edge. */
  decimals: number;
  /** Unix timestamp of the acquisition. */
  timestamp: Timestamp;
  /** Hash of the tx that produced this lot. */
  sourceHash: TxHash;
  /** Provenance: which classifier path produced the lot. */
  source: 'rule' | 'llm' | 'flagged' | 'aggregated';
  /**
   * Vault address for ERC-4626 share tokens — disambiguates lots from
   * different vaults that share the same symbol. Optional so non-vault
   * lots are unaffected (undefined degenerates to plain symbol-keyed queue).
   */
  vaultAddress?: Address;
}

export interface Disposal {
  amount: bigint;
  symbol: string;
  /** USD proceeds in micro-USD. */
  proceedsMicroUsd: bigint;
  /** USD cost basis consumed in micro-USD. */
  costBasisMicroUsd: bigint;
  /** Realized gain in micro-USD (proceeds - cost basis). */
  gainMicroUsd: bigint;
  /** Hash of the disposal tx (TRANSFER_OUT / SWAP out / etc). */
  sourceHash: TxHash;
  /** Hash of the lot that was consumed. */
  lotSourceHash: TxHash;
  /** Token's price at disposal time (USD per token, decimal). */
  disposalPriceUsd: number;
  /** Token's price at acquisition time of the consumed lot (USD per token, decimal). */
  lotPriceUsd: number;
  timestamp: Timestamp;
  /**
   * Bucket for tax-authority reporting. 'INTEREST_EARNED' = vault withdraw
   * (gain is yield the strategy earned). 'CAPITAL_GAIN' = TRANSFER_OUT /
   * SWAP / non-vault disposal. Added 2026-06-14.
   */
  category: DisposalCategory;
}

export interface EngineResult {
  disposals: Disposal[];
  /** Remaining lots per asset, ordered by acquisition (oldest first). */
  remainingLots: Map<string, AssetLot[]>;
  /** Realized PNL per asset, in micro-USD. */
  realizedPnlMicroUsdByAsset: Record<string, bigint>;
  /** Total income across all INCOME events, in micro-USD. */
  incomeMicroUsdTotal: bigint;
  /** Total yield across all YIELD events, in micro-USD. */
  yieldMicroUsdTotal: bigint;
  /**
   * Income totals bucketed by the calendar year of each event's timestamp,
   * in micro-USD. Used by the year summary so that a 2024 deposit is
   * credited to the 2024 tax year, not the user's currently-requested
   * year. (Previous behavior put all engine-wide totals in the requested
   * year regardless of when the events actually happened — see
   * pnl-calculator/index.ts bucketByYear for the consumer.)
   */
  incomeMicroUsdByYear: Record<number, bigint>;
  /** Yield totals bucketed by calendar year, in micro-USD. */
  yieldMicroUsdByYear: Record<number, bigint>;
  /**
   * Total interest income realized on vault withdraws, in micro-USD.
   * Added 2026-06-14 per Quan feedback — a vault DEPOSIT must NOT count as
   * income; the gain between DEPOSIT and WITHDRAW is realized only at the
   * WITHDRAW event, as `proceeds - cost basis` on the share disposal.
   * Sum of `gainMicroUsd` across disposals with `category = 'INTEREST_EARNED'`.
   */
  interestEarnedMicroUsdTotal: bigint;
  /** Interest earned bucketed by calendar year, in micro-USD. */
  interestEarnedMicroUsdByYear: Record<number, bigint>;
  /** Total gas cost across all GAS events, in micro-USD. */
  gasMicroUsdTotal: bigint;
  /** Asset/timestamp pairs where no historical price was available. */
  priceGaps: { asset: string; timestamp: Timestamp }[];
}

/** Default decimals for common Celo tokens. Engines let callers override. */
export const DEFAULT_DECIMALS: Record<string, number> = {
  CELO: 18,
  cUSD: 18,
  cEUR: 18,
  cREAL: 18,
  USDC: 6,
  USDT: 6,
  G$: 18, // GoodDollar
  USDyc: 6, // Untangled USDyc — ERC-4626 vault share wrapping USDC (on-chain symbol()="USDYc" verified 2026-06-13)
};

/** Share token symbols for known ERC-4626 vaults. Engine uses this to
 *  disambiguate YIELD-with-both-legs (vault DEPOSIT vs WITHDRAW):
 *   - If `assetIn.symbol` is in this set, the user RECEIVED shares → DEPOSIT
 *     (acquire share lot).
 *   - If `assetOut.symbol` is in this set, the user SURRENDERED shares →
 *     WITHDRAW (consume share lot).
 *  TODO post-hackathon: source from the registered-vault registry (e.g. on-chain
 *  `symbol()` call) instead of a hardcoded set; only one vault is registered
 *  today so a constant suffices. */
const VAULT_SHARE_SYMBOLS: ReadonlySet<string> = new Set(['USDyc']);

/** USD price per whole token (1.0 CELO), given a lot's real-micro-USD cost basis. */
export function lotPricePerUnitUsd(lot: {
  amount: bigint;
  costBasisMicroUsd: bigint;
  decimals: number;
}): number {
  if (lot.costBasisMicroUsd === 0n) return 0;
  const decimalsAdj = BigInt(10) ** BigInt(lot.decimals);
  return Number((lot.costBasisMicroUsd * decimalsAdj) / lot.amount) / 1_000_000;
}

/** Queue key for per-(vault, symbol) lot tracking.
 *
 *  For ERC-4626 share tokens, lots from different vaults are tracked
 *  separately even when the share symbol is the same (e.g. two USDC vaults
 *  both issuing "usdcVault" shares). Non-vault lots use the plain symbol.
 */
export function lotKey(symbol: string, vaultAddress?: Address): string {
  return vaultAddress ? `${vaultAddress.toLowerCase()}:${symbol}` : symbol;
}

/** Build an AssetLot from a classified acquisition event.
 *
 *  The cost basis is stored in REAL micro-USD (1e-6 precision), i.e. the
 *  dollar value of the whole lot as if you sold it the instant you bought
 *  it. The math is done in bigint space so amounts up to 1e24 wei (≈1M
 *  CELO) don't lose precision to double conversion.
 */
export function lotFromAcquisition(
  asset: AssetLeg,
  decimals: number,
  sourceHash: TxHash,
  source: AssetLot['source'],
  timestamp: Timestamp,
  vaultAddress?: Address,
): AssetLot {
  const amountRaw = BigInt(asset.amount);
  const decimalsAdj = BigInt(10) ** BigInt(decimals);
  const priceMicro = BigInt(Math.round(asset.priceUsd * 1_000_000));
  return {
    amount: amountRaw,
    costBasisMicroUsd: (priceMicro * amountRaw) / decimalsAdj,
    symbol: asset.symbol,
    decimals,
    timestamp,
    sourceHash,
    source,
    ...(vaultAddress !== undefined ? { vaultAddress } : {}),
  };
}

/** Whether a classified tx is an acquisition event (adds to the lot queue).
 *
 *  Vault deposits (YIELD + vaultAddress + assetIn=share) are acquisitions.
 *  Vault withdrawals (YIELD + vaultAddress + assetIn=underlying) are
 *  consumptions — see isLotConsumption(). The vault share symbol
 *  (VAULT_SHARE_SYMBOLS) is the discriminator: which leg is the share?
 *
 *  YIELD-without-vaultAddress and assetIn-only (no assetOut) is a legacy
 *  staking-reward / claim pattern — counts as an acquisition toward
 *  yieldMicroUsdTotal. The previous rule excluded ALL YIELD+assetOut from
 *  acquisition (the B1 fix), which was over-broad: deposits were lumped
 *  with withdrawals and never credited the share lot.
 */
export function isAcquisition(c: ClassifiedTx): boolean {
  if (c.type === 'YIELD' && c.vaultAddress !== undefined && c.assetIn !== undefined) {
    // Vault DEPOSIT: received shares (assetIn.symbol is the share symbol).
    if (VAULT_SHARE_SYMBOLS.has(c.assetIn.symbol)) return true;
    // Vault WITHDRAW (assetIn is the underlying) — fall through to the
    // consumption branch.
    return false;
  }
  return (
    (c.type === 'TRANSFER_IN' || c.type === 'INCOME' || c.type === 'YIELD') &&
    c.assetIn !== undefined
  );
}

/** Whether a classified tx is a disposal event (consumes from the lot queue). */
export function isDisposal(c: ClassifiedTx): boolean {
  return (c.type === 'TRANSFER_OUT' || c.type === 'SWAP') && c.assetOut !== undefined;
}

/** Whether a classified tx consumes from the lot queue (disposal-like).
 *
 *  Extends isDisposal() to also fire for YIELD-with-assetOut — both the
 *  vault WITHDRAW pattern (assetIn=underlying, assetOut=shares; surrender
 *  share, receive underlying) and the legacy YIELD-with-assetOut-only edge
 *  case (no assetIn at all). When assetIn IS the share, the YIELD is a
 *  DEPOSIT and the disposal branch is skipped — see isAcquisition() for
 *  the symmetric rule.
 */
export function isLotConsumption(c: ClassifiedTx): boolean {
  if (c.type === 'TRANSFER_OUT' || c.type === 'SWAP') return c.assetOut !== undefined;
  if (c.type === 'YIELD') {
    if (c.vaultAddress !== undefined && c.assetIn !== undefined) {
      // Vault DEPOSIT (assetIn is the share) → not a consumption.
      if (VAULT_SHARE_SYMBOLS.has(c.assetIn.symbol)) return false;
    }
    return c.assetOut !== undefined;
  }
  return false;
}

/**
 * Whether a classified tx is a vault WITHDRAW (surrender share, receive
 * underlying). The gain on a vault withdraw is realized interest income,
 * not a capital gain — added 2026-06-14 per Quan feedback.
 *
 * Symmetric to isAcquisition: a vault event with `vaultAddress` set is
 * either a DEPOSIT (assetIn is the share) or a WITHDRAW (assetOut is the
 * share, or assetIn is the underlying).
 */
export function isVaultWithdraw(c: ClassifiedTx): boolean {
  if (c.vaultAddress === undefined) return false;
  if (c.type !== 'YIELD') return false;
  if (c.assetOut === undefined) return false;
  // assetOut is the share (USDyc) being surrendered.
  return VAULT_SHARE_SYMBOLS.has(c.assetOut.symbol) || VAULT_SHARE_SYMBOLS.has(c.assetIn?.symbol ?? '');
}

/**
 * Discriminate a vault event as DEPOSIT (received shares) or WITHDRAW
 * (surrendered shares), based on which leg is the share token. Returns
 * null when the event isn't a vault event at all.
 *
 * Why the share-position check: a real-world DEPOSIT classifies as YIELD
 * with BOTH assetIn (shares received) and assetOut (underlying sent);
 * a WITHDRAW classifies as YIELD with BOTH assetIn (underlying received)
 * and assetOut (shares sent). The share symbol is the discriminator.
 *
 * Used by CSV exporters to label vault DEPOSIT rows as 'deposit' (not
 * 'income') and WITHDRAW rows as 'transfer' (not 'income'). Added
 * 2026-06-14 per Quan feedback.
 */
export function classifyVaultAction(c: ClassifiedTx): 'DEPOSIT' | 'WITHDRAW' | null {
  if (c.vaultAddress === undefined) return null;
  if (c.type !== 'YIELD') return null;
  // DEPOSIT: the share is the incoming leg.
  if (c.assetIn !== undefined && VAULT_SHARE_SYMBOLS.has(c.assetIn.symbol)) {
    return 'DEPOSIT';
  }
  // WITHDRAW: the share is the outgoing leg.
  if (c.assetOut !== undefined && VAULT_SHARE_SYMBOLS.has(c.assetOut.symbol)) {
    return 'WITHDRAW';
  }
  return null;
}

/**
 * Whether a classified tx is a staking-reward YIELD (pure income, no
 * acquisition of a vault share, no disposal). These legitimately count
 * toward `yieldMicroUsdTotal`. The vault DEPOSIT case (YIELD +
 * vaultAddress + assetIn=share) is NOT a staking reward — it's a deposit.
 * Added 2026-06-14 to fix the bug where vault DEPOSITs were double-counted
 * as both an acquisition and a yield event.
 */
export function isStakingRewardYield(c: ClassifiedTx): boolean {
  if (c.type !== 'YIELD') return false;
  if (c.vaultAddress !== undefined) return false;
  // No assetOut, has assetIn → pure income (e.g. GoodDollar claim, staking claim).
  return c.assetIn !== undefined && c.assetOut === undefined;
}

/** Whether a classified tx is a pure gas event (no asset leg). */
export function isGas(c: ClassifiedTx): boolean {
  return c.type === 'GAS';
}
