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

import type { Address, TxHash, ClassifiedTx, AssetLeg, Timestamp } from '../../shared/types.js';

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
  USDy: 6, // Untangled USDy — ERC-4626 vault share wrapping USDC (verified on-chain 2026-06-12)
};

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
 *  YIELD-with-assetOut (vault withdraw: shares surrendered, underlying received)
 *  is treated as a disposal, NOT an acquisition — see isLotConsumption(). The
 *  exclusion here prevents isAcquisition from short-circuiting the iteration
 *  and creating a phantom lot for the incoming underlying.
 */
export function isAcquisition(c: ClassifiedTx): boolean {
  return (
    (c.type === 'TRANSFER_IN' || c.type === 'INCOME' || c.type === 'YIELD') &&
    c.assetIn !== undefined &&
    !(c.type === 'YIELD' && c.assetOut !== undefined)
  );
}

/** Whether a classified tx is a disposal event (consumes from the lot queue). */
export function isDisposal(c: ClassifiedTx): boolean {
  return (c.type === 'TRANSFER_OUT' || c.type === 'SWAP') && c.assetOut !== undefined;
}

/** Whether a classified tx consumes from the lot queue (disposal-like).
 *
 *  Extends isDisposal() to also fire for YIELD-with-assetOut — the vault
 *  withdraw pattern (surrender shares, receive underlying). Staking-reward
 *  YIELD (assetIn only) still goes through the acquisition branch.
 *
 *  Use as: `if (isLotConsumption(c)) { ... walk queue, emit Disposal ... }`.
 */
export function isLotConsumption(c: ClassifiedTx): boolean {
  if (c.type === 'TRANSFER_OUT' || c.type === 'SWAP') return c.assetOut !== undefined;
  if (c.type === 'YIELD') return c.assetOut !== undefined;
  return false;
}

/** Whether a classified tx is a pure gas event (no asset leg). */
export function isGas(c: ClassifiedTx): boolean {
  return c.type === 'GAS';
}
