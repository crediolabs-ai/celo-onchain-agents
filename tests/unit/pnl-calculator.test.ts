/**
 * Unit tests for the PNL calculator sub-agent.
 *
 * Owner: Credio (pnl-calculator).
 *
 * Coverage:
 *   - FIFO:        in-order consumption, multi-lot disposal, partial lot, price gap
 *   - LIFO:        newest-first consumption, multi-lot disposal
 *   - WAC:         running average re-prices the pool, disposal vs average
 *   - bucketByYear: year-bucketing of disposals
 *   - methodJurisdictionCompat: illegal-combo flagging
 *   - computePnl:  end-to-end entrypoint shape and year summary math
 */

import { describe, expect, it } from 'vitest';
import type { Address, ClassifiedTx, Timestamp } from '../../src/shared/types.js';
import { computeFifo } from '../../src/sub-agents/pnl-calculator/fifo.js';
import { computeLifo } from '../../src/sub-agents/pnl-calculator/lifo.js';
import { computeWac } from '../../src/sub-agents/pnl-calculator/wac.js';
import {
  computePnl,
  methodJurisdictionCompat,
} from '../../src/sub-agents/pnl-calculator/index.js';
import { mkHash } from '../fixtures/mk-hash.js';

// ─── Fixtures ──────────────────────────────────────────────────────────────

const ADDR = '0x000000000000000000000000000000000000dead' as Address;
const TS_2024 = 1_704_067_200 as Timestamp; // 2024-01-01 00:00:00 UTC
const TS_2024_MID = 1_716_662_400 as Timestamp; // 2024-05-15 (mid-year)
const TS_2024_LATE = 1_725_187_200 as Timestamp; // 2024-09-01

function mkAcquisition(overrides: {
  symbol?: string;
  amount: string;
  priceUsd: number;
  timestamp: Timestamp;
  source?: 'rule' | 'llm' | 'flagged';
  type?: 'INCOME' | 'TRANSFER_IN' | 'YIELD';
  vaultAddress?: Address;
}): ClassifiedTx {
  const hash = mkHash();
  return {
    hash,
    timestamp: overrides.timestamp,
    type: overrides.type ?? 'TRANSFER_IN',
    assetIn: {
      symbol: overrides.symbol ?? 'CELO',
      amount: overrides.amount,
      priceUsd: overrides.priceUsd,
    },
    classifierSource: overrides.source ?? 'rule',
    ...(overrides.vaultAddress !== undefined ? { vaultAddress: overrides.vaultAddress } : {}),
  };
}

function mkDisposal(overrides: {
  symbol?: string;
  amount: string;
  priceUsd: number;
  timestamp: Timestamp;
  type?: 'TRANSFER_OUT' | 'SWAP';
  vaultAddress?: Address;
  assetInSymbol?: string;
  assetInPriceUsd?: number;
}): ClassifiedTx {
  const hash = mkHash();
  const base: ClassifiedTx = {
    hash,
    timestamp: overrides.timestamp,
    type: overrides.type ?? 'TRANSFER_OUT',
    assetOut: {
      symbol: overrides.symbol ?? 'CELO',
      amount: overrides.amount,
      priceUsd: overrides.priceUsd,
    },
    classifierSource: 'rule',
  };
  if (overrides.assetInSymbol !== undefined) {
    base.assetIn = {
      symbol: overrides.assetInSymbol,
      amount: overrides.amount,
      priceUsd: overrides.assetInPriceUsd ?? 1.0,
    };
  }
  if (overrides.vaultAddress !== undefined) {
    base.vaultAddress = overrides.vaultAddress;
  }
  return base;
}

function mkGas(timestamp: Timestamp): ClassifiedTx {
  return { hash: mkHash(), timestamp, type: 'GAS', classifierSource: 'rule' };
}

// CELO is 18 decimals, so 1 CELO = 1_000_000_000_000_000_000n (1e18).
const ONE_CELO = '1000000000000000000';
const HALF_CELO = '500000000000000000';
const TWO_CELO = '2000000000000000000';
const QUARTER_CELO = '250000000000000000';
// 2.5 CELO = 2.5 × 1e18 — must be bigint-added, not string-concatenated,
// because 2e18 + 5e17 has overlapping zero prefixes that concat breaks.
const TWO_AND_HALF_CELO = (BigInt(TWO_CELO) + BigInt(HALF_CELO)).toString();

