/**
 * WAC (Weighted Average Cost) basis engine.
 *
 * Owner: Credio (pnl-calculator sub-agent).
 *
 * Default cost basis method under US tax law and many non-EM jurisdictions.
 * Implementation: maintain a single running average per symbol; each
 * acquisition re-prices the entire pool; disposals realize gain against
 * that average price.
 *
 * Bigint amounts in token units; cost basis tracked in micro-USD.
 */

import type { ClassifiedTx, Timestamp } from '../../shared/types.js';
import {
  type AssetLot,
  type Disposal,
  type EngineResult,
  DEFAULT_DECIMALS,
  isAcquisition,
  isDisposal,
  isGas,
  lotPricePerUnitUsd,
} from './engine.js';

export interface WacInput {
  classified: ClassifiedTx[];
  decimalsBySymbol?: Record<string, number>;
  gasPriceUsdByTimestamp?: (timestamp: Timestamp) => number | undefined;
}

/** Single running-average lot per symbol. */
interface WacState {
  amount: bigint;
  costBasisMicroUsd: bigint;
  decimals: number;
  lastPriceUsd: number;
  lastTimestamp: Timestamp;
  lastSourceHash: import('../../shared/types.js').TxHash;
}

export function computeWac(input: WacInput): EngineResult {
  const decimalsBySymbol = { ...DEFAULT_DECIMALS, ...(input.decimalsBySymbol ?? {}) };
  const state: Map<string, WacState> = new Map();
  const disposals: Disposal[] = [];
  const realizedPnlMicroUsdByAsset: Record<string, bigint> = {};
  let incomeMicroUsdTotal = 0n;
  let yieldMicroUsdTotal = 0n;
  let gasMicroUsdTotal = 0n;
  const priceGaps: { asset: string; timestamp: Timestamp }[] = [];

  const updatePnl = (symbol: string, deltaMicro: bigint) => {
    realizedPnlMicroUsdByAsset[symbol] =
      (realizedPnlMicroUsdByAsset[symbol] ?? 0n) + deltaMicro;
  };

  for (const c of input.classified) {
    if (isAcquisition(c) && c.assetIn) {
      const symbol = c.assetIn.symbol;
      const decimals = decimalsBySymbol[symbol] ?? 18;
      const decimalsAdj = BigInt(10) ** BigInt(decimals);
      const amount = BigInt(c.assetIn.amount);
      // REAL micro-USD for the lot (not micro-USD × wei).
      const costMicro =
        (BigInt(Math.round(c.assetIn.priceUsd * 1_000_000)) * amount) / decimalsAdj;
      const cur = state.get(symbol);

      if (!cur || cur.amount === 0n) {
        state.set(symbol, {
          amount,
          costBasisMicroUsd: costMicro,
          decimals,
          lastPriceUsd: c.assetIn.priceUsd,
          lastTimestamp: c.timestamp,
          lastSourceHash: c.hash,
        });
      } else {
        state.set(symbol, {
          amount: cur.amount + amount,
          costBasisMicroUsd: cur.costBasisMicroUsd + costMicro,
          decimals: cur.decimals,
          lastPriceUsd: c.assetIn.priceUsd,
          lastTimestamp: c.timestamp,
          lastSourceHash: c.hash,
        });
      }
      if (c.type === 'INCOME') incomeMicroUsdTotal += costMicro;
      if (c.type === 'YIELD') yieldMicroUsdTotal += costMicro;
      continue;
    }

    if (isDisposal(c) && c.assetOut) {
      const symbol = c.assetOut.symbol;
      const cur = state.get(symbol);
      if (!cur || cur.amount === 0n) {
        priceGaps.push({ asset: symbol, timestamp: c.timestamp });
        continue;
      }
      const decimals = decimalsBySymbol[symbol] ?? 18;
      const decimalsAdj = BigInt(10) ** BigInt(decimals);
      const sellAmount = BigInt(c.assetOut.amount);
      const priceMicro = BigInt(Math.round(c.assetOut.priceUsd * 1_000_000));
      const take = sellAmount < cur.amount ? sellAmount : cur.amount;
      // Compute consumed cost basis in a single bigint step to avoid
      // losing precision to integer truncation. costBasisConsumedMicro is
      // in real micro-USD.
      const costBasisConsumedMicro = (cur.costBasisMicroUsd * take) / cur.amount;
      // Proceeds: (micro-USD-per-token × wei) ÷ decimalsAdj → real micro-USD.
      const proceedsConsumedMicro = (priceMicro * take) / decimalsAdj;
      const gainMicro = proceedsConsumedMicro - costBasisConsumedMicro;
      const remainingAmount = cur.amount - take;
      const remainingCost = cur.costBasisMicroUsd - costBasisConsumedMicro;
      const lotPriceUsd = lotPricePerUnitUsd(cur);

      disposals.push({
        amount: take,
        symbol,
        proceedsMicroUsd: proceedsConsumedMicro,
        costBasisMicroUsd: costBasisConsumedMicro,
        gainMicroUsd: gainMicro,
        sourceHash: c.hash,
        lotSourceHash: cur.lastSourceHash,
        disposalPriceUsd: c.assetOut.priceUsd,
        lotPriceUsd,
        timestamp: c.timestamp,
      });
      updatePnl(symbol, gainMicro);

      // If the disposal exceeds our pool, surface a price gap (parity with FIFO/LIFO).
      if (sellAmount > cur.amount) {
        priceGaps.push({ asset: symbol, timestamp: c.timestamp });
      }

      state.set(symbol, {
        amount: remainingAmount,
        costBasisMicroUsd: remainingCost,
        decimals: cur.decimals,
        lastPriceUsd: cur.lastPriceUsd,
        lastTimestamp: cur.lastTimestamp,
        lastSourceHash: cur.lastSourceHash,
      });
      continue;
    }

    if (isGas(c)) {
      const resolver = input.gasPriceUsdByTimestamp;
      if (resolver && resolver(c.timestamp) === undefined) {
        priceGaps.push({ asset: 'CELO', timestamp: c.timestamp });
      }
      continue;
    }
  }

  // Convert the WAC state map into the AssetLot[] shape EngineResult expects,
  // so callers (orchestrator) can render the remaining inventory uniformly.
  const remainingLots: Map<string, AssetLot[]> = new Map();
  for (const [symbol, s] of state) {
    if (s.amount === 0n) continue;
    remainingLots.set(symbol, [
      {
        amount: s.amount,
        costBasisMicroUsd: s.costBasisMicroUsd,
        symbol,
        decimals: s.decimals,
        timestamp: s.lastTimestamp,
        sourceHash: s.lastSourceHash,
        source: 'rule', // provenance is lost under WAC; default to 'rule'
      },
    ]);
  }

  return {
    disposals,
    remainingLots,
    realizedPnlMicroUsdByAsset,
    incomeMicroUsdTotal,
    yieldMicroUsdTotal,
    gasMicroUsdTotal,
    priceGaps,
  };
}
