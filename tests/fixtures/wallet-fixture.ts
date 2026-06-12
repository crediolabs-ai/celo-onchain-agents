/**
 * Hand-crafted wallet fixture for the demo and orchestrator tests.
 *
 * Owner: Credio (orchestrator).
 *
 * Mirrors a "Year 1 on Celo" MiniPay-style wallet:
 *  - 3 income/reward events (CELO staking, cUSD rewards, GoodDollar UBI)
 *  - 1 swap (CELO → cUSD)
 *  - 1 transfer-out (gift)
 *  - 1 gas-only tx (failed approval)
 *  - 1 flagged bridge event
 *
 * Every event is anchored to a deterministic timestamp in 2024 so the
 * PNL year-summary is non-trivial. The fixture is small enough to read
 * in one screen but exercises every classification rule + the FIFO
 * multi-lot disposal path.
 *
 * Tuan's demo (`src/cli/demo.ts`) imports this directly so the demo
 * and the orchestrator test suite share the same data.
 */

import type {
  Address,
  ClassifiedTx,
  ClassifyOutput,
  CsvExportResult,
  FetchedTxData,
  PnlOutput,
  RawTx,
  TokenTransfer,
  Timestamp,
} from '../../src/shared/types.js';
import type { WalletFixture } from '../../src/orchestrator/types.js';
import { mkHash } from './mk-hash.js';
import { exportCsv } from '../../src/sub-agents/csv-exporter/index.js';

const ADDR = '0x0000000000000000000000000000000000000abc' as Address;

const TS = {
  income1: 1_704_067_200 as Timestamp, // 2024-01-01 — CELO staking reward
  swap: 1_716_662_400 as Timestamp, // 2024-05-15 — CELO → cUSD
  income2: 1_725_187_200 as Timestamp, // 2024-09-01 — GoodDollar UBI
  transfer: 1_730_400_000 as Timestamp, // 2024-10-15 — gift transfer
  bridge: 1_733_529_600 as Timestamp, // 2024-12-01 — bridge to L2
} as const;

const rawTxns: RawTx[] = [
  // CELO staking claim (INCOME on the classifier side)
  {
    hash: mkHash('aa'),
    blockNumber: 1_000_000,
    timestamp: TS.income1,
    from: '0x0000000000000000000000000000000000000def' as Address, // staking contract
    to: ADDR,
    value: '1000000000000000000', // 1 CELO
    gasUsed: '50000',
    gasPrice: '5000000000',
    input: '0x',
    isError: '0',
  },
  // Swap: CELO → cUSD via Ubeswap
  {
    hash: mkHash('bb'),
    blockNumber: 1_050_000,
    timestamp: TS.swap,
    from: ADDR,
    to: '0x0000000000000000000000000000000000000fee' as Address, // router
    value: '2000000000000000000', // 2 CELO
    gasUsed: '150000',
    gasPrice: '5000000000',
    input: '0x',
    methodName: 'swapExactTokensForTokens',
    isError: '0',
  },
  // GoodDollar UBI claim
  {
    hash: mkHash('cc'),
    blockNumber: 1_100_000,
    timestamp: TS.income2,
    from: '0x0000000000000000000000000000000000000d0d' as Address,
    to: ADDR,
    value: '0',
    gasUsed: '80000',
    gasPrice: '5000000000',
    input: '0x',
    isError: '0',
  },
  // Gift transfer out
  {
    hash: mkHash('dd'),
    blockNumber: 1_150_000,
    timestamp: TS.transfer,
    from: ADDR,
    to: '0x0000000000000000000000000000000000000bbb' as Address,
    value: '500000000000000000', // 0.5 CELO
    gasUsed: '21000',
    gasPrice: '5000000000',
    input: '0x',
    isError: '0',
  },
  // Bridge event (will be flagged for review by the classifier)
  {
    hash: mkHash('ee'),
    blockNumber: 1_200_000,
    timestamp: TS.bridge,
    from: ADDR,
    to: '0x0000000000000000000000000000000000000b12' as Address, // CELO native bridge
    value: '1000000000000000000', // 1 CELO
    gasUsed: '200000',
    gasPrice: '5000000000',
    input: '0x',
    methodName: 'deposit',
    isError: '0',
  },
];

