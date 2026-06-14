/**
 * Unit tests for the CSV exporter sub-agent.
 *
 * Owner: csv-exporter sub-agent.
 *
 * Covers:
 *   - Nigeria FIRS row building and CSV rendering
 *   - Kenya KRA row building and CSV rendering
 *   - OECD CARF row building and CSV rendering
 *   - Jurisdiction dispatcher (exportCsv)
 *   - Filename generation
 *   - Edge cases: empty input, GAS-only txs
 */

import { describe, expect, it } from 'vitest';
import type { ClassifiedTx, PnlOutput, Address, TxHash } from '../../src/shared/types.js';
import { exportCsv } from '../../src/sub-agents/csv-exporter/index.js';
import { buildNigeriaFirsRows, renderNigeriaFirsCsv } from '../../src/sub-agents/csv-exporter/schemas/nigeria-firs.js';
import { buildKenyaKraRows, renderKenyaKraCsv } from '../../src/sub-agents/csv-exporter/schemas/kenya-kra.js';
import { buildOecdCarfRows, renderOecdCarfCsv } from '../../src/sub-agents/csv-exporter/schemas/oecd-carf.js';
import { carfTxType } from '../../src/sub-agents/csv-exporter/schemas/oecd-carf.js';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const SWAP_TX: ClassifiedTx = {
  hash: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  type: 'SWAP',
  timestamp: 1_716_662_400, // 2024-05-15
  assetIn: { symbol: 'cUSD', amount: '2500000000000000000000', priceUsd: 1.0 },
  assetOut: { symbol: 'CELO', amount: '2000000000000000000', priceUsd: 0.65 },
  classifierSource: 'rule',
};

const INCOME_TX: ClassifiedTx = {
  hash: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  type: 'INCOME',
  timestamp: 1_704_067_200, // 2024-01-01
  assetIn: { symbol: 'CELO', amount: '1000000000000000000', priceUsd: 0.6 },
  classifierSource: 'rule',
};

const YIELD_TX: ClassifiedTx = {
  hash: '0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
  type: 'YIELD',
  timestamp: 1_725_187_200, // 2024-09-01
  assetIn: { symbol: 'G$', amount: '1000000000000000000000', priceUsd: 0.001 },
  classifierSource: 'rule',
};

const TRANSFER_OUT_TX: ClassifiedTx = {
  hash: '0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
  type: 'TRANSFER_OUT',
  timestamp: 1_730_400_000, // 2024-10-15
  assetOut: { symbol: 'CELO', amount: '500000000000000000', priceUsd: 0.7 },
  classifierSource: 'rule',
};

const GAS_TX: ClassifiedTx = {
  hash: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
  type: 'GAS',
  timestamp: 1_720_000_000, // 2024-07-01
  classifierSource: 'rule',
};

const BRIDGE_TX: ClassifiedTx = {
  hash: '0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
  type: 'BRIDGE',
  timestamp: 1_733_529_600, // 2024-12-01
  assetOut: { symbol: 'CELO', amount: '1000000000000000000', priceUsd: 0.75 },
  classifierSource: 'flagged',
  notes: 'flagged-bridge',
};

const MINT_TX: ClassifiedTx = {
  hash: '0x1111111111111111111111111111111111111111111111111111111111111111',
  type: 'MINT',
  timestamp: 1_706_000_000,
  assetIn: { symbol: 'CELO', amount: '500000000000000000', priceUsd: 0.55 },
  classifierSource: 'rule',
};

const pnlForNg: PnlOutput = {
  address: '0x0000000000000000000000000000000000000abc',
  method: 'FIFO',
  taxYears: [
    {
      year: 2024,
      realizedGains: 0.05,
      income: 0.6,
      yield: 0.001,
      interestEarned: 0,
      deductibleGas: 0,
      taxableIncome: 0.601,
    },
  ],
  realizedPnlByAsset: { CELO: 0.05 },
  unrealizedPnlByAsset: {},
  incomeTotal: 0.6,
  yieldTotal: 0.001,
  interestEarnedTotal: 0,
  priceGaps: [],
  methodJurisdictionCompat: [],
  disposals: [],
};

const pnlForKe: PnlOutput = {
  ...pnlForNg,
  taxYears: [{ ...pnlForNg.taxYears[0]!, year: 2024 }],
};

const pnlForOther: PnlOutput = { ...pnlForNg };

// ─── Test helpers ─────────────────────────────────────────────────────────────

/**
 * Creates a PnlOutput with an injected disposal record for testing the CSV
 * builder's disposal-map lookup path (B1/B2/B4 fixes).
 *
 * IMPORTANT: constructs a fully fresh object literal each call so there is
 * zero risk of cross-test contamination from shared fixture mutation.
 */
function createPnlWithDisposal(
  entries: { hash: string; proceedsMicroUsd: bigint; costBasisMicroUsd: bigint }[],
): PnlOutput {
  // Build a brand-new PnlOutput — never mutate the module-level fixtures.
  return {
    address: '0x0000000000000000000000000000000000000abc',
    method: 'FIFO',
    taxYears: [
      {
        year: 2024,
        realizedGains: 0.05,
        income: 0.6,
        yield: 0.001,
        interestEarned: 0,
        deductibleGas: 0,
        taxableIncome: 0.601,
      },
    ],
    realizedPnlByAsset: { CELO: 0.05 },
    unrealizedPnlByAsset: {},
    incomeTotal: 0.6,
    yieldTotal: 0.001,
    interestEarnedTotal: 0,
    priceGaps: [],
    methodJurisdictionCompat: [],
    disposals: entries.map((e) => ({
      sourceHash: e.hash as `0x${string}`,
      proceedsMicroUsd: e.proceedsMicroUsd,
      costBasisMicroUsd: e.costBasisMicroUsd,
      gainMicroUsd: e.proceedsMicroUsd - e.costBasisMicroUsd,
      symbol: 'CELO',
      amount: 0n,
      lotSourceHash: e.hash as `0x${string}`,
      disposalPriceUsd: 0,
      lotPriceUsd: 0,
      timestamp: 0,
      category: 'CAPITAL_GAIN' as const,
    })),
  };
}

