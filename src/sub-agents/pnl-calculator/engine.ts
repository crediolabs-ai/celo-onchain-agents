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

import type { TxHash, ClassifiedTx, AssetLeg, Timestamp } from '../../shared/types.js';

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
  };
}

/** Whether a classified tx is an acquisition event (adds to the lot queue). */
export function isAcquisition(c: ClassifiedTx): boolean {
  return (
    (c.type === 'TRANSFER_IN' || c.type === 'INCOME' || c.type === 'YIELD') &&
    c.assetIn !== undefined
  );
}

/** Whether a classified tx is a disposal event (consumes from the lot queue). */
export function isDisposal(c: ClassifiedTx): boolean {
  return (c.type === 'TRANSFER_OUT' || c.type === 'SWAP') && c.assetOut !== undefined;
}

/** Whether a classified tx is a pure gas event (no asset leg). */
export function isGas(c: ClassifiedTx): boolean {
  return c.type === 'GAS';
}