// ─── FIFO ──────────────────────────────────────────────────────────────────

describe('FIFO', () => {
  it('consumes a single full lot in order', () => {
    const result = computeFifo({
      classified: [
        mkAcquisition({ amount: ONE_CELO, priceUsd: 0.5, timestamp: TS_2024 }),
        mkDisposal({ amount: ONE_CELO, priceUsd: 0.8, timestamp: TS_2024_MID }),
      ],
    });

    expect(result.disposals).toHaveLength(1);
    const d = result.disposals[0]!;
    expect(d.amount).toBe(BigInt(ONE_CELO));
    // All values are in REAL micro-USD (1e-6 USD).
    expect(d.proceedsMicroUsd).toBe(800_000n);
    expect(d.costBasisMicroUsd).toBe(500_000n);
    expect(d.gainMicroUsd).toBe(300_000n);
    expect(result.realizedPnlMicroUsdByAsset['CELO']).toBe(300_000n);
    expect(result.remainingLots.get('CELO')).toEqual([]);
  });

  it('consumes multiple lots in order when disposal spans them', () => {
    const result = computeFifo({
      classified: [
        mkAcquisition({ amount: ONE_CELO, priceUsd: 0.4, timestamp: TS_2024 }),
        mkAcquisition({ amount: ONE_CELO, priceUsd: 0.6, timestamp: TS_2024_MID }),
        mkAcquisition({ amount: ONE_CELO, priceUsd: 0.9, timestamp: TS_2024_LATE }),
        // Sell 2.5 CELO at 1.0 → consumes 1.0 of lot1 + 1.0 of lot2 + 0.5 of lot3
        mkDisposal({ amount: TWO_AND_HALF_CELO, priceUsd: 1.0, timestamp: TS_2024_LATE + 1 }),
      ],
    });

    expect(result.disposals).toHaveLength(3);

    // Lot 1: 1 CELO @ 0.4 → proceeds 1.0, cost 0.4, gain 0.6
    const d1 = result.disposals[0]!;
    expect(d1.amount).toBe(BigInt(ONE_CELO));
    expect(d1.gainMicroUsd).toBe(600_000n);

    // Lot 2: 1 CELO @ 0.6 → proceeds 1.0, cost 0.6, gain 0.4
    const d2 = result.disposals[1]!;
    expect(d2.amount).toBe(BigInt(ONE_CELO));
    expect(d2.gainMicroUsd).toBe(400_000n);

    // Lot 3 partial: 0.5 CELO @ 0.9 → proceeds 0.5, cost 0.45, gain 0.05
    const d3 = result.disposals[2]!;
    expect(d3.amount).toBe(BigInt(HALF_CELO));
    expect(d3.gainMicroUsd).toBe(50_000n);

    // Total gain = 0.6 + 0.4 + 0.05 = 1.05 USD, in micro-USD
    expect(result.realizedPnlMicroUsdByAsset['CELO']).toBe(1_050_000n);

    // Half a lot left in the third slot.
    const remaining = result.remainingLots.get('CELO')!;
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.amount).toBe(BigInt(HALF_CELO));
  });

  it('handles a partial lot disposal cleanly', () => {
    const result = computeFifo({
      classified: [
        mkAcquisition({ amount: ONE_CELO, priceUsd: 0.5, timestamp: TS_2024 }),
        mkDisposal({ amount: QUARTER_CELO, priceUsd: 0.7, timestamp: TS_2024_MID }),
      ],
    });

    expect(result.disposals).toHaveLength(1);
    expect(result.disposals[0]!.amount).toBe(BigInt(QUARTER_CELO));
    // 0.25 CELO @ $0.7 = $0.175
    expect(result.disposals[0]!.proceedsMicroUsd).toBe(175_000n);
    // 0.25 CELO consumed cost basis = 1.0 * 0.25 = $0.125 (real micro-USD)
    expect(result.disposals[0]!.costBasisMicroUsd).toBe(125_000n);
    const remaining = result.remainingLots.get('CELO')!;
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.amount).toBe(BigInt(ONE_CELO) - BigInt(QUARTER_CELO));
  });

  it('records a price gap when disposal exceeds known cost basis', () => {
    const result = computeFifo({
      classified: [
        mkAcquisition({ amount: ONE_CELO, priceUsd: 0.5, timestamp: TS_2024 }),
        // Sell 2 CELO when only 1 is on the books.
        mkDisposal({ amount: TWO_CELO, priceUsd: 1.0, timestamp: TS_2024_MID }),
      ],
    });

    expect(result.disposals).toHaveLength(1);
    expect(result.disposals[0]!.amount).toBe(BigInt(ONE_CELO));
    expect(result.priceGaps).toEqual([{ asset: 'CELO', timestamp: TS_2024_MID }]);
  });

  it('counts INCOME and YIELD totals separately from gains', () => {
    const result = computeFifo({
      classified: [
        { ...mkAcquisition({ amount: ONE_CELO, priceUsd: 1.0, timestamp: TS_2024 }), type: 'INCOME' },
        { ...mkAcquisition({ amount: ONE_CELO, priceUsd: 1.0, timestamp: TS_2024_MID }), type: 'YIELD' },
        mkDisposal({ amount: ONE_CELO, priceUsd: 1.5, timestamp: TS_2024_LATE }),
      ],
    });

    // 2 income/yield events at 1.0 USD each, in real micro-USD.
    expect(result.incomeMicroUsdTotal).toBe(1_000_000n);
    expect(result.yieldMicroUsdTotal).toBe(1_000_000n);
    // 1 disposal gain of 0.5 USD.
    expect(result.realizedPnlMicroUsdByAsset['CELO']).toBe(500_000n);
  });

  // ─── ERC-4626 vault regression tests ───────────────────────────────────

  const VAULT_A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa0001' as Address;
  const VAULT_B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb0001' as Address;
  // 1 share = 1e6 (USDC decimals)
  const ONE_USDC_VAULT = '1000000';
  const TWO_USDC_VAULT = '2000000';

  it('FIFO: two deposits into same vault create two separate lots', () => {
    const result = computeFifo({
      classified: [
        mkAcquisition({ symbol: 'USDyc', amount: ONE_USDC_VAULT, priceUsd: 1.0, timestamp: TS_2024, vaultAddress: VAULT_A }),
        mkAcquisition({ symbol: 'USDyc', amount: ONE_USDC_VAULT, priceUsd: 1.1, timestamp: TS_2024_MID, vaultAddress: VAULT_A }),
      ],
    });
    // Two lots queued under the per-vault key.
    const queue = result.remainingLots.get(`${VAULT_A}:USDyc`);
    expect(queue).toHaveLength(2);
    // Each lot kept its own cost basis.
    expect(queue![0]!.costBasisMicroUsd).toBe(1_000_000n);
    expect(queue![1]!.costBasisMicroUsd).toBe(1_100_000n);
  });

  it('FIFO: two deposits into DIFFERENT vaults stay in separate queues (same symbol)', () => {
    const result = computeFifo({
      classified: [
        mkAcquisition({ symbol: 'USDyc', amount: ONE_USDC_VAULT, priceUsd: 1.0, timestamp: TS_2024, vaultAddress: VAULT_A }),
        mkAcquisition({ symbol: 'USDyc', amount: ONE_USDC_VAULT, priceUsd: 1.1, timestamp: TS_2024_MID, vaultAddress: VAULT_B }),
      ],
    });
    const queueA = result.remainingLots.get(`${VAULT_A}:USDyc`);
    const queueB = result.remainingLots.get(`${VAULT_B}:USDyc`);
    expect(queueA).toHaveLength(1);
    expect(queueB).toHaveLength(1);
    expect(queueA![0]!.costBasisMicroUsd).toBe(1_000_000n);
    expect(queueB![0]!.costBasisMicroUsd).toBe(1_100_000n);
    // No merged "USDyc" key.
    expect(result.remainingLots.get('USDyc')).toBeUndefined();
  });

  it('FIFO: withdraw from vault A consumes only vault A lots, not vault B', () => {
    const result = computeFifo({
      classified: [
        mkAcquisition({ symbol: 'USDyc', amount: ONE_USDC_VAULT, priceUsd: 1.0, timestamp: TS_2024, vaultAddress: VAULT_A }),
        mkAcquisition({ symbol: 'USDyc', amount: TWO_USDC_VAULT, priceUsd: 1.0, timestamp: TS_2024_MID, vaultAddress: VAULT_B }),
        // Withdraw from vault A — consumes 1 lot from vault A only.
        {
          ...mkDisposal({ symbol: 'USDyc', amount: ONE_USDC_VAULT, priceUsd: 1.0, timestamp: TS_2024_LATE, vaultAddress: VAULT_A }),
          assetIn: { symbol: 'USDC', amount: ONE_USDC_VAULT, priceUsd: 1.0 },
        },
      ],
    });
    // Vault A queue is now empty; vault B is untouched.
    expect(result.remainingLots.get(`${VAULT_A}:USDyc`)).toHaveLength(0);
    expect(result.remainingLots.get(`${VAULT_B}:USDyc`)).toHaveLength(1);
    expect(result.disposals).toHaveLength(1);
    expect(result.disposals[0]!.gainMicroUsd).toBe(0n); // 1:1 vault
  });

  it('FIFO: vault withdraw as YIELD disposal — the previously-silent YIELD-skip bug is fixed', () => {
    // Before the fix, YIELD with assetOut was silently skipped. Now it produces a real Disposal.
    const result = computeFifo({
      classified: [
        mkAcquisition({ symbol: 'USDyc', amount: ONE_USDC_VAULT, priceUsd: 1.0, timestamp: TS_2024, vaultAddress: VAULT_A }),
        // Vault withdraw classified as YIELD (per protocolActionToTxType mapping).
        // assetIn = underlying (USDC received), assetOut = shares (USDyc surrendered).
        {
          hash: mkHash(),
          timestamp: TS_2024_MID,
          type: 'YIELD',
          assetIn: { symbol: 'USDC', amount: ONE_USDC_VAULT, priceUsd: 1.0 },
          assetOut: { symbol: 'USDyc', amount: ONE_USDC_VAULT, priceUsd: 1.0 },
          classifierSource: 'rule',
          vaultAddress: VAULT_A,
        },
      ],
    });
    expect(result.disposals).toHaveLength(1);
    const d = result.disposals[0]!;
    // Proceeds = USDC received (assetIn.priceUsd = 1.0), cost basis = USDyc paid.
    expect(d.proceedsMicroUsd).toBe(1_000_000n);
    expect(d.costBasisMicroUsd).toBe(1_000_000n);
    expect(d.gainMicroUsd).toBe(0n);
    // Vault A queue fully consumed.
    expect(result.remainingLots.get(`${VAULT_A}:USDyc`)).toHaveLength(0);
  });

  it('FIFO: existing non-vault lots are unaffected (no vaultAddress → plain symbol key)', () => {
    const result = computeFifo({
      classified: [
        mkAcquisition({ symbol: 'CELO', amount: ONE_CELO, priceUsd: 0.5, timestamp: TS_2024 }),
        mkDisposal({ symbol: 'CELO', amount: ONE_CELO, priceUsd: 0.8, timestamp: TS_2024_MID }),
      ],
    });
    expect(result.disposals).toHaveLength(1);
    expect(result.disposals[0]!.gainMicroUsd).toBe(300_000n);
    expect(result.remainingLots.get('CELO')).toHaveLength(0);
  });

  // Plan §8.3 mandate: staking-reward YIELD (assetIn only, no assetOut) must
  // still be income, not a disposal. The isAcquisition() tightening in
  // engine.ts:140 must not regress this path.
  it('FIFO: staking-reward YIELD (assetIn only, no assetOut) is income, not disposal', () => {
    const result = computeFifo({
      classified: [
        // Staking reward: YIELD with only assetIn (no assetOut) — pure income.
        {
          hash: mkHash(),
          timestamp: TS_2024,
          type: 'YIELD',
          assetIn: { symbol: 'G$', amount: '1000000000000000000', priceUsd: 0.001 },
          classifierSource: 'rule',
        },
      ],
    });
    // No disposals — staking reward is income, not a lot-consuming event.
    expect(result.disposals).toHaveLength(0);
    // yieldMicroUsdTotal = 0.001 * 1 G$ = 0.001 USD = 1_000 micro-USD.
    expect(result.yieldMicroUsdTotal).toBe(1_000n);
    // The G$ lot is queued under the plain symbol (no vaultAddress).
    expect(result.remainingLots.get('G$')).toHaveLength(1);
  });

  // Defensive default: YIELD with assetOut but no assetIn is treated as a
  // disposal (vault-withdraw edge case where the underlying transfer wasn't
  // picked up by the classifier). Pinning the behavior so it doesn't drift.
  it('FIFO: YIELD with assetOut only (no assetIn) is treated as a disposal', () => {
    const result = computeFifo({
      classified: [
        mkAcquisition({ symbol: 'USDyc', amount: ONE_USDC_VAULT, priceUsd: 1.0, timestamp: TS_2024, vaultAddress: VAULT_A }),
        // YIELD with only assetOut (assetIn missing) — defensive disposal.
        {
          hash: mkHash(),
          timestamp: TS_2024_MID,
          type: 'YIELD',
          assetOut: { symbol: 'USDyc', amount: ONE_USDC_VAULT, priceUsd: 1.0 },
          classifierSource: 'rule',
          vaultAddress: VAULT_A,
        },
      ],
    });
    expect(result.disposals).toHaveLength(1);
    // Falls through to assetOut.priceUsd (assetIn is undefined).
    expect(result.disposals[0]!.proceedsMicroUsd).toBe(1_000_000n);
    expect(result.disposals[0]!.costBasisMicroUsd).toBe(1_000_000n);
    expect(result.disposals[0]!.gainMicroUsd).toBe(0n);
    expect(result.remainingLots.get(`${VAULT_A}:USDyc`)).toHaveLength(0);
  });
});