// ─── NG FIRS tests ───────────────────────────────────────────────────────────

/** Find the OUT (disposal) leg row, or fail with a useful message. */
function ngOutRow(rows: ReturnType<typeof buildNigeriaFirsRows>) {
  const r = rows.find((row) => row.type === 'disposal');
  if (!r) throw new Error(`expected a 'disposal' row, got: ${JSON.stringify(rows.map((r) => r.type))}`);
  return r;
}

describe('Nigeria FIRS schema', () => {
  it('builds one row per asset leg of non-GAS txs (Quan fix 2026-06-14: multi-leg → 2 rows)', () => {
    // INCOME has 1 leg, SWAP has 2 (IN + OUT), YIELD has 1 (assetIn only),
    // GAS filtered. Pre-fix: 3 rows. Post-fix: 1 + 2 + 1 = 4 rows.
    const rows = buildNigeriaFirsRows([INCOME_TX, SWAP_TX, GAS_TX, YIELD_TX], pnlForNg, 2024);
    expect(rows).toHaveLength(4);
  });

  it('classifies INCOME as type "income"', () => {
    const rows = buildNigeriaFirsRows([INCOME_TX], pnlForNg, 2024);
    expect(rows[0]!.type).toBe('income');
  });

  it('classifies SWAP as type "disposal" (the OUT leg)', () => {
    const rows = buildNigeriaFirsRows([SWAP_TX], pnlForNg, 2024);
    const disposal = ngOutRow(rows);
    expect(disposal.type).toBe('disposal');
  });

  it('classifies TRANSFER_OUT as type "disposal"', () => {
    const rows = buildNigeriaFirsRows([TRANSFER_OUT_TX], pnlForNg, 2024);
    expect(rows[0]!.type).toBe('disposal');
  });

  it('classifies YIELD as type "income"', () => {
    const rows = buildNigeriaFirsRows([YIELD_TX], pnlForNg, 2024);
    expect(rows[0]!.type).toBe('income');
  });

  it('classifies MINT as type "income"', () => {
    const rows = buildNigeriaFirsRows([MINT_TX], pnlForNg, 2024);
    expect(rows[0]!.type).toBe('income');
  });

  it('classifies BRIDGE as type "other"', () => {
    const rows = buildNigeriaFirsRows([BRIDGE_TX], pnlForNg, 2024);
    expect(rows[0]!.type).toBe('other');
  });

  it('converts price to NGN at 1500 rate', () => {
    const rows = buildNigeriaFirsRows([INCOME_TX], pnlForNg, 2024);
    // priceUsd = 0.6 → 0.6 × 1500 = 900
    expect(rows[0]!.price_ngn).toBe(900);
  });

  it('sets cost_basis_ngn from disposal record when available (OUT leg)', () => {
    // Use a clean SWAP fixture with normalized 1-token amounts.
    const swap: ClassifiedTx = {
      hash: '0x0000000000000000000000000000000000000000000000000000000000000b01',
      type: 'SWAP',
      timestamp: 1_716_662_400,
      assetIn: { symbol: 'cUSD', amount: '1', priceUsd: 1.0 },   // 1 cUSD in
      assetOut: { symbol: 'CELO', amount: '1', priceUsd: 0.65 }, // 1 CELO out
      classifierSource: 'rule',
    };
    const pnl = createPnlWithDisposal([
      { hash: swap.hash, proceedsMicroUsd: 2_500_000n, costBasisMicroUsd: 1_300_000n },
    ]);
    const rows = buildNigeriaFirsRows([swap], pnl, 2024);
    // cost basis = 1.3e6/1e6 = 1.3 USD → 1.3 × 1500 = 1950 NGN (on OUT leg)
    expect(ngOutRow(rows).cost_basis_ngn).toBe(1950);
  });

  it('B1/B2: cost_basis_ngn uses FIFO cost basis, not market proceeds (OUT leg)', () => {
    const swap: ClassifiedTx = {
      hash: '0x0000000000000000000000000000000000000000000000000000000000000b02',
      type: 'SWAP',
      timestamp: 1_716_662_400,
      assetIn: { symbol: 'cUSD', amount: '1', priceUsd: 1.0 },
      assetOut: { symbol: 'CELO', amount: '1', priceUsd: 0.65 },
      classifierSource: 'rule',
    };
    // cost basis = 2.0 USD → 2.0 × 1500 = 3000 NGN
    const pnl = createPnlWithDisposal([
      { hash: swap.hash, proceedsMicroUsd: 2_500_000n, costBasisMicroUsd: 2_000_000n },
    ]);
    const rows = buildNigeriaFirsRows([swap], pnl, 2024);
    expect(ngOutRow(rows).cost_basis_ngn).toBe(3000);
  });

  it('sets cost_basis_ngn = 0 for income events', () => {
    const rows = buildNigeriaFirsRows([INCOME_TX], pnlForNg, 2024);
    expect(rows[0]!.cost_basis_ngn).toBe(0);
  });

  it('computes gain_loss_ngn from disposal record (OUT leg)', () => {
    const swap: ClassifiedTx = {
      hash: '0x0000000000000000000000000000000000000000000000000000000000000b03',
      type: 'SWAP',
      timestamp: 1_716_662_400,
      assetIn: { symbol: 'cUSD', amount: '1', priceUsd: 1.0 },
      assetOut: { symbol: 'CELO', amount: '1', priceUsd: 0.65 },
      classifierSource: 'rule',
    };
    // proceeds = 2.5 USD → 3750 NGN; cost basis = 1.3 USD → 1950 NGN; gain = 1800 NGN
    const pnl = createPnlWithDisposal([
      { hash: swap.hash, proceedsMicroUsd: 2_500_000n, costBasisMicroUsd: 1_300_000n },
    ]);
    const rows = buildNigeriaFirsRows([swap], pnl, 2024);
    expect(ngOutRow(rows).gain_loss_ngn).toBe(1800);
  });

  it('B1: SWAP gain uses proceeds - FIFO cost basis, not price diff (OUT leg)', () => {
    const swap: ClassifiedTx = {
      hash: '0x0000000000000000000000000000000000000000000000000000000000000b04',
      type: 'SWAP',
      timestamp: 1_716_662_400,
      assetIn: { symbol: 'cUSD', amount: '1', priceUsd: 1.0 },
      assetOut: { symbol: 'CELO', amount: '1', priceUsd: 0.65 },
      classifierSource: 'rule',
    };
    // proceeds = 2.5 USD → 3750 NGN; cost basis = 2.0 USD → 3000 NGN; gain = 750 NGN
    const pnl = createPnlWithDisposal([
      { hash: swap.hash, proceedsMicroUsd: 2_500_000n, costBasisMicroUsd: 2_000_000n },
    ]);
    const rows = buildNigeriaFirsRows([swap], pnl, 2024);
    expect(ngOutRow(rows).gain_loss_ngn).toBe(750);
  });

  it('computes cumulative gain as running total (only OUT legs contribute)', () => {
    const swap: ClassifiedTx = {
      hash: '0x0000000000000000000000000000000000000000000000000000000000000b05',
      type: 'SWAP',
      timestamp: 1_716_662_400,
      assetIn: { symbol: 'cUSD', amount: '1', priceUsd: 1.0 },
      assetOut: { symbol: 'CELO', amount: '1', priceUsd: 0.65 },
      classifierSource: 'rule',
    };
    const pnl = createPnlWithDisposal([
      { hash: swap.hash, proceedsMicroUsd: 2_500_000n, costBasisMicroUsd: 1_300_000n },
    ]);
    const rows = buildNigeriaFirsRows([INCOME_TX, swap], pnl, 2024);
    // Income has 1 row (gain 0); cumulative = 0
    expect(rows[0]!.cumulative_gain_ngn).toBe(0);
    // SWAP emits 2 rows: IN leg (gain 0, cumulative stays 0) then OUT leg
    // (gain 1800, cumulative = 1800).
    const outRowIdx = rows.findIndex((r) => r.type === 'disposal');
    expect(rows[outRowIdx]!.cumulative_gain_ngn).toBe(1800);
  });

  it('D2: cumulative_gain_ngn resets at year boundary', () => {
    const tx2023: ClassifiedTx = {
      hash: '0x000000000000000000000000000000000000000000000000000000000000c001',
      type: 'SWAP',
      timestamp: 1_702_300_800, // 2023-12-31
      assetIn: { symbol: 'cUSD', amount: '1', priceUsd: 1.0 },
      assetOut: { symbol: 'CELO', amount: '1', priceUsd: 0.5 },
      classifierSource: 'rule',
    };
    const tx2024: ClassifiedTx = {
      hash: '0x000000000000000000000000000000000000000000000000000000000000c002',
      type: 'SWAP',
      timestamp: 1_704_067_200, // 2024-01-01
      assetIn: { symbol: 'cUSD', amount: '1', priceUsd: 1.0 },
      assetOut: { symbol: 'CELO', amount: '1', priceUsd: 0.5 },
      classifierSource: 'rule',
    };
    const pnl = createPnlWithDisposal([
      { hash: tx2023.hash, proceedsMicroUsd: 1_000_000n, costBasisMicroUsd: 500_000n },
      { hash: tx2024.hash, proceedsMicroUsd: 1_000_000n, costBasisMicroUsd: 500_000n },
    ]);
    const rows = buildNigeriaFirsRows([tx2023, tx2024], pnl, 2024);
    // proceeds = 1.0 USD → 1500 NGN; cost basis = 0.5 USD → 750 NGN; gain = 750 NGN
    // Each SWAP emits 2 rows (IN leg + OUT leg). The IN leg's cumulative_gain_ngn
    // is 0 (only OUT legs contribute). The OUT leg of 2023 has cumulative=750.
    // Filter for the OUT leg of each year.
    const outRows = rows.filter((r) => r.type === 'disposal');
    expect(outRows).toHaveLength(2);
    // 2023 OUT leg: cumulative = 750 NGN
    expect(outRows[0]!.cumulative_gain_ngn).toBe(750);
    // 2024 OUT leg: year changed → cumulative resets to 0, then adds 750 NGN
    expect(outRows[1]!.cumulative_gain_ngn).toBe(750);
  });

  it('B2: cost_basis_ngn = FIFO cost basis, not market proceeds for TRANSFER_OUT', () => {
    const transferOut: ClassifiedTx = {
      hash: '0x0000000000000000000000000000000000000000000000000000000000000999',
      type: 'TRANSFER_OUT',
      timestamp: 1_730_400_000,
      assetOut: { symbol: 'CELO', amount: '0.5', priceUsd: 0.7 },
      classifierSource: 'rule',
    };
    const pnl = createPnlWithDisposal([
      { hash: transferOut.hash, proceedsMicroUsd: 700_000n, costBasisMicroUsd: 400_000n },
    ]);
    const rows = buildNigeriaFirsRows([transferOut], pnl, 2024);
    // cost basis = 0.4e6/1e6 = 0.4 USD → 0.4 × 1500 = 600 NGN
    expect(rows[0]!.cost_basis_ngn).toBe(600);
    // proceeds = 0.7e6/1e6 = 0.7 USD → 0.7 × 1500 = 1050 NGN; gain = 1050 - 600 = 450 NGN
    expect(rows[0]!.gain_loss_ngn).toBe(450);
  });

  it('skips GAS txs', () => {
    const rows = buildNigeriaFirsRows([GAS_TX], pnlForNg, 2024);
    expect(rows).toHaveLength(0);
  });

  it('includes classifier notes in row', () => {
    const rows = buildNigeriaFirsRows([BRIDGE_TX], pnlForNg, 2024);
    expect(rows[0]!.notes).toBe('flagged-bridge');
  });

  it('renders a parseable CSV with header', () => {
    const rows = buildNigeriaFirsRows([INCOME_TX], pnlForNg, 2024);
    const csv = renderNigeriaFirsCsv(rows);
    const lines = csv.split('\n');
    expect(lines).toHaveLength(2); // header + 1 data row
    expect(lines[0]!).toContain('tx_date');
    expect(lines[0]!).toContain('type');
    expect(lines[0]!).toContain('price_ngn');
  });

  it('renders tx_date in YYYY-MM-DD format', () => {
    const rows = buildNigeriaFirsRows([INCOME_TX], pnlForNg, 2024);
    const csv = renderNigeriaFirsCsv(rows);
    // 1704067200 → 2024-01-01
    expect(csv).toContain('2024-01-01');
  });
});

