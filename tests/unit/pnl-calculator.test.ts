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
  };
}

function mkDisposal(overrides: {
  symbol?: string;
  amount: string;
  priceUsd: number;
  timestamp: Timestamp;
  type?: 'TRANSFER_OUT' | 'SWAP';
}): ClassifiedTx {
  const hash = mkHash();
  return {
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
