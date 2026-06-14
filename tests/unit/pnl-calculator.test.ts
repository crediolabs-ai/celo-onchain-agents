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
  computeYieldRoundTripAdjustments,
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
    // Fix 2026-06-14: vault withdraw gains are interestEarned, not realizedPnl.
    expect(d.category).toBe('INTEREST_EARNED');
    expect(result.interestEarnedMicroUsdTotal).toBe(0n); // 1:1 NAV, no gain
    expect(result.realizedPnlMicroUsdByAsset['USDyc']).toBeUndefined();
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

  // ─── Interest-earned + reinvestment cycle (Quan feedback 2026-06-14) ───

  // One USDC = 1,000,000 (6 decimals). Use whole-number amounts (e.g. 5,000
  // USDC = 5,000,000,000 micro-USDC) so gain math is exact.
  const FIVE_K_USDC = '5000000000';
  const FIVE_POINT_THREE_K_USDC = '5300000000';
  const SIX_K_USDC = '6000000000';

  it('FIFO: vault DEPOSIT alone does NOT add to yield or interestEarned (regression for the deposit-as-yield bug)', () => {
    // Quan 2026-06-14: "When an investor deposits capital into a vault,
    // the platform must classify the difference between deposit and
    // withdrawal as realized taxable income." The DEPOSIT itself is NOT
    // income — only the WITHDRAW gain is. The pre-fix engine added the
    // deposit amount to yieldTotal, which inflated the yield line for any
    // vault user (e.g. KE 0xBE19 showed $5,374.90 yield for a single
    // $5,374.90 deposit with no disposals).
    const result = computeFifo({
      classified: [
        mkAcquisition({
          symbol: 'USDyc', amount: FIVE_K_USDC, priceUsd: 1.0,
          timestamp: TS_2024, vaultAddress: VAULT_A,
        }),
      ],
    });
    expect(result.disposals).toHaveLength(0);
    expect(result.yieldMicroUsdTotal).toBe(0n);
    expect(result.interestEarnedMicroUsdTotal).toBe(0n);
    expect(result.incomeMicroUsdTotal).toBe(0n);
    // Lot queued correctly — open position, cost basis = deposit USD.
    const remaining = result.remainingLots.get(`${VAULT_A}:USDyc`)!;
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.costBasisMicroUsd).toBe(5_000_000_000n); // 5,000 USD in micro-USD
  });

  it('FIFO: vault WITHDRAW with NAV gain routes gain to interestEarned, not realizedPnl', () => {
    // Deposit 5,000 USDyc at NAV=1.0. Withdraw 5,300 USDC at NAV=1.06
    // (vault strategy earned 6% yield). Gain = 300 USDC = 0.3K = interest
    // income, NOT capital gain.
    const result = computeFifo({
      classified: [
        mkAcquisition({
          symbol: 'USDyc', amount: FIVE_K_USDC, priceUsd: 1.0,
          timestamp: TS_2024, vaultAddress: VAULT_A,
        }),
        {
          hash: mkHash(),
          timestamp: TS_2024_MID,
          type: 'YIELD',
          assetIn: { symbol: 'USDC', amount: FIVE_POINT_THREE_K_USDC, priceUsd: 1.0 },
          assetOut: { symbol: 'USDyc', amount: FIVE_K_USDC, priceUsd: 1.06 },
          classifierSource: 'rule',
          vaultAddress: VAULT_A,
        },
      ],
    });
    expect(result.disposals).toHaveLength(1);
    const d = result.disposals[0]!;
    expect(d.proceedsMicroUsd).toBe(5_300_000_000n); // 5,300 USDC
    expect(d.costBasisMicroUsd).toBe(5_000_000_000n); // 5,000 USDyc at 1.0
    expect(d.gainMicroUsd).toBe(300_000_000n); // 300 USDC = 0.3K interest
    // The critical routing assertion: gain lands in interestEarned, not
    // realizedPnl. This is the fix for Quan's "interest earned must be
    // reported as a separate component" requirement.
    expect(d.category).toBe('INTEREST_EARNED');
    expect(result.interestEarnedMicroUsdTotal).toBe(300_000_000n);
    expect(result.realizedPnlMicroUsdByAsset['USDyc']).toBeUndefined();
  });

  it('FIFO: full reinvestment cycle — Quan\'s exact spec (5K → 5.3K → 5.3K → 6K = 0.3K + 0.7K interest)', () => {
    // Quan 2026-06-14: "If an investor withdraws 5.3K (5K principal + 0.3K
    // gain) and immediately reinvests the full 5.3K into a new position,
    // the cost-basis for the new position must be updated to 5.3K. If
    // that 5.3K investment later grows to 6K, the tax calculation should
    // only apply to the new gain (6K - 5.3K = 0.7K)."
    //
    // Scenario:
    //   t1: DEPOSIT 5,000 USDC → vault mints 5,000 USDyc (cost basis 5,000)
    //   t2: WITHDRAW 5,300 USDC → vault burns 5,000 USDyc, gives 5,300 USDC
    //       → gain 300 = 0.3K INTEREST EARNED
    //   t3: REINVEST 5,300 USDC → vault mints 5,300 USDyc (cost basis 5,300)
    //   t4: WITHDRAW 6,000 USDC → vault burns 5,300 USDyc, gives 6,000 USDC
    //       → gain 700 = 0.7K INTEREST EARNED
    // Total interest earned = 1,000 USDC (NOT 1,000 from the original 5K).
    const result = computeFifo({
      classified: [
        // t1: DEPOSIT 5K
        mkAcquisition({
          symbol: 'USDyc', amount: FIVE_K_USDC, priceUsd: 1.0,
          timestamp: TS_2024, vaultAddress: VAULT_A,
        }),
        // t2: WITHDRAW 5.3K (NAV went up 6%)
        {
          hash: mkHash(),
          timestamp: TS_2024_MID,
          type: 'YIELD',
          assetIn: { symbol: 'USDC', amount: FIVE_POINT_THREE_K_USDC, priceUsd: 1.0 },
          assetOut: { symbol: 'USDyc', amount: FIVE_K_USDC, priceUsd: 1.06 },
          classifierSource: 'rule',
          vaultAddress: VAULT_A,
        },
        // t3: REINVEST 5.3K (new lot at 5.3K cost basis — Quan's req)
        mkAcquisition({
          symbol: 'USDyc', amount: FIVE_POINT_THREE_K_USDC, priceUsd: 1.0,
          timestamp: TS_2024_LATE, vaultAddress: VAULT_A,
        }),
        // t4: WITHDRAW 6K (NAV went up 13.2% from the 5.3K basis)
        {
          hash: mkHash(),
          timestamp: TS_2024_LATE + 1,
          type: 'YIELD',
          assetIn: { symbol: 'USDC', amount: SIX_K_USDC, priceUsd: 1.0 },
          assetOut: { symbol: 'USDyc', amount: FIVE_POINT_THREE_K_USDC, priceUsd: 1.132 },
          classifierSource: 'rule',
          vaultAddress: VAULT_A,
        },
      ],
    });

    // 2 disposals, both INTEREST_EARNED.
    expect(result.disposals).toHaveLength(2);
    expect(result.disposals[0]!.category).toBe('INTEREST_EARNED');
    expect(result.disposals[1]!.category).toBe('INTEREST_EARNED');

    // Disposal 1: 5K lot at 5K cost, 5.3K proceeds → 0.3K gain
    expect(result.disposals[0]!.gainMicroUsd).toBe(300_000_000n);
    expect(result.disposals[0]!.costBasisMicroUsd).toBe(5_000_000_000n);
    // Disposal 2: 5.3K lot at 5.3K cost (NOT 5K), 6K proceeds → 0.7K gain
    expect(result.disposals[1]!.gainMicroUsd).toBe(700_000_000n);
    expect(result.disposals[1]!.costBasisMicroUsd).toBe(5_300_000_000n);

    // Total interest = 1,000 USDC across both disposals.
    expect(result.interestEarnedMicroUsdTotal).toBe(1_000_000_000n);
    // Realized PNL stays empty (no capital-gain disposals).
    expect(result.realizedPnlMicroUsdByAsset['USDyc']).toBeUndefined();
    // Yield bucket stays empty — deposits are not income.
    expect(result.yieldMicroUsdTotal).toBe(0n);
    // Vault A queue is fully consumed at t4.
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
    expect(out.interestEarnedTotal).toBe(0.0);

    const y2024 = out.taxYears.find((y) => y.year === 2024)!;
    expect(y2024).toBeDefined();
    expect(y2024.income).toBe(1.0);
    expect(y2024.yield).toBe(1.0);
    expect(y2024.interestEarned).toBe(0.0);
    // Realized gain = (1.5 - 1.0) = 0.5
    expect(y2024.realizedGains).toBeCloseTo(0.5, 6);
    // Taxable income = income + yield + interestEarned + realizedGains - deductibleGas
    // (gas is 0 here). Fix 2026-06-14: previous formula dropped yield on the
    // floor; expected 1.5, should be 2.5 with the corrected formula.
    expect(y2024.taxableIncome).toBeCloseTo(2.5, 6);

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

// ─── Yield round-trip auto-attribute (Quan 2026-06-14) ─────────────────────

describe('computeYieldRoundTripAdjustments', () => {
  // USDC has 6 decimals: 1 USDC = 1_000_000.
  // 5,000 USDC = 5_000_000_000; 5,374.90 USDC = 5_374_900_000.
  const FIVE_K_USDC = '5000000000';
  const FIVE_K_THREE_SEVEN_FOUR_USDC = '5374900000';

  // Jan 1, May 13, Dec 14, Dec 31 (all 2024).
  const TS_2024_MAY = 1_715_596_800 as Timestamp; // ~ May 13
  const TS_2024_DEC_MID = 1_734_148_800 as Timestamp; // ~ Dec 14
  const TS_2024_DEC_LATE = 1_735_008_000 as Timestamp; // ~ Dec 31

  // Build a YIELD-IN classified by yield.known_protocol_in@v1 (the 0xBE19 case).
  const knownProtocolIn = (amount: string, timestamp: Timestamp): ClassifiedTx => ({
    hash: mkHash(),
    timestamp,
    type: 'YIELD',
    assetIn: { symbol: 'USDC', amount, priceUsd: 1.0 },
    classifierSource: 'rule',
    notes: 'yield.known_protocol_in@v1: matched 0x5b7ba647',
  });

  const transferOut = (amount: string, timestamp: Timestamp, opts?: { vaultAddress?: Address }): ClassifiedTx => ({
    hash: mkHash(),
    timestamp,
    type: 'TRANSFER_OUT',
    assetOut: { symbol: 'USDC', amount, priceUsd: 1.0 },
    classifierSource: 'rule',
    ...(opts?.vaultAddress ? { vaultAddress: opts.vaultAddress } : {}),
  });

  it('matches the EARLIEST USDC OUT, not the sum (0xBE19 case)', () => {
    // Scenario mirrors 0xBE19 KE 2024:
    //   May 13: OUT 5,000 USDC → yield protocol deposit
    //   Dec 14: YIELD-IN 5,374.90 USDC from yield protocol
    //   Dec 31: OUT 5,374.90 USDC → vault DEPOSIT (should be IGNORED)
    //
    // Pre-fix bug: algorithm summed both OUTs (5,000 + 5,374.90 = 10,374.90),
    // producing a negative "interest" of -5,000 instead of the true +374.90.
    // Post-fix: only the earliest OUT is matched, interest = 5,374.90 − 5,000.
    const VAULT = '0xcccccccccccccccccccccccccccccccccccccccccccc' as Address;
    const out = computeYieldRoundTripAdjustments([
      transferOut(FIVE_K_USDC, TS_2024_MAY),
      knownProtocolIn(FIVE_K_THREE_SEVEN_FOUR_USDC, TS_2024_DEC_MID),
      transferOut(FIVE_K_THREE_SEVEN_FOUR_USDC, TS_2024_DEC_LATE, { vaultAddress: VAULT }),
    ]);

    expect(out.yieldReductionByYear.get(2024)).toBeCloseTo(5374.90, 4);
    expect(out.interestEarnedByYear.get(2024)).toBeCloseTo(374.90, 4);
  });

  it('makes no adjustment when there is no earlier USDC OUT in the same year', () => {
    // YIELD-IN on Dec 14, no OUTs at all in 2024.
    const out = computeYieldRoundTripAdjustments([
      knownProtocolIn(FIVE_K_THREE_SEVEN_FOUR_USDC, TS_2024_DEC_MID),
    ]);
    expect(out.yieldReductionByYear.size).toBe(0);
    expect(out.interestEarnedByYear.size).toBe(0);
  });

  it('ignores OUTs that come AFTER the YIELD-IN (only earlier ones count)', () => {
    // Dec 14: YIELD-IN. Dec 31: OUT 5,000 (later — must not be matched).
    const out = computeYieldRoundTripAdjustments([
      knownProtocolIn(FIVE_K_THREE_SEVEN_FOUR_USDC, TS_2024_DEC_MID),
      transferOut(FIVE_K_USDC, TS_2024_DEC_LATE),
    ]);
    expect(out.yieldReductionByYear.size).toBe(0);
    expect(out.interestEarnedByYear.size).toBe(0);
  });

  it('ignores OUTs with a different asset symbol', () => {
    // OUT in CELO (not USDC) should not match the USDC YIELD-IN.
    const celoOut: ClassifiedTx = {
      hash: mkHash(),
      timestamp: TS_2024_MAY,
      type: 'TRANSFER_OUT',
      assetOut: { symbol: 'CELO', amount: '1000000000000000000', priceUsd: 0.5 },
      classifierSource: 'rule',
    };
    const out = computeYieldRoundTripAdjustments([
      celoOut,
      knownProtocolIn(FIVE_K_THREE_SEVEN_FOUR_USDC, TS_2024_DEC_MID),
    ]);
    expect(out.yieldReductionByYear.size).toBe(0);
    expect(out.interestEarnedByYear.size).toBe(0);
  });

  it('ignores YIELD-IN events that are not classified by yield.known_protocol_in', () => {
    // Same shape as the matching case, but the YIELD-IN has no notes —
    // should not be adjusted.
    const vanillaYield: ClassifiedTx = {
      hash: mkHash(),
      timestamp: TS_2024_DEC_MID,
      type: 'YIELD',
      assetIn: { symbol: 'USDC', amount: FIVE_K_THREE_SEVEN_FOUR_USDC, priceUsd: 1.0 },
      classifierSource: 'rule',
    };
    const out = computeYieldRoundTripAdjustments([
      transferOut(FIVE_K_USDC, TS_2024_MAY),
      vanillaYield,
    ]);
    expect(out.yieldReductionByYear.size).toBe(0);
    expect(out.interestEarnedByYear.size).toBe(0);
  });

  it('attributes a loss when the matching OUT exceeds the YIELD-IN value', () => {
    // Defensive: if IN < OUT (e.g. partial yield), gain is negative and
    // still lands in interestEarned. Yield bucket is still reduced by IN.
    const BIGGER_OUT = '6000000000'; // 6,000 USDC
    const out = computeYieldRoundTripAdjustments([
      transferOut(BIGGER_OUT, TS_2024_MAY),
      knownProtocolIn(FIVE_K_THREE_SEVEN_FOUR_USDC, TS_2024_DEC_MID),
    ]);
    expect(out.yieldReductionByYear.get(2024)).toBeCloseTo(5374.90, 4);
    expect(out.interestEarnedByYear.get(2024)).toBeCloseTo(-625.10, 4);
  });

  it('skips the round-trip when the matched OUT is much smaller than the IN (0x4aaa NG 2024 case)', () => {
    // Scenario mirrors 0x4aaa76aB12bA7525C9E488E771C67d0BB99BfF70 (NG 2024):
    //   May 6:  OUT 5,000 USDC to a yield protocol (smaller position)
    //   Dec 14: YIELD-IN 16,124.70 USDC from a yield protocol
    //          (gross return on a LARGER externally-held position)
    //
    // Pre-fix bug: matched the 5,000 OUT as the cost basis, produced
    // $11,114.83 of phantom interest (5,000 × 0.5, then net = 16,114.83
    // − 5,000 = 11,114.83). The CSV rows all showed interest_earned_ngn
    // = 0.00, so the summary line and the per-row attribution diverged.
    // Post-fix: ratio (5,000 / 16,124.70) = 0.31 < 0.5 → skip round-trip.
    // The YIELD-IN reports as gross yield; interestEarned stays at 0.
    const SIXTEEN_K_USDC = '16124700000'; // 16,124.70 USDC
    const out = computeYieldRoundTripAdjustments([
      transferOut(FIVE_K_USDC, TS_2024_MAY),
      knownProtocolIn(SIXTEEN_K_USDC, TS_2024_DEC_MID),
    ]);

    expect(out.yieldReductionByYear.size).toBe(0);
    expect(out.interestEarnedByYear.size).toBe(0);
  });
});
