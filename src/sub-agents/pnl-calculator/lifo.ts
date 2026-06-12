/**
 * LIFO cost-basis engine.
 *
 * Owner: Credio (pnl-calculator sub-agent).
 *
 * Same structure as FIFO; the only difference is the queue consumption
 * direction. Exposed for non-EM jurisdictions — Nigeria FIRS explicitly
 * requires FIFO; this engine must NOT be used with jurisdiction='NG'.
 *
 * Implementation: dequeue from the back of the queue (newest lot first).
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
  lotFromAcquisition,
  lotPricePerUnitUsd,
} from './engine.js';

export interface LifoInput {
  classified: ClassifiedTx[];
  decimalsBySymbol?: Record<string, number>;
  gasPriceUsdByTimestamp?: (timestamp: Timestamp) => number | undefined;
}

export function computeLifo(input: LifoInput): EngineResult {
  const decimalsBySymbol = { ...DEFAULT_DECIMALS, ...(input.decimalsBySymbol ?? {}) };
  const lots: Map<string, AssetLot[]> = new Map();
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
      const source: AssetLot['source'] =
        c.aggregatedFromHashes !== undefined
          ? 'aggregated'
          : (c.classifierSource as AssetLot['source']);
      const lot = lotFromAcquisition(c.assetIn, decimals, c.hash, source, c.timestamp);
      const queue = lots.get(symbol) ?? [];
      queue.push(lot);
      lots.set(symbol, queue);
      if (c.type === 'INCOME') incomeMicroUsdTotal += lot.costBasisMicroUsd;
      if (c.type === 'YIELD') yieldMicroUsdTotal += lot.costBasisMicroUsd;
      continue;
    }

    if (isDisposal(c) && c.assetOut) {
      const symbol = c.assetOut.symbol;
      const decimals = decimalsBySymbol[symbol] ?? 18;
      const decimalsAdj = BigInt(10) ** BigInt(decimals);
      const queue = lots.get(symbol) ?? [];
      let remaining = BigInt(c.assetOut.amount);
      const priceMicro = BigInt(Math.round(c.assetOut.priceUsd * 1_000_000));

      // Walk the LIFO queue from the back (newest lot first).
      while (remaining > 0n && queue.length > 0) {
        const back = queue[queue.length - 1]!;
        const take = remaining < back.amount ? remaining : back.amount;

        // All in REAL micro-USD (1e-6 precision).
        const costBasisConsumedMicro = (back.costBasisMicroUsd * take) / back.amount;
        const proceedsConsumedMicro = (priceMicro * take) / decimalsAdj;
        const gainMicro = proceedsConsumedMicro - costBasisConsumedMicro;

        const lotPriceUsd = lotPricePerUnitUsd(back);

        disposals.push({
          amount: take,
          symbol,
          proceedsMicroUsd: proceedsConsumedMicro,
          costBasisMicroUsd: costBasisConsumedMicro,
          gainMicroUsd: gainMicro,
          sourceHash: c.hash,
          lotSourceHash: back.sourceHash,
          disposalPriceUsd: c.assetOut.priceUsd,
          lotPriceUsd,
          timestamp: c.timestamp,
        });
        updatePnl(symbol, gainMicro);

        if (take === back.amount) {
          queue.pop();
        } else {
          const newAmount = back.amount - take;
          const newCostBasis = back.costBasisMicroUsd - costBasisConsumedMicro;
          queue[queue.length - 1] = { ...back, amount: newAmount, costBasisMicroUsd: newCostBasis };
        }
        remaining -= take;
      }

      if (remaining > 0n) {
        priceGaps.push({ asset: symbol, timestamp: c.timestamp });
      }
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

  return {
    disposals,
    remainingLots: lots,
    realizedPnlMicroUsdByAsset,
    incomeMicroUsdTotal,
    yieldMicroUsdTotal,
    gasMicroUsdTotal,
    priceGaps,
  };
}
