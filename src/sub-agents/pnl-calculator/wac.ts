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

import type { Address, ClassifiedTx, Timestamp } from '../../shared/types.js';
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
  lotKey,
  lotPricePerUnitUsd,
} from './engine.js';

export interface WacInput {
  classified: ClassifiedTx[];
  decimalsBySymbol?: Record<string, number>;
  gasPriceUsdByTimestamp?: (timestamp: Timestamp) => number | undefined;
}

/** Single running-average lot per symbol or per-(vault, symbol). */
interface WacState {
  amount: bigint;
  costBasisMicroUsd: bigint;
  decimals: number;
  lastPriceUsd: number;
  lastTimestamp: Timestamp;
  lastSourceHash: import('../../shared/types.js').TxHash;
  /** Vault address for ERC-4626 share tokens. undefined means non-vault (plain symbol). */
  vaultAddress: Address | undefined;
}

export function computeWac(input: WacInput): EngineResult {
  const decimalsBySymbol = { ...DEFAULT_DECIMALS, ...(input.decimalsBySymbol ?? {}) };
  const state: Map<string, WacState> = new Map();
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
      const key = lotKey(symbol, vaultAddress);
      const decimals = decimalsBySymbol[symbol] ?? 18;
      const decimalsAdj = BigInt(10) ** BigInt(decimals);
      const amount = BigInt(c.assetIn.amount);
      // REAL micro-USD for the lot (not micro-USD × wei).
      const costMicro =
        (BigInt(Math.round(c.assetIn.priceUsd * 1_000_000)) * amount) / decimalsAdj;
      const cur = state.get(key);

      if (!cur || cur.amount === 0n) {
        state.set(key, {
          amount,
          costBasisMicroUsd: costMicro,
          decimals,
          lastPriceUsd: c.assetIn.priceUsd,
          lastTimestamp: c.timestamp,
          lastSourceHash: c.hash,
          vaultAddress,
        });
      } else {
        state.set(key, {
          amount: cur.amount + amount,
          costBasisMicroUsd: cur.costBasisMicroUsd + costMicro,
          decimals: cur.decimals,
          lastPriceUsd: c.assetIn.priceUsd,
          lastTimestamp: c.timestamp,
          lastSourceHash: c.hash,
          vaultAddress: cur.vaultAddress,
        });
      }
      if (c.type === 'INCOME') {
        incomeMicroUsdTotal += costMicro;
        const y = new Date(c.timestamp * 1000).getUTCFullYear();
        incomeMicroUsdByYear[y] = (incomeMicroUsdByYear[y] ?? 0n) + costMicro;
      }
      // Fix 2026-06-14: only non-vault staking-reward YIELD counts as yield.
      // See fifo.ts for full rationale.
      if (isStakingRewardYield(c)) {
        yieldMicroUsdTotal += costMicro;
        const y = new Date(c.timestamp * 1000).getUTCFullYear();
        yieldMicroUsdByYear[y] = (yieldMicroUsdByYear[y] ?? 0n) + costMicro;
      }
      continue;
    }

    if (isLotConsumption(c) && c.assetOut) {
      const symbol = c.assetOut.symbol;
      const vaultAddress = c.vaultAddress;
      const key = lotKey(symbol, vaultAddress);
      const cur = state.get(key);
      if (!cur || cur.amount === 0n) {
        priceGaps.push({ asset: symbol, timestamp: c.timestamp });
        continue;
      }
      const decimals = decimalsBySymbol[symbol] ?? 18;
      const decimalsAdj = BigInt(10) ** BigInt(decimals);
      const sellAmount = BigInt(c.assetOut.amount);
      // Use assetIn price when available (underlying received on vault withdraw);
      // fall back to assetOut price for non-vault disposals.
      const priceUsd = c.assetIn?.priceUsd ?? c.assetOut.priceUsd;
      const priceMicro = BigInt(Math.round(priceUsd * 1_000_000));
      const take = sellAmount < cur.amount ? sellAmount : cur.amount;
      // Compute consumed cost basis in a single bigint step to avoid
      // losing precision to integer truncation. costBasisConsumedMicro is
      // in real micro-USD.
      const costBasisConsumedMicro = (cur.costBasisMicroUsd * take) / cur.amount;
      const remainingAmount = cur.amount - take;
      const remainingCost = cur.costBasisMicroUsd - costBasisConsumedMicro;
      const lotPriceUsd = lotPricePerUnitUsd(cur);
      // Vault withdraw gains → interestEarned; non-vault disposals → realizedPnl.
      const category: Disposal['category'] = isVaultWithdraw(c)
        ? 'INTEREST_EARNED'
        : 'CAPITAL_GAIN';
      // Proceeds at the event level — see fifo.ts for the NAV!=1 rationale.
      // WAC disposes in a single take from the running-average pool, so the
      // proportional attribution simplifies to "proceeds = incoming value
      // for vault withdraw, otherwise notional".
      let proceedsConsumedMicro: bigint;
      const hasIncomingValue = c.assetIn !== undefined && c.assetIn.amount !== '0';
      if (hasIncomingValue) {
        const inSymbol = c.assetIn!.symbol;
        const inDecimals = decimalsBySymbol[inSymbol] ?? 18;
        const inDecimalsAdj = BigInt(10) ** BigInt(inDecimals);
        const inPriceMicro = BigInt(Math.round(c.assetIn!.priceUsd * 1_000_000));
        proceedsConsumedMicro =
          (inPriceMicro * BigInt(c.assetIn!.amount)) / inDecimalsAdj;
      } else {
        proceedsConsumedMicro = (priceMicro * take) / decimalsAdj;
      }
      const gainMicro = proceedsConsumedMicro - costBasisConsumedMicro;

      disposals.push({
        amount: take,
        symbol,
        proceedsMicroUsd: proceedsConsumedMicro,
        costBasisMicroUsd: costBasisConsumedMicro,
        gainMicroUsd: gainMicro,
        sourceHash: c.hash,
        lotSourceHash: cur.lastSourceHash,
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

      // If the disposal exceeds our pool, surface a price gap (parity with FIFO/LIFO).
      if (sellAmount > cur.amount) {
        priceGaps.push({ asset: symbol, timestamp: c.timestamp });
      }

      state.set(key, {
        amount: remainingAmount,
        costBasisMicroUsd: remainingCost,
        decimals: cur.decimals,
        lastPriceUsd: cur.lastPriceUsd,
        lastTimestamp: cur.lastTimestamp,
        lastSourceHash: cur.lastSourceHash,
        vaultAddress: cur.vaultAddress,
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
  // Fully-consumed pools (s.amount === 0n) emit an empty array so the key
  // is present in the map — matches FIFO/LIFO behavior where consumed
  // queues remain as `[]` and lets callers uniformly check for emptiness.
  const remainingLots: Map<string, AssetLot[]> = new Map();
  for (const [key, s] of state) {
    if (s.amount === 0n) {
      remainingLots.set(key, []);
      continue;
    }
    // key is lotKey(symbol, vaultAddress) — extract symbol for the Map value.
    remainingLots.set(key, [
      {
        amount: s.amount,
        costBasisMicroUsd: s.costBasisMicroUsd,
        symbol: key.includes(':') ? key.split(':')[1]! : key,
        decimals: s.decimals,
        timestamp: s.lastTimestamp,
        sourceHash: s.lastSourceHash,
        source: 'rule', // provenance is lost under WAC; default to 'rule'
        ...(s.vaultAddress !== undefined ? { vaultAddress: s.vaultAddress } : {}),
      },
    ]);
  }

  return {
    disposals,
    remainingLots,
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
