// Real agent output data from mainnet run on ERC-8004 deployer wallet.
// Source: /home/admin/git/.../plans/mainnet-test/reports/v1-to-v2-migration.md
// Verified 2026-06-11.

export const agentOutput = {
  address: "0x46788b60daf46448668c7abaeea4ac8745451c25",
  addressShort: "0x4678…1c25",
  network: "Celo mainnet",
  jurisdiction: "NG",
  taxYear: 2025,
  method: "FIFO",

  // Fetch stats
  rawTxns: 194,
  tokenTransfers: 1,
  internalTxns: 0,
  fetchErrors: 0,
  wallClockMs: 1326,   // first run, 37ms cached
  wallClockCachedMs: 37,

  // Classification stats
  classified: 194,
  ruleHits: 33,
  llmFallbacks: 0,
  flaggedForReview: 161,

  // PNL (operator wallet, no user-level activity)
  realizedGains: 0,
  income: 0,
  yield: 0,
  deductibleGas: 0,
  taxableIncome: 0,

  // Output
  csvRows: 194,
  csvSchema: "nigeria-firs",
  csvFile: "agent-06-2025-nigeria-firs.csv",
} as const;

export const command = `pnpm dev --address ${agentOutput.address} \\
  --jurisdiction ${agentOutput.jurisdiction} \\
  --tax-year ${agentOutput.taxYear} \\
  --output report.csv`;

export const problem = {
  audience: "15M+ MiniPay users",
  regions: "Nigeria + Kenya",
  enforcement: "FIRS ₦5M threshold + KRA 3% DAT (2026)",
  gap: "Koinly, CoinTracker: no Celo-native, no FIRS/KRA, no MiniPay integration",
} as const;

export const tracks = {
  track1: "Best Agent on Celo — $2.5K",
  track2: "Most Onchain Activity — $500",
  track3: "Highest 8004scan rank — $500",
} as const;