const tokenTransfers: TokenTransfer[] = [
  {
    hash: rawTxns[0]!.hash,
    blockNumber: 1_000_000,
    timestamp: TS.income1,
    from: '0x0000000000000000000000000000000000000def' as Address,
    to: ADDR,
    contractAddress: '0x0000000000000000000000000000000000000c01' as Address,
    tokenSymbol: 'CELO',
    tokenDecimals: 18,
    value: '1000000000000000000', // 1 CELO
  },
  {
    hash: rawTxns[1]!.hash,
    blockNumber: 1_050_000,
    timestamp: TS.swap,
    from: ADDR,
    to: '0x0000000000000000000000000000000000000fee' as Address,
    contractAddress: '0x0000000000000000000000000000000000000c01' as Address,
    tokenSymbol: 'CELO',
    tokenDecimals: 18,
    value: '2000000000000000000', // 2 CELO out
  },
  {
    hash: rawTxns[1]!.hash,
    blockNumber: 1_050_000,
    timestamp: TS.swap,
    from: '0x0000000000000000000000000000000000000fee' as Address,
    to: ADDR,
    contractAddress: '0x0000000000000000000000000000000000000c02' as Address,
    tokenSymbol: 'cUSD',
    tokenDecimals: 18,
    value: '2500000000000000000000', // 2500 cUSD in (rough swap ratio)
  },
  {
    hash: rawTxns[2]!.hash,
    blockNumber: 1_100_000,
    timestamp: TS.income2,
    from: '0x0000000000000000000000000000000000000d0d' as Address,
    to: ADDR,
    contractAddress: '0x0000000000000000000000000000000000000c03' as Address,
    tokenSymbol: 'G$',
    tokenDecimals: 18,
    value: '1000000000000000000000', // 1000 G$
  },
  {
    hash: rawTxns[3]!.hash,
    blockNumber: 1_150_000,
    timestamp: TS.transfer,
    from: ADDR,
    to: '0x0000000000000000000000000000000000000bbb' as Address,
    contractAddress: '0x0000000000000000000000000000000000000c01' as Address,
    tokenSymbol: 'CELO',
    tokenDecimals: 18,
    value: '500000000000000000', // 0.5 CELO
  },
  {
    hash: rawTxns[4]!.hash,
    blockNumber: 1_200_000,
    timestamp: TS.bridge,
    from: ADDR,
    to: '0x0000000000000000000000000000000000000b12' as Address,
    contractAddress: '0x0000000000000000000000000000000000000c01' as Address,
    tokenSymbol: 'CELO',
    tokenDecimals: 18,
    value: '1000000000000000000', // 1 CELO
  },
];

const fetched: FetchedTxData = {
  address: ADDR,
  dateRange: { from: TS.income1, to: TS.bridge },
  rawTxns,
  tokenTransfers,
  internalTxns: [],
  source: 'celoscan',
  fetchedAt: TS.bridge + 1,
  paginationComplete: true,
  fetchErrors: [],
  contractMetadata: new Map(),
};

const classified: ClassifyOutput = {
  classified: [
    {
      hash: rawTxns[0]!.hash,
      type: 'INCOME',
      timestamp: TS.income1,
      assetIn: { symbol: 'CELO', amount: '1000000000000000000', priceUsd: 0.6 },
      classifierSource: 'rule',
    },
    {
      hash: rawTxns[1]!.hash,
      type: 'SWAP',
      timestamp: TS.swap,
      assetIn: { symbol: 'cUSD', amount: '2500000000000000000000', priceUsd: 1.0 },
      assetOut: { symbol: 'CELO', amount: '2000000000000000000', priceUsd: 0.65 },
      classifierSource: 'rule',
    },
    {
      hash: rawTxns[2]!.hash,
      type: 'YIELD',
      timestamp: TS.income2,
      assetIn: { symbol: 'G$', amount: '1000000000000000000000', priceUsd: 0.001 },
      classifierSource: 'rule',
    },
    {
      hash: rawTxns[3]!.hash,
      type: 'TRANSFER_OUT',
      timestamp: TS.transfer,
      assetOut: { symbol: 'CELO', amount: '500000000000000000', priceUsd: 0.7 },
      classifierSource: 'rule',
    },
    {
      hash: rawTxns[4]!.hash,
      type: 'BRIDGE',
      timestamp: TS.bridge,
      assetOut: { symbol: 'CELO', amount: '1000000000000000000', priceUsd: 0.75 },
      classifierSource: 'flagged',
    },
  ] satisfies ClassifiedTx[],
  flaggedForReview: [rawTxns[4]!.hash],
  ruleHits: 4,
  llmFallbacks: 0,
  interactionBreakdown: {},
};

const pnl: PnlOutput = {
  address: ADDR,
  method: 'FIFO',
  taxYears: [
    {
      year: 2024,
      realizedGains: 0.05,
      income: 0.6,
      yield: 1.0,
      deductibleGas: 0,
      taxableIncome: 0.65,
    },
  ],
  realizedPnlByAsset: { CELO: 0.05 },
  unrealizedPnlByAsset: {},
  incomeTotal: 0.6,
  yieldTotal: 1.0,
  priceGaps: [],
  methodJurisdictionCompat: [
    { method: 'FIFO', jurisdiction: 'NG', ok: true, reason: 'FIFO is the legally required default for this jurisdiction.' },
    { method: 'FIFO', jurisdiction: 'KE', ok: true, reason: 'FIFO is the legally required default for this jurisdiction.' },
    { method: 'FIFO', jurisdiction: 'OTHER', ok: true },
  ],
  disposals: [],
};

const csv: CsvExportResult = exportCsv({
  classified: classified.classified,
  pnl,
  jurisdiction: 'NG',
  taxYear: 2024,
});

/** A single fixture covering a full year of MiniPay-style activity. */
export const walletFixture: WalletFixture = {
  address: ADDR,
  network: 'alfajores',
  fetched,
  classified,
  pnl,
  csv,
};