// ─── KE KRA tests ───────────────────────────────────────────────────────────

/** Find the OUT (transfer) leg row, or fail with a useful message. */
function outRow(rows: ReturnType<typeof buildKenyaKraRows>) {
  const r = rows.find((row) => row.type === 'transfer');
  if (!r) throw new Error(`expected a 'transfer' row, got: ${JSON.stringify(rows.map((r) => r.type))}`);
  return r;
}

describe('Kenya KRA schema', () => {
  it('builds one row per asset leg of non-GAS txs (Quan fix 2026-06-14: multi-leg → 2 rows)', () => {
    // INCOME_TX has 1 leg, SWAP_TX has 2 (IN + OUT). GAS_TX is filtered.
    // Pre-fix: 2 rows. Post-fix: 1 + 2 = 3 rows.
    const rows = buildKenyaKraRows([INCOME_TX, SWAP_TX, GAS_TX]);
    expect(rows).toHaveLength(3);
  });

  it('classifies SWAP as "transfer" (the OUT leg)', () => {
    const rows = buildKenyaKraRows([SWAP_TX]);
    const transfer = outRow(rows);
    expect(transfer.type).toBe('transfer');
  });

  it('classifies TRANSFER_OUT as "transfer"', () => {
    const rows = buildKenyaKraRows([TRANSFER_OUT_TX]);
    expect(rows[0]!.type).toBe('transfer');
  });

  it('classifies INCOME as "income"', () => {
    const rows = buildKenyaKraRows([INCOME_TX]);
    expect(rows[0]!.type).toBe('income');
  });

  it('classifies YIELD as "income"', () => {
    const rows = buildKenyaKraRows([YIELD_TX]);
    expect(rows[0]!.type).toBe('income');
  });

  it('classifies MINT as "income"', () => {
    const rows = buildKenyaKraRows([MINT_TX]);
    expect(rows[0]!.type).toBe('income');
  });

  it('classifies BRIDGE as "other"', () => {
    const rows = buildKenyaKraRows([BRIDGE_TX]);
    expect(rows[0]!.type).toBe('other');
  });

  it('B3: gross_transfer_value_kes includes amount × price factor (OUT leg)', () => {
    // B3 fix: 2 CELO × 0.65 USD/CELO × 130 KES/USD = 169.0 KES
    // DAT = 3% × 169.0 = 5.07 (2dp)
    // Uses clean fixture with standard token amounts (not wei).
    const swap: ClassifiedTx = {
      hash: '0x0000000000000000000000000000000000000000000000000000000000000b3a',
      type: 'SWAP',
      timestamp: 1_720_000_000,
      assetIn: { symbol: 'cUSD', amount: '2', priceUsd: 1.0 },
      assetOut: { symbol: 'CELO', amount: '2', priceUsd: 0.65 },
      classifierSource: 'rule',
    };
    const rows = buildKenyaKraRows([swap]);
    const transfer = outRow(rows);
    expect(transfer.gross_transfer_value_kes).toBe(169);
    expect(transfer.dat_due_kes).toBe(5.07);
  });

  it('B3: TRANSFER_OUT gross value includes amount factor', () => {
    // Use a clean fixture with normalized amount (0.5 CELO, not wei).
    const transferOut: ClassifiedTx = {
      hash: '0x0000000000000000000000000000000000000000000000000000000000000b3b',
      type: 'TRANSFER_OUT',
      timestamp: 1_730_400_000,
      assetOut: { symbol: 'CELO', amount: '0.5', priceUsd: 0.7 },
      classifierSource: 'rule',
    };
    const rows = buildKenyaKraRows([transferOut]);
    // 0.5 × 0.7 × 130 = 45.5 KES; DAT = 3% = 1.37 (2dp)
    expect(rows[0]!.gross_transfer_value_kes).toBe(45.5);
    expect(rows[0]!.dat_due_kes).toBe(1.37);
  });

  it('B3: DAT uses per-unit price × full amount × KES rate (OUT leg of SWAP)', () => {
    // 5 CELO × 0.6 USD × 130 = 390 KES gross; DAT = 3% = 11.7 (2dp)
    const swapTx: ClassifiedTx = {
      hash: '0x0000000000000000000000000000000000000000000000000000000000000abc',
      type: 'SWAP',
      timestamp: 1_720_000_000,
      assetIn: { symbol: 'cUSD', amount: '3', priceUsd: 1.0 },
      assetOut: { symbol: 'CELO', amount: '5', priceUsd: 0.6 },
      classifierSource: 'rule',
    };
    const rows = buildKenyaKraRows([swapTx]);
    const transfer = outRow(rows);
    expect(transfer.gross_transfer_value_kes).toBe(390);
    expect(transfer.dat_due_kes).toBe(11.7);
  });

  it('DAT = 0 for income events', () => {
    const rows = buildKenyaKraRows([INCOME_TX]);
    expect(rows[0]!.dat_due_kes).toBe(0);
  });

  it('B5: income_kes = full amount × priceUsd × KES rate (not per-unit)', () => {
    // 1 CELO × 0.6 USD × 130 KES/USD = 78 KES
    const incomeTxHuman: ClassifiedTx = {
      hash: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      type: 'INCOME',
      timestamp: 1_704_067_200,
      assetIn: { symbol: 'CELO', amount: '1', priceUsd: 0.6 },
      classifierSource: 'rule',
    };
    const rows = buildKenyaKraRows([incomeTxHuman]);
    expect(rows[0]!.income_kes).toBe(78);
  });

  it('income_kes = 0 for transfer events', () => {
    const rows = buildKenyaKraRows([SWAP_TX]);
    expect(rows[0]!.income_kes).toBe(0);
  });

  it('skips GAS txs', () => {
    const rows = buildKenyaKraRows([GAS_TX]);
    expect(rows).toHaveLength(0);
  });

  it('skips gas not deductible under KRA guidance', () => {
    // Confirm GAS is absent from output (not just zeroed)
    const rows = buildKenyaKraRows([GAS_TX, INCOME_TX]);
    expect(rows.find((r) => r.asset === 'CELO' && r.type === 'fee')).toBeUndefined();
  });

  it('renders a parseable CSV with all required columns', () => {
    const rows = buildKenyaKraRows([INCOME_TX]);
    const csv = renderKenyaKraCsv(rows);
    expect(csv).toContain('tx_date');
    expect(csv).toContain('dat_due_kes');
    expect(csv).toContain('income_kes');
  });

  it('converts price to KES at 130 rate', () => {
    const rows = buildKenyaKraRows([INCOME_TX]);
    // 0.6 USD × 130 = 78 KES
    expect(rows[0]!.price_kes).toBe(78);
  });
});