// ─── LIFO ──────────────────────────────────────────────────────────────────

describe('LIFO', () => {
  it('consumes the newest lot first, not the oldest', () => {
    const result = computeLifo({
      classified: [
        mkAcquisition({ amount: ONE_CELO, priceUsd: 0.4, timestamp: TS_2024 }),
        mkAcquisition({ amount: ONE_CELO, priceUsd: 0.9, timestamp: TS_2024_LATE }),
        // Sell 1 CELO at 1.0 → LIFO consumes lot 2 (0.9) first, gain = 0.1
        mkDisposal({ amount: ONE_CELO, priceUsd: 1.0, timestamp: TS_2024_LATE + 1 }),
      ],
    });

    expect(result.disposals).toHaveLength(1);
    const d = result.disposals[0]!;
    // Cost basis from lot 2 (newest), not lot 1. Real micro-USD.
    expect(d.costBasisMicroUsd).toBe(900_000n);
    expect(d.gainMicroUsd).toBe(100_000n);
    // Remaining is lot 1.
    const remaining = result.remainingLots.get('CELO')!;
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.amount).toBe(BigInt(ONE_CELO));
  });

  it('spans multiple lots in reverse order', () => {
    const result = computeLifo({
      classified: [
        mkAcquisition({ amount: ONE_CELO, priceUsd: 0.4, timestamp: TS_2024 }),
        mkAcquisition({ amount: ONE_CELO, priceUsd: 0.6, timestamp: TS_2024_MID }),
        mkAcquisition({ amount: ONE_CELO, priceUsd: 0.9, timestamp: TS_2024_LATE }),
        // Sell 2.5 CELO at 1.0 → LIFO: lot3 (1.0) + lot2 (1.0) + lot1 partial (0.5)
        mkDisposal({ amount: TWO_AND_HALF_CELO, priceUsd: 1.0, timestamp: TS_2024_LATE + 1 }),
      ],
    });

    expect(result.disposals).toHaveLength(3);
    // Newest first: lot3 fully (cost 0.9, gain 0.1)
    expect(result.disposals[0]!.gainMicroUsd).toBe(100_000n);
    // Then lot2 (cost 0.6, gain 0.4)
    expect(result.disposals[1]!.gainMicroUsd).toBe(400_000n);
    // Then lot1 partial 0.5 (cost 0.2, gain 0.3)
    expect(result.disposals[2]!.gainMicroUsd).toBe(300_000n);

    // Remaining: 0.5 CELO of lot1 left.
    const remaining = result.remainingLots.get('CELO')!;
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.amount).toBe(BigInt(HALF_CELO));
  });

  // ─── ERC-4626 vault regression tests ───────────────────────────────────

  const VAULT_A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa0001' as Address;
  const VAULT_B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb0001' as Address;
  const ONE_USDC_VAULT = '1000000';

  it('LIFO: two deposits into DIFFERENT vaults stay in separate queues', () => {
    const result = computeLifo({
      classified: [
        mkAcquisition({ symbol: 'USDyc', amount: ONE_USDC_VAULT, priceUsd: 1.0, timestamp: TS_2024, vaultAddress: VAULT_A }),
        mkAcquisition({ symbol: 'USDyc', amount: ONE_USDC_VAULT, priceUsd: 1.1, timestamp: TS_2024_MID, vaultAddress: VAULT_B }),
      ],
    });
    const queueA = result.remainingLots.get(`${VAULT_A}:USDyc`);
    const queueB = result.remainingLots.get(`${VAULT_B}:USDyc`);
    expect(queueA).toHaveLength(1);
    expect(queueB).toHaveLength(1);
  });

  it('LIFO: vault withdraw consumes newest lot from that vault only', () => {
    const result = computeLifo({
      classified: [
        mkAcquisition({ symbol: 'USDyc', amount: ONE_USDC_VAULT, priceUsd: 1.0, timestamp: TS_2024, vaultAddress: VAULT_A }),
        mkAcquisition({ symbol: 'USDyc', amount: ONE_USDC_VAULT, priceUsd: 1.2, timestamp: TS_2024_MID, vaultAddress: VAULT_A }),
        // Withdraw from vault A — LIFO consumes newest lot first (price 1.2).
        {
          ...mkDisposal({ symbol: 'USDyc', amount: ONE_USDC_VAULT, priceUsd: 1.0, timestamp: TS_2024_LATE, vaultAddress: VAULT_A }),
          assetIn: { symbol: 'USDC', amount: ONE_USDC_VAULT, priceUsd: 1.0 },
        },
      ],
    });
    expect(result.remainingLots.get(`${VAULT_A}:USDyc`)).toHaveLength(1);
    // Older lot (1.0) remains; newer lot (1.2) was consumed.
    expect(result.remainingLots.get(`${VAULT_A}:USDyc`)![0]!.costBasisMicroUsd).toBe(1_000_000n);
    expect(result.disposals).toHaveLength(1);
    expect(result.disposals[0]!.costBasisMicroUsd).toBe(1_200_000n); // newest lot consumed
    expect(result.disposals[0]!.gainMicroUsd).toBe(-200_000n); // paid 1.2, received 1.0
  });
});

