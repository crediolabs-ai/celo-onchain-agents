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
  isDisposal,
  isGas,
  lotFromAcquisition,
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

    // ─── Disposals ───────────────────────────────────────────────────────
    if (isDisposal(c) && c.assetOut) {
      const symbol = c.assetOut.symbol;
      const decimals = decimalsBySymbol[symbol] ?? 18;
      const decimalsAdj = BigInt(10) ** BigInt(decimals);
      const queue = lots.get(symbol) ?? [];
      let remaining = BigInt(c.assetOut.amount);
      const priceMicro = BigInt(Math.round(c.assetOut.priceUsd * 1_000_000));

      // Walk the FIFO queue from the front.
      while (remaining > 0n && queue.length > 0) {
        const front = queue[0]!;
        const take = remaining < front.amount ? remaining : front.amount;

        // All in REAL micro-USD (1e-6 precision).
        const costBasisConsumedMicro = (front.costBasisMicroUsd * take) / front.amount;
        const proceedsConsumedMicro = (priceMicro * take) / decimalsAdj;
        const gainMicro = proceedsConsumedMicro - costBasisConsumedMicro;

        const lotPriceUsd = lotPricePerUnitUsd(front);
        const disposalPriceUsd = c.assetOut.priceUsd;

        disposals.push({
          amount: take,
          symbol,
          proceedsMicroUsd: proceedsConsumedMicro,
          costBasisMicroUsd: costBasisConsumedMicro,
          gainMicroUsd: gainMicro,
          sourceHash: c.hash,
          lotSourceHash: front.sourceHash,
          disposalPriceUsd,
          lotPriceUsd,
          timestamp: c.timestamp,
        });
        updatePnl(symbol, gainMicro);

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
    gasMicroUsdTotal,
    priceGaps,
  };
}
