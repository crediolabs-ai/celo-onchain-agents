# Celo Tax & Portfolio Agent — MCP Server

**Phase B foundation** — exposes 2 working tools for the Agent 06 (Celo Tax & Portfolio) agentic workflow. Implementation is **raw JSON-RPC 2.0 over stdio** (no `@modelcontextprotocol/sdk` runtime dependency — the SDK has a Zod compat bug in 1.29.0 that breaks server-side tool discovery, see `plans/reports/mcp-server-260612-0723-agent06-phase-b.md` for details).

> Full 7-tool inventory (P0/P1/P2) is **post-hackathon**. This module is standalone and has no dependency on the parent agent monorepo.

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

### `get_celo_portfolio`

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

### `get_celo_transaction_history`

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

## Testing

Run the integration test against a live server:

```bash
npx tsx test/test-tools.ts
```

The test:
1. Starts the server as a child process
2. Lists tools (expects 2)
3. Calls `get_celo_transaction_history` for a demo wallet
4. Calls `get_celo_portfolio` for the same address
5. Prints results and cleans up

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
│   ├── server.ts                  # MCP server entry (StdioServerTransport)
│   └── tools/
│       ├── get-celo-portfolio.ts         # P0: portfolio holdings + USD values
│       └── get-celo-transaction-history.ts # P0: Celoscan tx history
├── test/
│   └── test-tools.ts              # Integration test with real data
├── package.json
├── tsconfig.json
├── .env.example
└── README.md
```

**Transport:** stdio (no HTTP server) — suitable for local agent invocation.

**Dependencies kept minimal:** `viem` for chain I/O, `zod` for schema validation, `@modelcontextprotocol/sdk` for MCP protocol, `dotenv` for env loading. No ORM, no extra HTTP libs.

## Post-Hackathon (Full 7-Tool Inventory)

| Tool | Priority | Status |
|------|----------|--------|
| `get_celo_portfolio` | P0 | ✓ Done |
| `get_celo_transaction_history` | P0 | ✓ Done |
| `get_token_price_history` | P0 | Post-hack |
| `calculate_tax_liability` | P0 | Post-hack |
| `get_staking_rewards` | P1 | Post-hack |
| `generate_tax_report` | P1 | Post-hack |
| `get_carf_report` | P2 | Post-hack |
