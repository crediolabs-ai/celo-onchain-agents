/**
 * FIFO cost-basis engine.
 *
 * Owner: Credio (pnl-calculator sub-agent).
 *
 * Default cost basis method for Nigeria FIRS and Kenya KRA. Implementation
 * notes:
 *  - Lots are stored in a per-symbol queue, oldest first.
 *  - Disposals consume from the front of the queue.
 *  - When a disposal is larger than the front lot, multiple lots are consumed
 *    and a `Disposal` is emitted per consumed lot (preserves audit trail).
 *  - BigInt amounts and micro-USD preserve precision through the chain.
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

export interface FifoInput {
  /** Classified transactions, ordered by timestamp ascending. */
  classified: ClassifiedTx[];
  /**
   * Token decimals by symbol. Hardcoded defaults for the common Celo tokens;
   * callers can override for non-standard ERC-20s.
   */
  decimalsBySymbol?: Record<string, number>;
  /**
   * Spot price for gas conversion (USD per CELO, decimal). Caller resolves
   * via CoinGecko at the time of the gas tx; FIFO does not fetch prices
   * itself.
   */
  gasPriceUsdByTimestamp?: (timestamp: Timestamp) => number | undefined;
}

export function computeFifo(input: FifoInput): EngineResult {
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
    // ─── Acquisitions ────────────────────────────────────────────────────
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
      // Yield bucket: only non-vault staking-reward YIELD counts as yield
      // income. A vault DEPOSIT (YIELD + vaultAddress) is an acquisition of
      // a share — its cost basis is the lot, not income. The income is
      // realized only at the matching vault WITHDRAW, where the gain
      // routes to `interestEarnedMicroUsdTotal` (see disposal branch below).
      // Fix 2026-06-14: previous behavior added the deposit amount to yield,
      // inflating the yield line for any vault user (e.g. KE 0xBE19 showed
      // $5,374.90 yield for a single $5,374.90 deposit with no disposals).
      if (isStakingRewardYield(c)) {
        yieldMicroUsdTotal += lot.costBasisMicroUsd;
        const y = new Date(c.timestamp * 1000).getUTCFullYear();
        yieldMicroUsdByYear[y] = (yieldMicroUsdByYear[y] ?? 0n) + lot.costBasisMicroUsd;
      }
      continue;
    }

    // ─── Disposals ───────────────────────────────────────────────────────
    // YIELD with assetOut is a vault withdraw (shares surrendered, underlying received).
    // TRANSFER_OUT / SWAP are regular disposals. Both consume from the lot queue.
    if (isLotConsumption(c) && c.assetOut) {
      const symbol = c.assetOut.symbol;
      const vaultAddress = c.vaultAddress;
      const decimals = decimalsBySymbol[symbol] ?? 18;
      const decimalsAdj = BigInt(10) ** BigInt(decimals);
      const queue = lots.get(lotKey(symbol, vaultAddress)) ?? [];
      let remaining = BigInt(c.assetOut.amount);
      // Use assetIn price when available (underlying received on vault withdraw);
      // fall back to assetOut price for non-vault disposals.
      const priceUsd = c.assetIn?.priceUsd ?? c.assetOut.priceUsd;
      const priceMicro = BigInt(Math.round(priceUsd * 1_000_000));
      // Vault withdraw gains are interest income, not capital gains. The
      // gain between the share's cost basis (lot) and the underlying
      // received (assetIn) is what the vault strategy earned as yield.
      // Fix 2026-06-14: previously these gains landed in realizedPnl,
      // conflating interest with capital gains.
      const category: Disposal['category'] = isVaultWithdraw(c)
        ? 'INTEREST_EARNED'
        : 'CAPITAL_GAIN';
      // Proceeds at the event level. For vault WITHDRAW / SWAP, the user
      // received an actual value (assetIn) — proceeds are that value, NOT
      // the share's notional price × share amount. The previous formula
      // (priceMicro × assetOut.amount / decimals) only worked when NAV=1.0;
      // Quan 2026-06-14: a 5K deposit withdrawing 5.3K should report $300
      // interest, not $0.
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

      // Walk the FIFO queue from the front.
      while (remaining > 0n && queue.length > 0) {
        const front = queue[0]!;
        const take = remaining < front.amount ? remaining : front.amount;

        // All in REAL micro-USD (1e-6 precision).
        const costBasisConsumedMicro = (front.costBasisMicroUsd * take) / front.amount;
        let proceedsConsumedMicro: bigint;
        if (hasIncomingValue) {
          // Proportional attribution to take / total assetOut.amount. The
          // last lot takes the remainder so the sum is exactly totalProceeds
          // (no rounding loss across many partials).
          if (remaining - take === 0n) {
            proceedsConsumedMicro = totalProceedsMicro - proceedsAllocated;
          } else {
            proceedsConsumedMicro =
              (totalProceedsMicro * take) / BigInt(c.assetOut.amount);
          }
          proceedsAllocated += proceedsConsumedMicro;
        } else {
          // Pure outflow (TRANSFER_OUT) — use notional market value of
          // disposed shares. No incoming value to attribute to.
          proceedsConsumedMicro = (priceMicro * take) / decimalsAdj;
        }
        const gainMicro = proceedsConsumedMicro - costBasisConsumedMicro;

        const lotPriceUsd = lotPricePerUnitUsd(front);

        disposals.push({
          amount: take,
          symbol,
          proceedsMicroUsd: proceedsConsumedMicro,
          costBasisMicroUsd: costBasisConsumedMicro,
          gainMicroUsd: gainMicro,
          sourceHash: c.hash,
          lotSourceHash: front.sourceHash,
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

        // Update or remove the front lot.
        if (take === front.amount) {
          queue.shift();
        } else {
          const newAmount = front.amount - take;
          const newCostBasis = front.costBasisMicroUsd - costBasisConsumedMicro;
          queue[0] = { ...front, amount: newAmount, costBasisMicroUsd: newCostBasis };
        }
        remaining -= take;
      }

      // If the queue is empty and we still have remaining, the disposal
      // exceeds our cost basis knowledge — this is a price gap we surface.
      if (remaining > 0n) {
        priceGaps.push({ asset: symbol, timestamp: c.timestamp });
      }
      continue;
    }

    // ─── Gas ─────────────────────────────────────────────────────────────
    if (isGas(c)) {
      const resolver = input.gasPriceUsdByTimestamp;
      const price = resolver ? resolver(c.timestamp) : undefined;
      if (price !== undefined) {
        // Gas cost = gasUsed * gasPrice (in wei) → CELO → USD.
        // gasUsed and gasPrice are decimal strings on the classified tx;
        // we don't have them on ClassifiedTx directly. Caller pre-computes
        // and passes via the gasPriceUsdByTimestamp + a hook on ClassifiedTx.
        // For now, treat as 0 if the caller didn't pre-resolve.
        // TODO: thread `gasCostUsd` through `ClassifiedTx` as a separate field.
        gasMicroUsdTotal += 0n;
      } else {
        priceGaps.push({ asset: 'CELO', timestamp: c.timestamp });
      }
      continue;
    }

    // BRIDGE / MENTO_STABILITY / MINT / BURN / UNKNOWN — explicitly skipped
    // for the FIFO PNL. They are flagged in the audit trail by the classifier
    // and surface in the CSV exporter, but do not affect realized PNL.
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