// ─── WAC ───────────────────────────────────────────────────────────────────

describe('WAC', () => {
  it('computes a running average and uses it for disposals', () => {
    const result = computeWac({
      classified: [
        mkAcquisition({ amount: ONE_CELO, priceUsd: 0.4, timestamp: TS_2024 }),
        mkAcquisition({ amount: ONE_CELO, priceUsd: 0.8, timestamp: TS_2024_MID }),
        // Sell 1 CELO at 1.0. Average cost = (0.4 + 0.8) / 2 = 0.6; gain = 0.4.
        mkDisposal({ amount: ONE_CELO, priceUsd: 1.0, timestamp: TS_2024_LATE }),
      ],
    });

    expect(result.disposals).toHaveLength(1);
    const d = result.disposals[0]!;
    // Average cost consumed: 0.6 USD = 600_000 micro-USD (real).
    expect(d.costBasisMicroUsd).toBe(600_000n);
    expect(d.gainMicroUsd).toBe(400_000n);

    const remaining = result.remainingLots.get('CELO')!;
    expect(remaining).toHaveLength(1);
    // 1 CELO left at the average 0.6 USD = 600_000 micro-USD.
    expect(remaining[0]!.amount).toBe(BigInt(ONE_CELO));
    expect(remaining[0]!.costBasisMicroUsd).toBe(600_000n);
  });

  it('records a price gap when disposal exceeds the pool', () => {
    const result = computeWac({
      classified: [
        mkAcquisition({ amount: ONE_CELO, priceUsd: 0.5, timestamp: TS_2024 }),
        mkDisposal({ amount: TWO_CELO, priceUsd: 1.0, timestamp: TS_2024_MID }),
      ],
    });

    expect(result.disposals).toHaveLength(1);
    expect(result.disposals[0]!.amount).toBe(BigInt(ONE_CELO));
    expect(result.priceGaps).toEqual([{ asset: 'CELO', timestamp: TS_2024_MID }]);
  });

  // ─── ERC-4626 vault regression tests ───────────────────────────────────

  const VAULT_A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa0001' as Address;
  const VAULT_B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb0001' as Address;
  const ONE_USDC_VAULT = '1000000';

  it('WAC: two deposits into different vaults maintain separate running averages', () => {
    const result = computeWac({
      classified: [
        mkAcquisition({ symbol: 'USDyc', amount: ONE_USDC_VAULT, priceUsd: 1.0, timestamp: TS_2024, vaultAddress: VAULT_A }),
        mkAcquisition({ symbol: 'USDyc', amount: ONE_USDC_VAULT, priceUsd: 1.2, timestamp: TS_2024_MID, vaultAddress: VAULT_B }),
      ],
    });
    const poolA = result.remainingLots.get(`${VAULT_A}:USDyc`);
    const poolB = result.remainingLots.get(`${VAULT_B}:USDyc`);
    expect(poolA).toHaveLength(1);
    expect(poolB).toHaveLength(1);
    // Vault A avg = 1.0, Vault B avg = 1.2
    expect(poolA![0]!.costBasisMicroUsd).toBe(1_000_000n);
    expect(poolB![0]!.costBasisMicroUsd).toBe(1_200_000n);
  });

  it('WAC: vault withdraw disposes against only that vault\'s pool', () => {
    const result = computeWac({
      classified: [
        mkAcquisition({ symbol: 'USDyc', amount: ONE_USDC_VAULT, priceUsd: 1.0, timestamp: TS_2024, vaultAddress: VAULT_A }),
        mkAcquisition({ symbol: 'USDyc', amount: ONE_USDC_VAULT, priceUsd: 1.0, timestamp: TS_2024_MID, vaultAddress: VAULT_B }),
        // Withdraw from vault A only — should consume vault A's 1.0 avg lot, vault B untouched.
        {
          ...mkDisposal({ symbol: 'USDyc', amount: ONE_USDC_VAULT, priceUsd: 1.0, timestamp: TS_2024_LATE, vaultAddress: VAULT_A }),
          assetIn: { symbol: 'USDC', amount: ONE_USDC_VAULT, priceUsd: 1.0 },
        },
      ],
    });
    expect(result.remainingLots.get(`${VAULT_A}:USDyc`)).toHaveLength(0); // consumed
    expect(result.remainingLots.get(`${VAULT_B}:USDyc`)).toHaveLength(1); // untouched
    expect(result.disposals).toHaveLength(1);
    expect(result.disposals[0]!.gainMicroUsd).toBe(0n);
  });
});