// ─── OECD CARF tests ─────────────────────────────────────────────────────────

/**
 * Find the OUT (exchange) leg row in CARF output. CARF labels both
 * IN and OUT legs of a SWAP as 'exchange' (one logical event), so we
 * pick the one with non-zero gross_proceeds_usd — that's the OUT leg
 * where the financial data lives. Fix 2026-06-14 multi-leg refactor.
 */
function carfOutRow(rows: ReturnType<typeof buildOecdCarfRows>) {
  const r = rows.find((row) => row.gross_proceeds_usd > 0);
  if (!r) throw new Error(`expected an OUT-leg row (gross_proceeds_usd > 0), got: ${JSON.stringify(rows.map((row) => ({ tx_type: row.tx_type, gp: row.gross_proceeds_usd })))}`);
  return r;
}

describe('OECD CARF schema (OTHER jurisdiction)', () => {
  it('builds one row per asset leg of non-GAS txs (Quan fix 2026-06-14: multi-leg → 2 rows for SWAP)', () => {
    // INCOME has 1 leg, SWAP has 2 (IN + OUT), GAS filtered.
    // Pre-fix: 2 rows. Post-fix: 1 + 2 = 3 rows.
    const rows = buildOecdCarfRows([INCOME_TX, SWAP_TX, GAS_TX], pnlForOther, 2024);
    expect(rows).toHaveLength(3);
  });

  it('maps SWAP to CARF tx_type "exchange" (the OUT leg)', () => {
    const rows = buildOecdCarfRows([SWAP_TX], pnlForOther, 2024);
    expect(carfOutRow(rows).tx_type).toBe('exchange');
  });

  it('maps TRANSFER_OUT to CARF tx_type "transfer"', () => {
    const rows = buildOecdCarfRows([TRANSFER_OUT_TX], pnlForOther, 2024);
    expect(rows[0]!.tx_type).toBe('transfer');
  });

  it('maps INCOME to CARF tx_type "payment"', () => {
    const rows = buildOecdCarfRows([INCOME_TX], pnlForOther, 2024);
    expect(rows[0]!.tx_type).toBe('payment');
  });

  it('maps YIELD to CARF tx_type "payment"', () => {
    const rows = buildOecdCarfRows([YIELD_TX], pnlForOther, 2024);
    expect(rows[0]!.tx_type).toBe('payment');
  });

  it('maps MINT to CARF tx_type "payment"', () => {
    const rows = buildOecdCarfRows([MINT_TX], pnlForOther, 2024);
    expect(rows[0]!.tx_type).toBe('payment');
  });

  it('maps GAS to CARF tx_type "fee" (via helper)', () => {
    // GAS txs are skipped in the row builder (consistent with NG/KE schemas),
    // so we test the helper function directly.
    expect(carfTxType(GAS_TX)).toBe('fee');
  });

  it('maps BURN to CARF tx_type "burn"', () => {
    const burnTx: ClassifiedTx = {
      hash: '0x2222222222222222222222222222222222222222222222222222222222222222',
      type: 'BURN',
      timestamp: 1_710_000_000,
      assetOut: { symbol: 'CELO', amount: '100000000000000000', priceUsd: 0.5 },
      classifierSource: 'rule',
    };
    const rows = buildOecdCarfRows([burnTx], pnlForOther, 2024);
    expect(rows[0]!.tx_type).toBe('burn');
  });

  it('maps stablecoins to asset_type "stablecoin"', () => {
    const rows = buildOecdCarfRows([SWAP_TX], pnlForOther, 2024); // cUSD assetIn
    expect(rows[0]!.asset_type).toBe('stablecoin');
  });

  it('maps CELO to asset_type "other_crypto"', () => {
    const rows = buildOecdCarfRows([INCOME_TX], pnlForOther, 2024); // CELO assetIn
    expect(rows[0]!.asset_type).toBe('other_crypto');
  });

  it('sets user_jurisdiction to "OTHER"', () => {
    const rows = buildOecdCarfRows([INCOME_TX], pnlForOther, 2024);
    expect(rows[0]!.user_jurisdiction).toBe('OTHER');
  });

  it('B4: proceeds = assetIn value, cost basis = FIFO from disposal record (OUT leg)', () => {
    // proceedsMicroUsd / 1e6 = USD; costBasisMicroUsd / 1e6 = USD
    const pnl = createPnlWithDisposal([
      { hash: SWAP_TX.hash, proceedsMicroUsd: 2_500_000_000n, costBasisMicroUsd: 1_300_000_000n },
    ]);
    const rows = buildOecdCarfRows([SWAP_TX], pnl, 2024);
    // 2.5e9 / 1e6 = 2500 USD; 1.3e9 / 1e6 = 1300 USD (on OUT leg)
    const out = carfOutRow(rows);
    expect(out.gross_proceeds_usd).toBe(2500);
    expect(out.cost_basis_usd).toBe(1300);
    expect(out.pnl_usd).toBe(1200);
  });

  it('B4: SWAP without disposal record uses directional fallback formula (OUT leg)', () => {
    // Use a clean fixture with standard token amounts to keep USD values readable.
    // SWAP_TX itself uses wei-formatted amounts making fallback values astronomical.
    const cleanSwap: ClassifiedTx = {
      hash: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      type: 'SWAP',
      timestamp: 1_716_662_400,
      assetIn: { symbol: 'cUSD', amount: '1', priceUsd: 1.0 },   // $1.00 proceeds
      assetOut: { symbol: 'CELO', amount: '1', priceUsd: 0.65 }, // $0.65 cost basis
      classifierSource: 'rule',
    };
    const rows = buildOecdCarfRows([cleanSwap], pnlForOther, 2024);
    // 1 × 1.0 = $1.00 proceeds; 1 × 0.65 = $0.65 cost basis; pnl = $0.35 (on OUT leg)
    const out = carfOutRow(rows);
    expect(out.gross_proceeds_usd).toBe(1);
    expect(out.cost_basis_usd).toBe(0.65);
    expect(out.pnl_usd).toBe(0.35);
  });

  it('B4: SWAP PNL is positive when proceeds exceed cost basis (OUT leg)', () => {
    const profitableSwap: ClassifiedTx = {
      hash: '0x0000000000000000000000000000000000000000000000000000000000000def',
      type: 'SWAP',
      timestamp: 1_720_000_000,
      assetIn: { symbol: 'USDC', amount: '1000000000', priceUsd: 1.0 }, // 1 USDC ($1)
      assetOut: { symbol: 'CELO', amount: '2000000000000000000', priceUsd: 0.5 }, // 2 CELO ($1)
      classifierSource: 'rule',
    };
    const pnl = createPnlWithDisposal([
      { hash: profitableSwap.hash, proceedsMicroUsd: 1_000_000n, costBasisMicroUsd: 500_000n },
    ]);
    const rows = buildOecdCarfRows([profitableSwap], pnl, 2024);
    // proceeds = 1e6/1e6 = $1; cost basis = 0.5e6/1e6 = $0.5; pnl = $0.5 (on OUT leg)
    expect(carfOutRow(rows).pnl_usd).toBe(0.5);
  });

  it('sets gross_proceeds_usd = 0 for income events', () => {
    const rows = buildOecdCarfRows([INCOME_TX], pnlForOther, 2024);
    expect(rows[0]!.gross_proceeds_usd).toBe(0);
  });

  it('sets cost_basis_usd = 0 for income events', () => {
    const rows = buildOecdCarfRows([INCOME_TX], pnlForOther, 2024);
    expect(rows[0]!.cost_basis_usd).toBe(0);
  });

  it('sets reporting_period from taxYear', () => {
    const rows = buildOecdCarfRows([INCOME_TX], pnlForOther, 2024);
    expect(rows[0]!.reporting_period).toBe('2024');
  });

  it('skips GAS txs', () => {
    const rows = buildOecdCarfRows([GAS_TX], pnlForOther, 2024);
    expect(rows).toHaveLength(0);
  });

  it('renders a parseable CSV with all required CARF columns', () => {
    const rows = buildOecdCarfRows([INCOME_TX], pnlForOther, 2024);
    const csv = renderOecdCarfCsv(rows);
    expect(csv).toContain('reporting_period');
    expect(csv).toContain('asset_type');
    expect(csv).toContain('tx_type');
    expect(csv).toContain('user_jurisdiction');
  });
});

