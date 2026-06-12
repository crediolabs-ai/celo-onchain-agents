# Celo Tax & Portfolio Agent — MCP Server

**Phase C** — exposes 7 working tools for the Agent 06 (Celo Tax & Portfolio) agentic workflow. Implementation is **raw JSON-RPC 2.0 over stdio** (no `@modelcontextprotocol/sdk` runtime dependency — the SDK has a Zod compat bug in 1.29.0 that breaks server-side tool discovery, see `plans/reports/mcp-server-260612-0723-agent06-phase-b.md` for details).

> This module is standalone and has no dependency on the parent agent monorepo.

## Prerequisites

- Node.js `>=20.18`
- `npm` or `pnpm`
- (Optional) Celoscan API key for higher rate limits — [get one at celoscan.io](https://celoscan.io/apis)

## Quickstart

```bash
# 1. Enter the server directory
cd mcp-server

# 2. Install dependencies
npm install

# 3. Configure environment
cp .env.example .env
# Edit .env and fill in your keys:
#   CELOSCAN_API_KEY=your_key_here   (strongly recommended)
#   COINGECKO_API_KEY=               (optional, free tier works)

# 4. Start the server (stdio transport — for local MCP agent use)
npm run dev
```

The server starts on **stdio** — it communicates over stdin/stdout with the MCP client. All logging goes to stderr so it doesn't corrupt the transport.

## Tool Inventory

### `get_celo_portfolio` (P0)

Retrieve all holdings (native CELO + known ERC-20s) with USD valuations.

**Input:**

```json
{
  "address": "0x46788b60daf46448668c7abaeea4ac8745451c25",
  "network": "mainnet"   // optional, default: "mainnet"
}
```

**Output:**

```json
{
  "address": "0x46788b60daf46448668c7abaeea4ac8745451c25",
  "network": "mainnet",
  "chainId": 42220,
  "holdings": [
    {
      "token": "CELO",
      "symbol": "CELO",
      "balance": "123456789000000000000",
      "decimals": 18,
      "usdValue": 187.25,
      "contractAddress": "0x471EcE3750Da237f93B8E339c536989b8978a438",
      "isNative": true
    }
  ],
  "totalUsdValue": 187.25,
  "fetchedAt": "2026-06-12T08:00:00.000Z"
}
```

**Data sources:** Celo RPC (via viem) for balances, CoinGecko for USD prices.

---

### `get_celo_transaction_history` (P0)

Retrieve transaction history for a Celo address from Celoscan.

**Input:**

```json
{
  "address": "0x46788b60daf46448668c7abaeea4ac8745451c25",
  "network": "mainnet",
  "fromBlock": 0,          // optional
  "toBlock": 99999999,    // optional
  "page": 1,              // optional, default: 1
  "offset": 100           // optional, default: 100, max: 100
}
```

**Output:**

```json
{
  "address": "0x46788b60daf46448668c7abaeea4ac8745451c25",
  "network": "mainnet",
  "chainId": 42220,
  "transactions": [
    {
      "hash": "0xabc123...",
      "blockNumber": 19876543,
      "from": "0x46788b60daf46448668c7abaeea4ac8745451c25",
      "to": "0x...",
      "value": "1000000000000000000",
      "timestamp": 1718180808,
      "isError": false,
      "functionSelector": null,
      "input": null
    }
  ],
  "totalReturned": 100,
  "page": 1,
  "hasMore": true,
  "fetchedAt": "2026-06-12T08:00:00.000Z"
}
```

**Data source:** Celoscan V2 API (`https://api.etherscan.io/v2/api?chainid=42220`).

---

### `get_token_price_history` (P0)

Returns historical USD price series for Celo native tokens over a date range. Uses CoinGecko `market_chart/range` endpoint (1 API call per token). Gaps in data are returned as `null` prices.

**Input:**

```json
{
  "tokens": ["CELO", "cUSD"],      // optional, default: all 6 native tokens
  "fromDate": "2025-01-01",        // required, YYYY-MM-DD (inclusive, UTC)
  "toDate": "2025-12-31",          // required, YYYY-MM-DD (inclusive, UTC)
  "interval": "daily"              // optional, default: "daily"
}
```

**Output:**

```json
{
  "fromDate": "2025-01-01",
  "toDate": "2025-12-31",
  "interval": "daily",
  "series": {
    "CELO": [{ "date": "2025-01-01", "priceUsd": 0.621 }, ...],
    "cUSD": [{ "date": "2025-01-01", "priceUsd": 1.001 }, ...]
  },
  "gaps": [],
  "fetchedAt": "2026-06-12T08:00:00.000Z"
}
```

**Data source:** CoinGecko `/coins/{id}/market_chart/range`.

---

### `calculate_tax_liability` (P0)

Computes realized capital gains, income, yield, and tax owed for a Celo wallet over a tax year in the given jurisdiction. Pipeline: fetch (Celoscan) → classify (rule-only) → price (CoinGecko) → FIFO PNL → jurisdiction tax rules.

**Input:**

```json
{
  "address": "0x46788b60daf46448668c7abaeea4ac8745451c25",
  "taxYear": 2025,                // required, integer 2020–2030
  "jurisdiction": "NG",          // optional, default: "NG" (NG | KE | OTHER)
  "method": "FIFO",                // optional, default: "FIFO" (FIFO | LIFO | WAC)
  "network": "mainnet",          // optional, default: "mainnet"
  "fromBlock": 0,                 // optional
  "toBlock": 99999999             // optional
}
```

**Output:**

```json
{
  "address": "0x4678…",
  "taxYear": 2025,
  "jurisdiction": "NG",
  "method": "FIFO",
  "summary": {
    "realizedGainsUsd": 1234.56,
    "incomeUsd": 800.00,
    "yieldUsd": 12.30,
    "deductibleGasUsd": 3.45,
    "taxableIncomeUsd": 2043.41
  },
  "taxDue": {
    "cgtUsd": 123.45,
    "cgtNgn": 191350.00,
    "incomeTaxUsd": 240.00,
    "totalNgn": 568100.00
  },
  "methodJurisdictionCompat": [{ "method": "FIFO", "jurisdiction": "NG", "ok": true }],
  "priceGaps": [],
  "disposalsCount": 47,
  "computedAt": "2026-06-12T08:00:00.000Z"
}
```

**Data sources:** Celoscan (transactions + token transfers), CoinGecko (historical prices).

---

### `get_staking_rewards` (P1)

Returns Celo validator/epoch staking rewards for an address. Uses transfer-heuristic (v1): groups of ≥2 identical-amount CELO transfers from the same sender within ≤7 days are flagged as staking rewards.

**Input:**

```json
{
  "address": "0x46788b60daf46448668c7abaeea4ac8745451c25",
  "network": "mainnet",          // optional, default: "mainnet"
  "fromTimestamp": 1704067200,   // optional, Unix seconds (inclusive)
  "toTimestamp": 1735689600      // optional, Unix seconds (inclusive)
}
```

**Output:**

```json
{
  "address": "0x4678…",
  "network": "mainnet",
  "totalRewardsCel": "0.450000000000000000",
  "rewards": [
    {
      "txHash": "0xabc…",
      "blockNumber": 12345678,
      "timestamp": 1735689600,
      "amountCel": "0.150000000000000000",
      "amountUsd": 0.0945,
      "validatorGroup": "0xVAL_GROUP_ADDR"
    }
  ],
  "epochCount": 3,
  "dataSource": "transfer-heuristic",
  "caveats": ["STAKING_REWARD_DISTRIBUTOR address is null — using transfer heuristic (v1)."],
  "fetchedAt": "2026-06-12T08:00:00.000Z"
}
```

**Data source:** Celoscan CELO token transfers + CoinGecko spot price.

---

### `generate_tax_report` (P1)

Composes a full tax report for a Celo wallet + tax year in the requested jurisdiction CSV format. Returns CSV (string + base64), structured summary, and tax due.

**Input:**

```json
{
  "address": "0x46788b60daf46448668c7abaeea4ac8745451c25",
  "taxYear": 2025,                // required
  "jurisdiction": "NG",          // optional, default: "NG" (NG | KE | OTHER)
  "method": "FIFO",              // optional, default: "FIFO"
  "network": "mainnet",          // optional, default: "mainnet"
  "outputFormat": "both"         // optional, default: "both" (json | csv | both)
}
```

**Output:**

```json
{
  "address": "0x4678…",
  "taxYear": 2025,
  "jurisdiction": "NG",
  "schema": "nigeria-firs",
  "filename": "agent-06-2025-nigeria-firs-0x4678….csv",
  "rowCount": 47,
  "csv": "tx_date,type,asset,amount,price_ngn,…",
  "csvBase64": "dHhfZGF0ZSx0eXBlLC4uLg==",
  "summary": { "realizedGainsUsd": 1234.56, "incomeUsd": 800.00, … },
  "taxDue": { "cgtUsd": 123.45, "cgtNgn": 191350.00, … },
  "disclaimer": "This report is generated by an automated system. Verify with a qualified tax professional before filing.",
  "computedAt": "2026-06-12T08:00:00.000Z"
}
```

**Data sources:** Celoscan, CoinGecko, jurisdiction CSV schemas (nigeria-firs, kenya-kra, oecd-carf).

---

### `get_carf_report` (P2)

Returns an OECD CARF (Crypto-Asset Reporting Framework) report for a Celo wallet over a multi-year range. Includes CARF metadata, userJurisdiction, and framework version.

**Input:**

```json
{
  "address": "0x46788b60daf46448668c7abaeea4ac8745451c25",
  "network": "mainnet",          // optional, default: "mainnet"
  "fromYear": 2024,              // required, integer 2020–2030
  "toYear": 2025,               // required, integer 2020–2030
  "userJurisdiction": "NG"      // required, ISO 3166-1 alpha-2 country code
}
```

**Output:**

```json
{
  "address": "0x4678…",
  "userJurisdiction": "NG",
  "reportingPeriod": "2024-01-01_2025-12-31",
  "schemaVersion": "oecd-carf-v0",
  "reportType": "CARF",
  "filename": "agent-06-CARF-2024-2025-NG-0x4678b60d.csv",
  "rowCount": 4,
  "csv": "reporting_period,tx_date,asset_type,tx_type,gross_proceeds_usd,…",
  "csvBase64": "Li4u",
  "summary": {
    "totalGrossProceedsUsd": 1234.56,
    "totalCostBasisUsd": 800.00,
    "totalPnlUsd": 434.56,
    "byAssetType": { "stablecoin": { "count": 1, "pnlUsd": 100 }, "other_crypto": { "count": 3, "pnlUsd": 334.56 } }
  },
  "carfMetadata": {
    "reportingEntity": "0x4678…",
    "taxResidency": "NG",
    "reportableTransactions": 4,
    "frameworkVersion": "OECD-CARF-2022",
    "notes": "Per OECD CARF §III, reportable crypto-asset transactions…"
  },
  "yearSummaries": [
    { "year": 2024, "realizedGainsUsd": 100, "incomeUsd": 50, … },
    { "year": 2025, "realizedGainsUsd": 1134.56, "incomeUsd": 750, … }
  ],
  "fetchedAt": "2026-06-12T08:00:00.000Z"
}
```

**Data sources:** Celoscan, CoinGecko, OECD CARF CSV schema.

---

## Testing

Run integration tests against a live server:

```bash
# 2 existing tools (regression check)
npx tsx test/test-tools-direct.ts

# All 7 tools (list + call each)
npx tsx test/test-all-tools.ts

# generate_tax_report NG/KE/OTHER variant test
npx tsx test/test-generate-tax-report.ts
```

All tests:
1. Start the server as a child process over stdio
2. Send `initialize` + `notifications/initialized`
3. List tools (expects 7)
4. Call each tool with demo wallet `0x46788b60daf46448668c7abaeea4ac8745451c25`
5. Print results and clean up

## MCP Client Example

```javascript
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const transport = new StdioClientTransport({
  command: 'npm',
  args: ['run', 'dev'],
  cwd: '/path/to/mcp-server',
});

const client = new Client({ name: 'my-agent', version: '0.1.0' });
await client.connect(transport);

// List available tools
const { tools } = await client.request({ method: 'tools/list' });

// Call get_celo_portfolio
const result = await client.request({
  method: 'tools/call',
  params: {
    name: 'get_celo_portfolio',
    arguments: { address: '0x46788b60daf46448668c7abaeea4ac8745451c25', network: 'mainnet' },
  },
});

console.log(JSON.parse(result.content[0].text));
await client.close();
```

## Architecture

```
mcp-server/
├── src/
│   ├── server.ts                  # MCP server entry (stdio JSON-RPC)
│   ├── lib/
│   │   ├── coingecko.ts           # CoinGecko price + market_chart helpers
│   │   ├── http.ts                # fetchWithRetry + sleep helpers
│   │   ├── celoscan.ts           # Celoscan API client
│   │   ├── pipeline-core.ts       # Rule-engine + FIFO PNL (shared by tax tools)
│   │   └── csv-schemas/           # Ported jurisdiction schemas (nigeria-firs, kenya-kra, oecd-carf)
│   └── tools/
│       ├── get-celo-portfolio.ts         # P0: portfolio holdings + USD values
│       ├── get-celo-transaction-history.ts # P0: Celoscan tx history
│       ├── get-token-price-history.ts    # P0: historical CoinGecko prices
│       ├── calculate-tax-liability.ts    # P0: FIFO PNL + jurisdiction tax rules
│       ├── get-staking-rewards.ts       # P1: epoch staking rewards
│       ├── generate-tax-report.ts       # P1: full tax report CSV+JSON
│       └── get-carf-report.ts           # P2: OECD CARF multi-year report
├── test/
│   ├── test-tools-direct.ts       # Integration test (2 existing tools)
│   ├── test-generate-tax-report.ts # NG/KE/OTHER tax report test
│   └── test-all-tools.ts          # All 7 tools integration test
├── package.json
├── tsconfig.json
├── .env.example
└── README.md
```

**Transport:** stdio (no HTTP server) — suitable for local agent invocation.

**Dependencies kept minimal:** `viem` for chain I/O, `zod` for schema validation, `@modelcontextprotocol/sdk` for MCP protocol, `dotenv` for env loading. No ORM, no extra HTTP libs.

## Phase C — 7-Tool Inventory Complete

| Tool | Priority | Status |
|------|----------|--------|
| `get_celo_portfolio` | P0 | ✓ Done |
| `get_celo_transaction_history` | P0 | ✓ Done |
| `get_token_price_history` | P0 | ✓ Done (Wave 2) |
| `calculate_tax_liability` | P0 | ✓ Done (Wave 3) |
| `get_staking_rewards` | P1 | ✓ Done (Wave 4) |
| `generate_tax_report` | P1 | ✓ Done (Wave 5) |
| `get_carf_report` | P2 | ✓ Done (Wave 6) |

### Tool Inventory by Priority

**P0 — Core (required for tax computation):**
- `get_celo_portfolio` — wallet holdings + USD values
- `get_celo_transaction_history` — raw Celoscan transactions
- `get_token_price_history` — historical CoinGecko prices
- `calculate_tax_liability` — FIFO PNL + jurisdiction tax rules

**P1 — Reports:**
- `get_staking_rewards` — epoch staking rewards
- `generate_tax_report` — full tax report (CSV + JSON)

**P2 — Compliance:**
- `get_carf_report` — OECD CARF multi-year report