// ─── methodJurisdictionCompat ──────────────────────────────────────────────

describe('methodJurisdictionCompat', () => {
  it('blocks LIFO under NG FIRS', () => {
    const entries = methodJurisdictionCompat('LIFO', 2024, 'NG');
    const ng = entries.find((e) => e.jurisdiction === 'NG')!;
    expect(ng.ok).toBe(false);
    expect(ng.reason).toMatch(/FIFO/i);
  });

  it('allows FIFO under NG FIRS but flags it as the legal default', () => {
    const entries = methodJurisdictionCompat('FIFO', 2024, 'NG');
    const ng = entries.find((e) => e.jurisdiction === 'NG')!;
    expect(ng.ok).toBe(true);
    expect(ng.reason).toMatch(/legally required/i);
  });

  it('permits WAC under OTHER jurisdictions without comment', () => {
    const entries = methodJurisdictionCompat('WAC', 2024, 'OTHER');
    const other = entries.find((e) => e.jurisdiction === 'OTHER')!;
    expect(other.ok).toBe(true);
    expect(other.reason).toBeUndefined();
  });

  it('returns one entry per jurisdiction (NG, KE, OTHER)', () => {
    const entries = methodJurisdictionCompat('FIFO', 2024);
    expect(entries.map((e) => e.jurisdiction).sort()).toEqual(['KE', 'NG', 'OTHER']);
  });
});

