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
  isGas,
  isLotConsumption,
  isStakingRewardYield,
  isVaultWithdraw,
  lotFromAcquisition,
  lotKey,
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
  const incomeMicroUsdByYear: Record<number, bigint> = {};
  const yieldMicroUsdByYear: Record<number, bigint> = {};
  let interestEarnedMicroUsdTotal = 0n;
  const interestEarnedMicroUsdByYear: Record<number, bigint> = {};
  let gasMicroUsdTotal = 0n;
  const priceGaps: { asset: string; timestamp: Timestamp }[] = [];

  const updatePnl = (symbol: string, deltaMicro: bigint) => {
    realizedPnlMicroUsdByAsset[symbol] =
      (realizedPnlMicroUsdByAsset[symbol] ?? 0n) + deltaMicro;
  };

  for (const c of input.classified) {
    if (isAcquisition(c) && c.assetIn) {
      const symbol = c.assetIn.symbol;
      const vaultAddress = c.vaultAddress;
      const decimals = decimalsBySymbol[symbol] ?? 18;
      const source: AssetLot['source'] =
        c.aggregatedFromHashes !== undefined
          ? 'aggregated'
          : (c.classifierSource as AssetLot['source']);
      const lot = lotFromAcquisition(c.assetIn, decimals, c.hash, source, c.timestamp, vaultAddress);
      const queue = lots.get(lotKey(symbol, vaultAddress)) ?? [];
      queue.push(lot);
      lots.set(lotKey(symbol, vaultAddress), queue);
      if (c.type === 'INCOME') {
        incomeMicroUsdTotal += lot.costBasisMicroUsd;
        const y = new Date(c.timestamp * 1000).getUTCFullYear();
        incomeMicroUsdByYear[y] = (incomeMicroUsdByYear[y] ?? 0n) + lot.costBasisMicroUsd;
      }
      // Fix 2026-06-14: only non-vault staking-reward YIELD counts as yield.
      // See fifo.ts for full rationale.
      if (isStakingRewardYield(c)) {
        yieldMicroUsdTotal += lot.costBasisMicroUsd;
        const y = new Date(c.timestamp * 1000).getUTCFullYear();
        yieldMicroUsdByYear[y] = (yieldMicroUsdByYear[y] ?? 0n) + lot.costBasisMicroUsd;
      }
      continue;
    }

    if (isLotConsumption(c) && c.assetOut) {
      const symbol = c.assetOut.symbol;
      const vaultAddress = c.vaultAddress;
      const decimals = decimalsBySymbol[symbol] ?? 18;
      const decimalsAdj = BigInt(10) ** BigInt(decimals);
      const queue = lots.get(lotKey(symbol, vaultAddress)) ?? [];
      let remaining = BigInt(c.assetOut.amount);
      const priceUsd = c.assetIn?.priceUsd ?? c.assetOut.priceUsd;
      const priceMicro = BigInt(Math.round(priceUsd * 1_000_000));
      // Vault withdraw gains → interestEarned; non-vault disposals → realizedPnl.
      const category: Disposal['category'] = isVaultWithdraw(c)
        ? 'INTEREST_EARNED'
        : 'CAPITAL_GAIN';
      // Proceeds at the event level — see fifo.ts for the NAV!=1 rationale.
      const hasIncomingValue = c.assetIn !== undefined && c.assetIn.amount !== '0';
      let totalProceedsMicro = 0n;
      if (hasIncomingValue) {
        const inSymbol = c.assetIn!.symbol;
        const inDecimals = decimalsBySymbol[inSymbol] ?? 18;
        const inDecimalsAdj = BigInt(10) ** BigInt(inDecimals);
        const inPriceMicro = BigInt(Math.round(c.assetIn!.priceUsd * 1_000_000));
        totalProceedsMicro = (inPriceMicro * BigInt(c.assetIn!.amount)) / inDecimalsAdj;
      }
      let proceedsAllocated = 0n;

      // Walk the LIFO queue from the back (newest lot first).
      while (remaining > 0n && queue.length > 0) {
        const back = queue[queue.length - 1]!;
        const take = remaining < back.amount ? remaining : back.amount;

        // All in REAL micro-USD (1e-6 precision).
        const costBasisConsumedMicro = (back.costBasisMicroUsd * take) / back.amount;
        let proceedsConsumedMicro: bigint;
        if (hasIncomingValue) {
          if (remaining - take === 0n) {
            proceedsConsumedMicro = totalProceedsMicro - proceedsAllocated;
          } else {
            proceedsConsumedMicro =
              (totalProceedsMicro * take) / BigInt(c.assetOut.amount);
          }
          proceedsAllocated += proceedsConsumedMicro;
        } else {
          proceedsConsumedMicro = (priceMicro * take) / decimalsAdj;
        }
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
          disposalPriceUsd: priceUsd,
          lotPriceUsd,
          timestamp: c.timestamp,
          category,
        });
        if (category === 'INTEREST_EARNED') {
          interestEarnedMicroUsdTotal += gainMicro;
          const y = new Date(c.timestamp * 1000).getUTCFullYear();
          interestEarnedMicroUsdByYear[y] = (interestEarnedMicroUsdByYear[y] ?? 0n) + gainMicro;
        } else {
          updatePnl(symbol, gainMicro);
        }

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
    incomeMicroUsdByYear,
    yieldMicroUsdByYear,
    interestEarnedMicroUsdTotal,
    interestEarnedMicroUsdByYear,
    gasMicroUsdTotal,
    priceGaps,
  };
}