// ─── Dispatcher tests ────────────────────────────────────────────────────────

describe('exportCsv dispatcher', () => {
  it('routes NG jurisdiction to nigeria-firs schema', () => {
    const result = exportCsv({
      classified: [INCOME_TX],
      pnl: pnlForNg,
      jurisdiction: 'NG',
      taxYear: 2024,
    });
    expect(result.schema).toBe('nigeria-firs');
    expect(result.filename).toContain('nigeria-firs');
  });

  it('routes KE jurisdiction to kenya-kra schema', () => {
    const result = exportCsv({
      classified: [INCOME_TX],
      pnl: pnlForKe,
      jurisdiction: 'KE',
      taxYear: 2024,
    });
    expect(result.schema).toBe('kenya-kra');
    expect(result.filename).toContain('kenya-kra');
  });

  it('routes OTHER jurisdiction to oecd-carf schema', () => {
    const result = exportCsv({
      classified: [INCOME_TX],
      pnl: pnlForOther,
      jurisdiction: 'OTHER',
      taxYear: 2024,
    });
    expect(result.schema).toBe('oecd-carf');
    expect(result.filename).toContain('oecd-carf');
  });

  it('includes taxYear in filename', () => {
    const result = exportCsv({
      classified: [INCOME_TX],
      pnl: pnlForNg,
      jurisdiction: 'NG',
      taxYear: 2023,
    });
    expect(result.filename).toContain('2023');
    expect(result.filename).toContain('agent-06-2023-nigeria-firs.csv');
  });

  it('returns rowCount matching classified txs (excluding GAS, with multi-leg)', () => {
    // Post-fix 2026-06-14: NG now emits one row per asset leg.
    // INCOME=1, SWAP=2, YIELD=1, GAS=0 → 4 rows.
    const result = exportCsv({
      classified: [INCOME_TX, SWAP_TX, GAS_TX, YIELD_TX],
      pnl: pnlForNg,
      jurisdiction: 'NG',
      taxYear: 2024,
    });
    expect(result.rowCount).toBe(4);
  });

  it('returns a non-empty CSV string', () => {
    const result = exportCsv({
      classified: [INCOME_TX],
      pnl: pnlForNg,
      jurisdiction: 'NG',
      taxYear: 2024,
    });
    expect(result.csv.length).toBeGreaterThan(0);
    expect(result.csv).toContain('\n');
  });

  it('NG CSV contains NGN column header', () => {
    const result = exportCsv({
      classified: [INCOME_TX],
      pnl: pnlForNg,
      jurisdiction: 'NG',
      taxYear: 2024,
    });
    expect(result.csv).toContain('price_ngn');
    expect(result.csv).toContain('gain_loss_ngn');
    // Fix 2026-06-14: interest_earned column surfaces vault WITHDRAW gains.
    expect(result.csv).toContain('interest_earned_ngn');
  });

  it('KE CSV contains interest_earned column header (Quan feedback 2026-06-14)', () => {
    const result = exportCsv({
      classified: [INCOME_TX],
      pnl: pnlForKe,
      jurisdiction: 'KE',
      taxYear: 2024,
    });
    expect(result.csv).toContain('interest_earned_kes');
  });

  it('OTHER CSV contains interest_earned column header (Quan feedback 2026-06-14)', () => {
    const result = exportCsv({
      classified: [INCOME_TX],
      pnl: pnlForOther,
      jurisdiction: 'OTHER',
      taxYear: 2024,
    });
    expect(result.csv).toContain('interest_earned_usd');
  });

  it('vault DEPOSIT row is labeled `deposit`, not `income` (Quan feedback 2026-06-14)', () => {
    // YIELD with vaultAddress + assetIn (shares) and no assetOut = vault
    // DEPOSIT. Previously labeled 'income' which inflated the income line
    // for any vault user (e.g. KE 0xBE19 showed 5374.90 income for a
    // single deposit with no disposals).
    const VAULT = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa0001' as Address;
    const depositTx: ClassifiedTx = {
      hash: '0x9999999999999999999999999999999999999999999999999999999999999999' as TxHash,
      timestamp: 1_716_662_400,
      type: 'YIELD',
      assetIn: { symbol: 'USDyc', amount: '5000000000', priceUsd: 1.0 },
      classifierSource: 'rule',
      vaultAddress: VAULT,
    };
    const result = exportCsv({
      classified: [depositTx],
      pnl: pnlForKe,
      jurisdiction: 'KE',
      taxYear: 2024,
    });
    // Type column = 'deposit', not 'income'.
    const dataLine = result.csv.split('\n')[1]!;
    expect(dataLine.split(',')[1]).toBe('deposit');
  });

  it('KE CSV contains DAT column header', () => {
    const result = exportCsv({
      classified: [SWAP_TX],
      pnl: pnlForKe,
      jurisdiction: 'KE',
      taxYear: 2024,
    });
    expect(result.csv).toContain('dat_due_kes');
    expect(result.csv).toContain('gross_transfer_value_kes');
  });

  it('OTHER CSV contains CARF column headers', () => {
    const result = exportCsv({
      classified: [INCOME_TX],
      pnl: pnlForOther,
      jurisdiction: 'OTHER',
      taxYear: 2024,
    });
    expect(result.csv).toContain('reporting_period');
    expect(result.csv).toContain('asset_type');
    expect(result.csv).toContain('user_jurisdiction');
  });

  it('handles empty classified array gracefully', () => {
    const result = exportCsv({
      classified: [],
      pnl: pnlForNg,
      jurisdiction: 'NG',
      taxYear: 2024,
    });
    expect(result.rowCount).toBe(0);
    // CSV should still have a header row
    const lines = result.csv.split('\n').filter(Boolean);
    expect(lines).toHaveLength(1);
    expect(lines[0]!).toContain('tx_date');
  });

  it('handles all three jurisdictions in sequence without cross-contamination', () => {
    const tx = INCOME_TX;
    const ng = exportCsv({ classified: [tx], pnl: pnlForNg, jurisdiction: 'NG', taxYear: 2024 });
    const ke = exportCsv({ classified: [tx], pnl: pnlForKe, jurisdiction: 'KE', taxYear: 2024 });
    const other = exportCsv({ classified: [tx], pnl: pnlForOther, jurisdiction: 'OTHER', taxYear: 2024 });

    expect(ng.csv).toContain('price_ngn');
    expect(ng.csv).not.toContain('dat_due_kes');

    expect(ke.csv).toContain('dat_due_kes');
    expect(ke.csv).not.toContain('price_ngn');

    expect(other.csv).toContain('asset_type');
    expect(other.csv).not.toContain('price_ngn');
    expect(other.csv).not.toContain('dat_due_kes');
  });
});