// ─── computePnl end-to-end ────────────────────────────────────────────────

describe('computePnl', () => {
  it('returns the right year-summary math for a FIFO scenario', async () => {
    const out = await computePnl({
      address: ADDR,
      method: 'FIFO',
      taxYear: 2024,
      classified: [
        { ...mkAcquisition({ amount: ONE_CELO, priceUsd: 1.0, timestamp: TS_2024 }), type: 'INCOME' },
        { ...mkAcquisition({ amount: ONE_CELO, priceUsd: 1.0, timestamp: TS_2024_MID }), type: 'YIELD' },
        mkDisposal({ amount: ONE_CELO, priceUsd: 1.5, timestamp: TS_2024_LATE }),
        mkGas(TS_2024_LATE),
      ],
    });

    expect(out.method).toBe('FIFO');
    expect(out.address).toBe(ADDR);
    expect(out.incomeTotal).toBe(1.0);
    expect(out.yieldTotal).toBe(1.0);

    const y2024 = out.taxYears.find((y) => y.year === 2024)!;
    expect(y2024).toBeDefined();
    expect(y2024.income).toBe(1.0);
    expect(y2024.yield).toBe(1.0);
    // Realized gain = (1.5 - 1.0) = 0.5
    expect(y2024.realizedGains).toBeCloseTo(0.5, 6);
    // Taxable income = income + realizedGains - deductibleGas (gas is 0 here)
    expect(y2024.taxableIncome).toBeCloseTo(1.5, 6);

    // MethodJurisdictionCompat is always populated.
    expect(out.methodJurisdictionCompat).toHaveLength(3);
  });

  it('routes to the LIFO engine when method=LIFO', async () => {
    const out = await computePnl({
      address: ADDR,
      method: 'LIFO',
      taxYear: 2024,
      classified: [
        mkAcquisition({ amount: ONE_CELO, priceUsd: 0.4, timestamp: TS_2024 }),
        mkAcquisition({ amount: ONE_CELO, priceUsd: 0.9, timestamp: TS_2024_LATE }),
        mkDisposal({ amount: ONE_CELO, priceUsd: 1.0, timestamp: TS_2024_LATE + 1 }),
      ],
    });

    // LIFO picks the 0.9 lot → gain = 0.1
    const y2024 = out.taxYears.find((y) => y.year === 2024)!;
    expect(y2024.realizedGains).toBeCloseTo(0.1, 6);
  });

  it('routes to the WAC engine when method=WAC', async () => {
    const out = await computePnl({
      address: ADDR,
      method: 'WAC',
      taxYear: 2024,
      classified: [
        mkAcquisition({ amount: ONE_CELO, priceUsd: 0.4, timestamp: TS_2024 }),
        mkAcquisition({ amount: ONE_CELO, priceUsd: 0.8, timestamp: TS_2024_MID }),
        mkDisposal({ amount: ONE_CELO, priceUsd: 1.0, timestamp: TS_2024_LATE }),
      ],
    });

    // WAC avg = 0.6 → gain = 0.4
    const y2024 = out.taxYears.find((y) => y.year === 2024)!;
    expect(y2024.realizedGains).toBeCloseTo(0.4, 6);
  });

  it('attaches compat flags so the orchestrator can warn on illegal combos', async () => {
    const out = await computePnl({
      address: ADDR,
      method: 'LIFO',
      taxYear: 2024,
      classified: [],
    });
    const ng = out.methodJurisdictionCompat.find((e) => e.jurisdiction === 'NG')!;
    expect(ng.ok).toBe(false);
  });

  it('populates PnlOutput.disposals end-to-end (amendment #6)', async () => {
    // Regression: csv-exporter relies on pnl.disposals to compute CGT per-row.
    // Before this fix, csv-exporter used `(pnl as any).disposals` which always
    // resolved to undefined in the real pipeline (computePnl never populated
    // it), so the directional-fallback formula ran for every disposal row.
    const acquisition = mkAcquisition({
      amount: ONE_CELO,
      priceUsd: 0.5,
      timestamp: TS_2024,
    });
    const disposal = mkDisposal({
      amount: ONE_CELO,
      priceUsd: 0.8,
      timestamp: TS_2024_MID,
    });

    const out = await computePnl({
      address: ADDR,
      method: 'FIFO',
      taxYear: 2024,
      classified: [acquisition, disposal],
    });

    expect(out.disposals).toHaveLength(1);
    const d = out.disposals[0]!;
    expect(d.sourceHash).toBe(disposal.hash);
    // FIFO consumed the 0.5 USD lot → cost basis 0.5 USD, proceeds 0.8 USD,
    // gain 0.3 USD. Stored in micro-USD (1e-6 precision).
    expect(d.costBasisMicroUsd).toBe(500_000n);
    expect(d.proceedsMicroUsd).toBe(800_000n);
    expect(d.gainMicroUsd).toBe(300_000n);
  });
});