// ─── Fix #7: assetLabel fallback chain regression tests ───────────────────────

describe('assetLabel fallback chain (Fix #7)', () => {
  // Case (a): symbol wins over assetName
  it('symbol wins when both symbol and assetName are present (NG)', () => {
    const tx: ClassifiedTx = {
      hash: '0xabcd000000000000000000000000000000000000000000000000000000001234',
      type: 'INCOME',
      timestamp: 1_704_067_200,
      assetIn: { symbol: 'cUSD', assetName: 'KarmenMezz_JOT', amount: '1000000000000000000', priceUsd: 1.0 },
      classifierSource: 'rule',
    };
    const rows = buildNigeriaFirsRows([tx], pnlForNg, 2024);
    expect(rows[0]!.asset).toBe('cUSD');
  });

  it('symbol wins when both symbol and assetName are present (KE)', () => {
    const tx: ClassifiedTx = {
      hash: '0xabcd000000000000000000000000000000000000000000000000000000001234',
      type: 'INCOME',
      timestamp: 1_704_067_200,
      assetIn: { symbol: 'CELO', assetName: 'KarmenMezz_JOT', amount: '1000000000000000000', priceUsd: 0.6 },
      classifierSource: 'rule',
    };
    const rows = buildKenyaKraRows([tx]);
    expect(rows[0]!.asset).toBe('CELO');
  });

  it('OTHER: symbol wins over assetName in asset_type stablecoin mapping', () => {
    // OECD CARF has no 'asset' label field — it uses asset_type. Verify the
    // assetLabel() is computed correctly by checking the symbol maps to
    // stablecoin (USDC is a known stablecoin).
    const tx: ClassifiedTx = {
      hash: '0xabcd000000000000000000000000000000000000000000000000000000001234',
      type: 'INCOME',
      timestamp: 1_704_067_200,
      assetIn: { symbol: 'USDC', assetName: 'KarmenMezz_JOT', amount: '1000000000000000000', priceUsd: 1.0 },
      classifierSource: 'rule',
    };
    const rows = buildOecdCarfRows([tx], pnlForOther, 2024);
    expect(rows[0]!.asset_type).toBe('stablecoin');
  });

  // Case (b): assetName used when symbol is absent
  it('assetName used when symbol is absent (NG)', () => {
    const tx: ClassifiedTx = {
      hash: '0xfade00000000000000000000000000000000000000000000000000000000cafe',
      type: 'INCOME',
      timestamp: 1_704_067_200,
      assetIn: { symbol: '', assetName: 'KarmenMezz_JOT', amount: '1000000000000000000', priceUsd: 1.0 },
      classifierSource: 'rule',
    };
    const rows = buildNigeriaFirsRows([tx], pnlForNg, 2024);
    expect(rows[0]!.asset).toBe('KarmenMezz_JOT');
  });

  it('assetName used when symbol is absent (KE)', () => {
    const tx: ClassifiedTx = {
      hash: '0xfade00000000000000000000000000000000000000000000000000000000cafe',
      type: 'INCOME',
      timestamp: 1_704_067_200,
      assetIn: { symbol: '', assetName: 'KarmenMezz_JOT', amount: '1000000000000000000', priceUsd: 0.6 },
      classifierSource: 'rule',
    };
    const rows = buildKenyaKraRows([tx]);
    expect(rows[0]!.asset).toBe('KarmenMezz_JOT');
  });

  it('OTHER: assetName used when symbol is absent — asset_type becomes other_crypto', () => {
    // OECD has no 'asset' label field; empty symbol → asset_type = other_crypto.
    const tx: ClassifiedTx = {
      hash: '0xfade00000000000000000000000000000000000000000000000000000000cafe',
      type: 'INCOME',
      timestamp: 1_704_067_200,
      assetIn: { symbol: '', assetName: 'KarmenMezz_JOT', amount: '1000000000000000000', priceUsd: 1.0 },
      classifierSource: 'rule',
    };
    const rows = buildOecdCarfRows([tx], pnlForOther, 2024);
    expect(rows[0]!.asset_type).toBe('other_crypto');
  });

  // Case (c): shortened address when neither symbol nor assetName is present
  it('shortened address used when neither symbol nor assetName is present (NG)', () => {
    const tx: ClassifiedTx = {
      hash: '0x37f700000000000000000000000000000000000000000000000000000000abcd',
      type: 'SWAP',
      timestamp: 1_716_662_400,
      assetIn: { symbol: '', assetName: '', amount: '1', priceUsd: 1.0 },
      assetOut: { symbol: '', assetName: '', amount: '1', priceUsd: 0.65 },
      classifierSource: 'rule',
    };
    const rows = buildNigeriaFirsRows([tx], pnlForNg, 2024);
    // assetIn is preferred; first 6 hex chars after '0x' = '37F700'
    expect(rows[0]!.asset).toBe('Token@37F700');
  });

  it('shortened address used when neither symbol nor assetName is present (KE)', () => {
    const tx: ClassifiedTx = {
      hash: '0x37f700000000000000000000000000000000000000000000000000000000abcd',
      type: 'SWAP',
      timestamp: 1_716_662_400,
      assetIn: { symbol: '', assetName: '', amount: '1', priceUsd: 1.0 },
      assetOut: { symbol: '', assetName: '', amount: '1', priceUsd: 0.65 },
      classifierSource: 'rule',
    };
    const rows = buildKenyaKraRows([tx]);
    expect(rows[0]!.asset).toBe('Token@37F700');
  });

  it('OTHER: neither symbol nor assetName — asset_type becomes other_crypto', () => {
    // OECD has no 'asset' label field; empty symbol → asset_type = other_crypto.
    const tx: ClassifiedTx = {
      hash: '0x37f700000000000000000000000000000000000000000000000000000000abcd',
      type: 'SWAP',
      timestamp: 1_716_662_400,
      assetIn: { symbol: '', assetName: '', amount: '1', priceUsd: 1.0 },
      assetOut: { symbol: '', assetName: '', amount: '1', priceUsd: 0.65 },
      classifierSource: 'rule',
    };
    const rows = buildOecdCarfRows([tx], pnlForOther, 2024);
    expect(rows[0]!.asset_type).toBe('other_crypto');
  });
});
