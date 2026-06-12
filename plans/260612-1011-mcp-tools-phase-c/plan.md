---
title: "MCP Tools Phase C — 5 Remaining Tools (price history, tax liability, staking, tax report, CARF)"
description: "Implementation plan for the post-hackathon MCP tool inventory (3 P0/P1/P2 new) on top of the Phase B 2-tool foundation."
status: pending
priority: P0
effort: ~6-8h (1.5-2 days)
branch: main
tags: [mcp-server, agent-06, phase-c, tools, tax, celo, fifo, carf, kens, ng-firs]
created: 2026-06-12
---

# MCP Tools Phase C — Plan for the 5 Remaining Tools

**Owner:** planner (this plan) → fullstack-developer (implementation)
**Trigger:** User override of "post-hackathon" scope in `plans/reports/mcp-server-260612-0723-agent06-phase-b.md` and wiki `06-tools-mcp.md`. All 5 tools to be implemented now.
**Foundation:** `mcp-server/` (raw JSON-RPC 2.0 over stdio), 2 tools already shipped (`get_celo_portfolio`, `get_celo_transaction_history`).

---

## 0. Behavioral Checklist (Tech-Lead self-verification)

- [x] **Data flows documented** for each tool (input → sources → output)
- [x] **Dependency graph complete** — Wave ordering explicit; no phase starts before its blockers
- [x] **Risk assessed per tool** with likelihood × impact + mitigation
- [x] **Backwards compatibility strategy** — all 5 tools are **additive** to the JSON-RPC `tools/list` registry; existing 2 tools and tests are untouched
- [x] **Test matrix defined** — unit tests (Zod schemas, pure helpers), integration tests (real Celoscan + CoinGecko), E2E (demo wallet 0x4678…1c25)
- [x] **Rollback plan** — each tool is a single new file; revert = delete file + remove from `TOOL_DESCRIPTIONS` map in `src/server.ts:62-111`
- [x] **File ownership** — distinct files; no overlap with Phase A/B work
- [x] **Success criteria measurable** — `npx tsc --noEmit` clean, `tools/list` returns 7 tools, each new tool returns structured JSON on real demo data, no regression in the 2 existing tools

---

## 1. Shared Refactor Before Tool Implementation

**Blocker for all 5 tools** — `get-celo-portfolio.ts` has a copy-pasted `fetchCoinGeckoPrices` helper and a `fetchWithRetry`. Every new tool that needs CoinGecko will repeat this. Extract a shared module to honor DRY and keep each new tool ≤200 lines per KISS.

### 1.1 New file: `mcp-server/src/lib/coingecko.ts`

Exports:
- `COINGECKO_IDS: Record<string, string>` — moved from `get-celo-portfolio.ts:44-51`
- `fetchCoinGeckoPrices(symbols: string[], apiKey: string): Promise<Record<string, number>>` — moved from `get-celo-portfolio.ts:85-117`
- `fetchCoinGeckoPriceOnDate(coinId: string, date: Date, apiKey: string): Promise<number>` — new, for `get_token_price_history`
- `fetchCoinGeckoMarketChart(coinId: string, fromUnix: number, toUnix: number, apiKey: string): Promise<{ prices: [number, number][] }>` — new, bulk fetch for `get_token_price_history`

### 1.2 New file: `mcp-server/src/lib/http.ts`

Exports:
- `fetchWithRetry<T>(url: string, opts?: { retries?: number; headers?: Record<string,string> }): Promise<T>` — moved from both existing tools
- `sleep(ms: number): Promise<void>` — moved from `get-celo-transaction-history.ts:58-60`

### 1.3 Edit: `get-celo-portfolio.ts`

Replace inline helpers with imports from `lib/`. Net diff ≈ −40 lines, +4 lines of imports. Verify behavior unchanged via existing `test-tools-direct.ts` integration test.

**Effort:** S (30 min). **Files:** `mcp-server/src/lib/coingecko.ts` (new, ~80 lines), `mcp-server/src/lib/http.ts` (new, ~30 lines), `mcp-server/src/tools/get-celo-portfolio.ts` (edit, net −36 lines), `mcp-server/src/tools/get-celo-transaction-history.ts` (edit, net −6 lines).

**Risk:** Low — pure mechanical refactor; existing tests cover the helpers' behavior.

---

## 2. Tool 1 — `get_token_price_history` (P0)

### 2.1 Scope & Purpose

Returns the historical USD price for one or more Celo tokens over a date range. The output is consumed by the FIFO cost-basis engine (`src/sub-agents/pnl-calculator/fifo.ts:85`) and the CSV exporter's per-row USD valuation (`src/sub-agents/csv-exporter/schemas/oecd-carf.ts:128-129`) — it powers the **"price at acquisition"** lookup that makes realized PNL accurate to the day.

### 2.2 Input Schema

```json
{
  "type": "object",
  "properties": {
    "tokens": {
      "type": "array",
      "items": { "type": "string", "enum": ["CELO", "cUSD", "cEUR", "cREAL", "USDC", "USDT"] },
      "minItems": 1,
      "maxItems": 6,
      "description": "Celo token symbols to fetch (default: all 6 native tokens)"
    },
    "fromDate": { "type": "string", "pattern": "^\\d{4}-\\d{2}-\\d{2}$", "description": "Start date YYYY-MM-DD (inclusive, UTC)" },
    "toDate":   { "type": "string", "pattern": "^\\d{4}-\\d{2}-\\d{2}$", "description": "End date YYYY-MM-DD (inclusive, UTC)" },
    "interval": { "type": "string", "enum": ["daily"], "default": "daily" }
  },
  "required": ["fromDate", "toDate"]
}
```

**Validation rules (Zod):**
- `fromDate` ≤ `toDate`; if `toDate - fromDate` > 365 days, return `INVALID_INPUT` (CoinGecko free tier: 365-day range per request; 90-day chunks via pro).
- `tokens` defaults to all 6 Celo native tokens when omitted.

### 2.3 Output Schema

```json
{
  "fromDate": "2025-01-01",
  "toDate":   "2025-12-31",
  "interval": "daily",
  "series": {
    "CELO": [{ "date": "2025-01-01", "priceUsd": 0.621 }, ...],
    "cUSD": [{ "date": "2025-01-01", "priceUsd": 1.001 }, ...]
  },
  "fetchedAt": "2026-06-12T..."
}
```

Missing-day gaps: emit `null` for the `priceUsd` field (caller decides how to handle — same convention as `get_celo_portfolio`'s `null usdValue`).

### 2.4 Data Sources

| Source | What | File path |
|---|---|---|
| CoinGecko `/coins/{id}/market_chart/range` | Bulk daily USD prices in date range | `mcp-server/src/lib/coingecko.ts` (new) |
| `COINGECKO_IDS` map | Symbol → CoinGecko coin id | `mcp-server/src/tools/get-celo-portfolio.ts:44-51` (moved to lib) |

**Why `/market_chart/range` over `/history?date=`:** the per-date endpoint issues 1 HTTP call per (token, day). For a 1-year report on 6 tokens, that's 2,190 calls — way over CoinGecko free-tier rate limits. `/market_chart/range` is **1 call per token** (max 6 calls for 6 tokens). Reference: `.claude/skills/celo-chain-data.md:91-99`.

### 2.5 Required Env Vars

- `COINGECKO_API_KEY` — already in `mcp-server/.env.example:10` (optional, free tier works but slower).
- No new env vars.

### 2.6 Dependencies

- **Hard:** `mcp-server/src/lib/coingecko.ts` (Section 1.1).
- **Soft:** none. This is the leaf — every other tax-related tool consumes it.

### 2.7 Implementation Approach

1. Validate input (Zod, with date-range and token-list checks).
2. Convert `fromDate`/`toDate` → Unix timestamps (UTC midnight → midnight).
3. For each requested symbol, call `fetchCoinGeckoMarketChart(coinId, fromUnix, toUnix, apiKey)`.
4. Transform `[[unix, price], ...]` → `[{ date: 'YYYY-MM-DD', priceUsd: number }, ...]`.
5. Assemble `series` map, attach `fetchedAt`.
6. On CoinGecko failure for a single token: emit empty array for that token + a `gaps` field at top level listing `{ token, reason }` so the caller can surface partial data honestly.

**High-level:** reads CoinGecko market-chart API, writes a normalized series object. ~140 lines of new code (one new file).

### 2.8 Test Plan

| Test | Type | Fixture | Expectation |
|---|---|---|---|
| Happy path: 7-day range, 1 token | Unit | mocked `fetch` returning market_chart sample | 7 entries, correct dates, prices match |
| Multi-token (6 tokens, 30 days) | Unit | mocked `fetch` | 6 series × 30 entries each |
| Default token list (omitted) | Unit | mocked `fetch` | all 6 tokens queried |
| Invalid date range (`from > to`) | Unit | — | `INVALID_INPUT` error |
| Range > 365 days | Unit | — | `INVALID_INPUT` error |
| CoinGecko 429 | Unit | mocked `fetch` returning 429 | All tokens empty + `gaps[]` populated; no crash |
| E2E | Integration | `npx tsx test/test-tools-direct.ts` | Real CoinGecko data for `0x4678…1c25`; ≥5 days of CELO prices returned |

### 2.9 Error Handling

| Error | Envelope | Recovery |
|---|---|---|
| Bad input (regex/date logic) | `{ error: "INVALID_INPUT", message }` | Caller fixes; no retry |
| CoinGecko 4xx/5xx | `{ error: "COINGECKO_ERROR", message, gaps[] }` | Per-token gaps; partial result |
| CoinGecko 429 (rate limit) | `{ error: "COINGECKO_RATE_LIMIT", gaps[] }` | Caller waits 60s per `.claude/skills/celo-chain-data.md:123`; gap-fill via retry |

### 2.10 Estimated Effort

**S** (~1.5h). Mostly mechanical: schema + 1 API call + transform.

---

## 3. Tool 2 — `calculate_tax_liability` (P0)

### 3.1 Scope & Purpose

Computes the realized capital gains, income, yield, and tax owed for a Celo wallet over a tax year, in the user's jurisdiction. This is the **headline number** the agent surfaces: "You owe ₦1.2M FIRS CGT" or "You owe KES 9,800 KRA DAT for 2025."

### 3.2 Input Schema

```json
{
  "type": "object",
  "properties": {
    "address":   { "type": "string", "pattern": "^0x[0-9a-fA-F]{40}$" },
    "network":   { "type": "string", "enum": ["mainnet", "alfajores"], "default": "mainnet" },
    "taxYear":   { "type": "integer", "minimum": 2020, "maximum": 2030 },
    "jurisdiction": { "type": "string", "enum": ["NG", "KE", "OTHER"], "default": "NG" },
    "method":    { "type": "string", "enum": ["FIFO", "LIFO", "WAC"], "default": "FIFO" },
    "fromBlock": { "type": "integer", "minimum": 0, "description": "Optional block-range start (defaults to earliest)" },
    "toBlock":   { "type": "integer", "minimum": 0, "description": "Optional block-range end (defaults to latest)" }
  },
  "required": ["address", "taxYear"]
}
```

### 3.3 Output Schema

```json
{
  "address": "0x4678…",
  "network": "mainnet",
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
    "cgtUsd": 123.45,        // NG: 10% × realizedGains (gas-net)
    "cgtNgn": 191350.00,
    "incomeTaxUsd": 240.00,  // 30% bracket (companies) or marginal rate
    "totalNgn":  568100.00
  },
  "taxYearSummary": { "year": 2025, "realizedGains": 1234.56, "income": 800.00, "yield": 12.30, "deductibleGas": 3.45, "taxableIncome": 2043.41 },
  "methodJurisdictionCompat": [{ "method": "FIFO", "jurisdiction": "NG", "ok": true }, ...],
  "priceGaps": [{ "asset": "CELO", "timestamp": 1735689600 }],
  "disposalsCount": 47,
  "computedAt": "2026-06-12T..."
}
```

**Jurisdiction-specific fields (omitted when not applicable):**
- NG: `cgtUsd`, `cgtNgn`, `incomeTaxUsd`, `totalNgn` (NGN at 1 USD = 1550 NGN per `src/sub-agents/csv-exporter/schemas/nigeria-firs.ts:22`).
- KE: `datKes`, `incomeKes`, `totalKes` (KES at 1 USD = 153 KES per `src/sub-agents/csv-exporter/schemas/kenya-kra.ts:22`).
- OTHER: `reportUsd` (no tax due, just totals).

### 3.4 Data Sources

| Source | What | File path |
|---|---|---|
| Celoscan V2 `?action=txlist` + `?action=tokentx` + `?action=txlistinternal` | Raw txs | `mcp-server/src/tools/get-celo-transaction-history.ts` (reuse pattern) + `src/sub-agents/tx-fetcher/celoscan.ts` (production-grade paginator) |
| CoinGecko `/simple/price` | Spot USD prices for PNL USD valuation | `mcp-server/src/lib/coingecko.ts` (new) |
| `src/sub-agents/pnl-calculator/index.ts` | `computePnl({ address, classified, method, taxYear })` | reuses PNL pipeline |
| `src/sub-agents/tx-classifier/index.ts` | `classify(fetched, { network })` | reuses classifier |
| `.claude/skills/nigeria-kenya-crypto-tax.md` | Tax rules (FIRS 10% CGT, KRA 3% DAT, marginal income tax) | source of truth |

**Why two options for the tx-fetch step:**

- **Option A (preferred):** call the existing monorepo sub-agents (`fetchTxs`, `classify`, `computePnl`) directly via relative import. Pros: zero logic duplication; the MCP tool becomes a thin shell that reuses the production pipeline. Cons: imports a 1,000+-line tree into the standalone `mcp-server/` package.
- **Option B (fallback):** reimplement the fetch + classify + PNL steps inside the MCP tool. Pros: keeps `mcp-server/` self-contained (per `mcp-server/README.md:5`: "standalone and has no dependency on the parent agent monorepo"). Cons: ~500 lines of duplicated logic; ongoing maintenance burden.

**Decision: Option B (self-contained).** `mcp-server/` is documented as standalone; mixing in monorepo code would create two divergent pipelines. We instead re-implement only the 3 stages needed: tx fetch (Celoscan), classification (rule-only, no LLM fallback — sufficient for tax liability which can afford a "47 UNKNOWN flagged for review" warning instead of LLM calls), and FIFO PNL.

### 3.5 Required Env Vars

- `CELOSCAN_API_KEY` — required (existing).
- `COINGECKO_API_KEY` — optional.
- No new env vars.

### 3.6 Dependencies

- **Hard:** `mcp-server/src/lib/coingecko.ts` (Section 1.1).
- **Hard:** `mcp-server/src/lib/celoscan.ts` (Section 3.7 below) — to avoid duplicating the Celoscan URL/parse logic in the tx-history tool too.
- **Soft:** outputs of this tool are consumed by `generate_tax_report` (Section 5) and `get_carf_report` (Section 6).

### 3.7 New file: `mcp-server/src/lib/celoscan.ts`

To avoid duplicating the Celoscan URL builder + response normalizer in 3 tools (`get_celo_transaction_history`, `calculate_tax_liability`, `generate_tax_report`), extract a shared module:

Exports:
- `CeloscanClient(apiKey, apiUrl, chainId)` — class with methods:
  - `getNormalTxs(address, fromBlock?, toBlock?, page?, offset?): Promise<RawTx[]>`
  - `getTokenTransfers(address, fromBlock?, toBlock?, page?, offset?): Promise<TokenTransfer[]>`
  - `getInternalTxs(address, fromBlock?, toBlock?, page?, offset?): Promise<InternalTx[]>`
  - `getContractMetadata(address): Promise<{ name, isProxy, impl, verifiedAt }>`

This is a refactor that pre-empts duplication. **Effort:** S (1h). **Files:** `mcp-server/src/lib/celoscan.ts` (new, ~120 lines), `mcp-server/src/tools/get-celo-transaction-history.ts` (edit, net −40 lines by importing the client).

### 3.8 Implementation Approach

The tool is a self-contained mini-pipeline (~180 lines):

1. **Fetch** — paginate Celoscan (`getNormalTxs` + `getTokenTransfers` + `getInternalTxs`) for `address` over the block range; merge into `FetchedTxData` shape.
2. **Classify (rules only)** — port the rule engine from `src/sub-agents/tx-classifier/rules.ts` (pure data: `RULES` array + `findMatchingRule`). Skip LLM fallback — set `maxLlmCallsPerReport: 0`. Set `minRuleConfidence: 0.5` to allow more permissive rule matches in the MCP context.
3. **Resolve historical prices** — for each classified tx with an asset leg, look up the daily-close USD price for the tx date. Batch by date: group txs by `YYYY-MM-DD`, fetch `get_token_price_history` for the unique dates + tokens, then stamp `priceUsd` on each `AssetLeg`.
4. **Compute PNL** — call `computeFifo(classified, { gasPriceUsdByTimestamp })` (port the FIFO engine from `src/sub-agents/pnl-calculator/fifo.ts`).
5. **Apply jurisdiction rules** — dispatch on `jurisdiction`:
   - **NG:** `cgtNgn = (realizedGainsUsd - deductibleGasUsd) × 0.10 × 1550`; `incomeTaxNgn` is reported as raw value (real marginal rate requires taxpayer's income band; per `.claude/skills/nigeria-kenya-crypto-tax.md:38`, return `incomeUsd` for the user to apply their band).
   - **KE:** `datKes = grossTransferValueUsd × 0.03 × 153` (sum across disposals; the `grossTransferValueUsd` is `Σ(proceeds) + Σ(assetOut.value for TRANSFER_OUT without a disposal record)`).
   - **OTHER:** no tax — return totals only.
6. **Bucket by year** — filter disposals/income/yield by `taxYear`, return `TaxYearSummary` shape (matches `src/shared/types.ts:204-212`).
7. **Surface gaps** — return `priceGaps[]` so the user knows which days had missing prices.

**High-level:** reads Celoscan, classifies, prices, computes FIFO, dispatches to jurisdiction rules. The PNL/classification logic is **ported** (not imported) to keep `mcp-server/` standalone.

### 3.9 Test Plan

| Test | Type | Fixture | Expectation |
|---|---|---|---|
| NG FIFO on demo wallet | Integration | `0x4678…1c25`, taxYear=2025, jurisdiction=NG | `cgtNgn` is a finite number, `methodJurisdictionCompat` shows NG-FIFO ok |
| KE FIFO on demo wallet | Integration | same | `datKes` is 3% of gross transfer value |
| LIFO + NG (illegal combo) | Integration | same | `methodJurisdictionCompat[NG].ok = false` with reason; tool still returns totals |
| Empty history | Integration | fresh address | `realizedGainsUsd = 0`, all zeros |
| Missing price data (date in 2017) | Integration | address with old txs | `priceGaps[]` populated, `priceUsd` = 0 for that tx, totals reflect it |
| Invalid jurisdiction | Unit | `jurisdiction: "XX"` | `INVALID_INPUT` error |

### 3.10 Error Handling

| Error | Envelope |
|---|---|
| Bad input | `{ error: "INVALID_INPUT", message }` |
| Celoscan down | `{ error: "CELOSCAN_ERROR", message }` |
| CoinGecko down | `{ error: "COINGECKO_ERROR", priceGaps[] }` — tax computed with `priceUsd = 0` for affected days; surfaced in `priceGaps` |
| Classification left too many UNKNOWN | `{ warning: "MANUAL_REVIEW", count: N }` — non-fatal; tool still returns |

### 3.11 Estimated Effort

**L** (~3h). Largest tool: 3 sub-pipelines (fetch/classify/PNL) + jurisdiction dispatch + porting. Risk: the rule engine + FIFO engine are 600 lines combined; porting them is mechanical but tedious.

---

## 4. Tool 3 — `get_staking_rewards` (P1)

### 4.1 Scope & Purpose

Returns the Celo validator-group epoch rewards earned by an address during a date range. Powers the YIELD classification in the tax pipeline (currently `yield.small_periodic_staking@v1` is **no-op** because `STAKING_REWARD_DISTRIBUTOR` address is `null` in `src/shared/contracts.ts:118-121`).

### 4.2 Input Schema

```json
{
  "type": "object",
  "properties": {
    "address": { "type": "string", "pattern": "^0x[0-9a-fA-F]{40}$" },
    "network": { "type": "string", "enum": ["mainnet", "alfajores"], "default": "mainnet" },
    "fromTimestamp": { "type": "integer", "description": "Unix seconds (inclusive)" },
    "toTimestamp":   { "type": "integer", "description": "Unix seconds (inclusive)" }
  },
  "required": ["address"]
}
```

### 4.3 Output Schema

```json
{
  "address": "0x4678…",
  "network": "mainnet",
  "totalRewardsCel": "0.450000000000000000",
  "rewards": [
    {
      "epochNumber": 1234,
      "timestamp": 1735689600,
      "amountCel": "0.150000000000000000",
      "amountUsd": 0.0945,
      "validatorGroup": "0xVAL_GROUP_ADDR",
      "txHash": "0xabc..."
    }
  ],
  "epochCount": 3,
  "fetchedAt": "2026-06-12T...",
  "dataSource": "celoscan+celo-rpc"
}
```

When the staking distributor address is unknown (current state per `CONTRACT-RESEARCH-NOTES.md:54-55`), the tool falls back to **scanning the wallet's CELO transfers** and identifying small periodic incoming transfers (heuristic: ≥2 same-amount incoming within 7 days of each other). It returns `dataSource: "transfer-heuristic"` and a confidence note.

### 4.4 Data Sources

| Source | What | File path / URL |
|---|---|---|
| Celoscan V2 `?action=tokentx` (CELO token contract) | Incoming CELO transfers to `address` | `mcp-server/src/lib/celoscan.ts` (new, Section 3.7) |
| Celo RPC `eth_getLogs` on EpochRewards contract | Real epoch reward events (when address is known) | viem `createPublicClient` |
| CoinGecko `/simple/price?ids=celo` | Spot USD price for total rewards | `mcp-server/src/lib/coingecko.ts` (new) |

**Important caveat (risk mitigation):** the canonical EpochRewards contract address on post-L2 Celo mainnet is **not yet populated** in `src/shared/contracts.ts:113-122`. Until it is (per `CONTRACT-RESEARCH-NOTES.md:30` — search celo-org/celo-monorepo or Celo Discord), this tool uses the **transfer-heuristic** path and labels the output as such.

### 4.5 Required Env Vars

- `CELOSCAN_API_KEY` — required (existing).
- `COINGECKO_API_KEY` — optional.
- `CELO_RPC_URL` — already configured.
- No new env vars.

### 4.6 Dependencies

- **Hard:** `mcp-server/src/lib/celoscan.ts` (Section 3.7).
- **Hard:** `mcp-server/src/lib/coingecko.ts` (Section 1.1).
- **Soft:** `get_token_price_history` could be reused for the per-epoch USD price (spot fallback is acceptable for v1).

### 4.7 Implementation Approach

1. Validate input.
2. Fetch all incoming CELO token transfers to `address` (Celoscan `?action=tokentx&contractaddress=0x471EcE3750Da237f93B8E339c536989b8978a438`).
3. Group by `(sender, amount)` pairs. Filter for groups with ≥2 transfers within 7-day windows → heuristic yield pattern.
4. Fetch spot USD price for CELO; multiply `amountCel × priceUsd` per reward.
5. Return `dataSource: "transfer-heuristic"` + a `caveats` field explaining the heuristic.
6. (Optional v2, post-hackathon) when EpochRewards address is populated, also call `eth_getLogs` on it and merge real epoch events.

**High-level:** scans incoming CELO transfers, applies a periodic-incoming heuristic, prices in USD. ~150 lines of new code.

### 4.8 Test Plan

| Test | Type | Fixture | Expectation |
|---|---|---|---|
| Heuristic: 3 same-amount incoming within 14 days | Unit | mock CELO transfers | 1 reward group, 3 rewards, total = sum |
| Non-yield: 1 incoming transfer | Unit | mock | 0 rewards |
| USD valuation | Unit | mocked CoinGecko | `amountUsd` = amount × price |
| E2E demo wallet | Integration | `0x4678…1c25` (real wallet, has 1 staking reward in history) | `totalRewardsCel > 0`, `dataSource = "transfer-heuristic"` |

### 4.9 Error Handling

| Error | Envelope |
|---|---|
| Bad input | `{ error: "INVALID_INPUT" }` |
| Celoscan 4xx/5xx | `{ error: "CELOSCAN_ERROR" }` |
| No rewards found | `{ totalRewardsCel: "0", rewards: [], dataSource: "transfer-heuristic" }` (not an error) |
| CoinGecko down | `{ totalRewardsCel: "...", rewards[].amountUsd: null }` (null signals missing USD) |

### 4.10 Estimated Effort

**M** (~2h). The transfer-heuristic is the core work; the RPC event-log path is gated on an address we don't have.

---

## 5. Tool 4 — `generate_tax_report` (P1)

### 5.1 Scope & Purpose

Composes a complete tax report for a wallet + tax year, in the jurisdiction's CSV schema. Returns the CSV as a string (and base64-encoded for binary safety) plus the structured row data. This is the **"give me a CSV for my accountant"** tool — it bundles `get_celo_transaction_history` + `calculate_tax_liability` + jurisdiction CSV exporter into a single call.

**Hard dependency:** `calculate_tax_liability` (Tool 2). Composition, not duplication.

### 5.2 Input Schema

```json
{
  "type": "object",
  "properties": {
    "address": { "type": "string", "pattern": "^0x[0-9a-fA-F]{40}$" },
    "network": { "type": "string", "enum": ["mainnet", "alfajores"], "default": "mainnet" },
    "taxYear": { "type": "integer", "minimum": 2020, "maximum": 2030 },
    "jurisdiction": { "type": "string", "enum": ["NG", "KE", "OTHER"], "default": "NG" },
    "method": { "type": "string", "enum": ["FIFO", "LIFO", "WAC"], "default": "FIFO" },
    "outputFormat": { "type": "string", "enum": ["json", "csv", "both"], "default": "both" }
  },
  "required": ["address", "taxYear"]
}
```

### 5.3 Output Schema

```json
{
  "address": "0x4678…",
  "taxYear": 2025,
  "jurisdiction": "NG",
  "method": "FIFO",
  "schema": "nigeria-firs",
  "filename": "agent-06-2025-nigeria-firs.csv",
  "rowCount": 47,
  "summary": { "… same as Tool 2 output …" },
  "csv": "tx_date,type,asset,…",
  "csvBase64": "dHhfZGF0ZSx0eXBlLC4uLg==",
  "taxDue": { "…" },
  "disclaimer": "This report is generated by an automated system. Verify with a qualified tax professional before filing."
}
```

### 5.4 Data Sources

- Internally: **calls `calculate_tax_liability`** (Tool 2) and **imports the CSV exporter** schemas.
- The CSV exporter schemas are in `src/sub-agents/csv-exporter/schemas/`. To honor the "standalone" constraint of `mcp-server/`, port the 3 schema files (`nigeria-firs.ts`, `kenya-kra.ts`, `oecd-carf.ts`) into `mcp-server/src/lib/csv-schemas/`. They're **pure functions** — no I/O, no env, no RPC. Porting is mechanical: change relative imports to point at `mcp-server/src/lib/types.ts` (a small Zod-free copy of the `ClassifiedTx` / `Disposal` types we need).

### 5.5 Required Env Vars

Same as Tool 2.

### 5.6 Dependencies

- **Hard:** `calculate_tax_liability` (Tool 2) — composes it.
- **Hard:** `mcp-server/src/lib/csv-schemas/` (Section 5.7 below) — ported from `src/sub-agents/csv-exporter/schemas/`.

### 5.7 New directory: `mcp-server/src/lib/csv-schemas/`

Port the 3 jurisdiction schemas verbatim from `src/sub-agents/csv-exporter/schemas/`:

| Source file | Target file | Lines |
|---|---|---|
| `src/sub-agents/csv-exporter/schemas/nigeria-firs.ts` | `mcp-server/src/lib/csv-schemas/nigeria-firs.ts` | 195 |
| `src/sub-agents/csv-exporter/schemas/kenya-kra.ts` | `mcp-server/src/lib/csv-schemas/kenya-kra.ts` | ~160 |
| `src/sub-agents/csv-exporter/schemas/oecd-carf.ts` | `mcp-server/src/lib/csv-schemas/oecd-carf.ts` | 189 |
| (new) | `mcp-server/src/lib/types.ts` (subset of `shared/types.ts`) | ~30 |

The only import change: replace `from '../../../shared/types.js'` → `from '../types.js'` (local copy). **Total port:** ~540 lines copied + 30 lines of types.

**Risk:** **schema drift** — the monorepo's CSV schemas will evolve. The MCP port will lag. **Mitigation:** add a `// Keep in sync with src/sub-agents/csv-exporter/schemas/<filename> in the parent monorepo` header comment at the top of each ported file; document in README.

### 5.8 Implementation Approach

1. Validate input.
2. **Delegate to `calculate_tax_liability`** (Tool 2) for the classified+priced+PNL data.
3. Call the jurisdiction-specific CSV builder (`buildNigeriaFirsRows` / `buildKenyaKraRows` / `buildOecdCarfRows`) on the classified txs.
4. Render to CSV string with the jurisdiction's `render*` function.
5. Base64-encode for safe transport over JSON-RPC (the CSV may contain commas, quotes, newlines).
6. Attach summary + tax due + disclaimer.

**High-level:** 1 delegate call + 1 schema import + 1 base64 wrap. ~80 lines of glue code (the bulk is the imported schemas).

### 5.9 Test Plan

| Test | Type | Fixture | Expectation |
|---|---|---|---|
| NG FIFO | Integration | demo wallet | CSV header matches `tx_date,type,asset,…`, row count = classified txs |
| KE FIFO | Integration | demo wallet | CSV header matches `tx_date,type,asset,…,dat_due_kes,…` |
| OTHER / CARF | Integration | demo wallet | CSV header matches `reporting_period,tx_date,asset_type,…` |
| base64 round-trip | Unit | — | `Buffer.from(csvBase64, 'base64').toString() === csv` |
| Disclaimer always present | Unit | — | `disclaimer` is non-empty |

### 5.10 Error Handling

Inherits all error envelopes from `calculate_tax_liability` (Section 3.10). One additional envelope:
- `{ error: "SCHEMA_RENDER_ERROR", message }` if a jurisdiction schema throws (shouldn't happen; defensive).

### 5.11 Estimated Effort

**M** (~2h). The porting of the 3 schemas is the bulk (~540 LOC copy); the tool itself is glue.

---

## 6. Tool 5 — `get_carf_report` (P2)

### 6.1 Scope & Purpose

Returns an OECD CARF (Crypto-Asset Reporting Framework) report for a wallet over a date range. The CARF schema is the **forward-compatibility** layer: starting 2027, participating jurisdictions will exchange crypto-asset transaction data. The CSV schema already exists in `src/sub-agents/csv-exporter/schemas/oecd-carf.ts` and is used as the `OTHER` jurisdiction fallback in the CSV exporter.

### 6.2 Input Schema

```json
{
  "type": "object",
  "properties": {
    "address": { "type": "string", "pattern": "^0x[0-9a-fA-F]{40}$" },
    "network": { "type": "string", "enum": ["mainnet", "alfajores"], "default": "mainnet" },
    "fromTimestamp": { "type": "integer", "description": "Unix seconds (inclusive)" },
    "toTimestamp":   { "type": "integer", "description": "Unix seconds (inclusive)" },
    "userJurisdiction": { "type": "string", "description": "ISO 3166-1 alpha-2 country code (e.g. NG, KE, DE)" }
  },
  "required": ["address", "userJurisdiction"]
}
```

### 6.3 Output Schema

```json
{
  "address": "0x4678…",
  "userJurisdiction": "NG",
  "reportingPeriod": "2025-01-01_2025-12-31",
  "schemaVersion": "oecd-carf-v0",
  "reportType": "CARF",
  "filename": "agent-06-CARF-2025-NG-0x4678.csv",
  "rowCount": 47,
  "csv": "reporting_period,tx_date,asset_type,…",
  "csvBase64": "…",
  "summary": {
    "totalGrossProceedsUsd": 1234.56,
    "totalCostBasisUsd": 800.00,
    "totalPnlUsd": 434.56,
    "byAssetType": { "stablecoin": { "count": 12, "pnlUsd": 100 }, "other_crypto": { "count": 35, "pnlUsd": 334.56 } }
  },
  "carfMetadata": {
    "reportingEntity": "0x4678…",
    "taxResidency": "NG",
    "reportableTransactions": 47,
    "frameworkVersion": "OECD-CARF-2022",
    "notes": "Per OECD CARF §III, reportable crypto-asset transactions are enumerated by tx_type taxonomy. Stablecoin identification follows §IV Annex."
  },
  "fetchedAt": "2026-06-12T..."
}
```

### 6.4 Data Sources

| Source | What | File path |
|---|---|---|
| Celoscan V2 | Raw txs (same as Tool 2) | `mcp-server/src/lib/celoscan.ts` |
| CoinGecko | Historical USD prices | `mcp-server/src/lib/coingecko.ts` |
| Tx classification (rules) | TxType taxonomy → CARF tx_type mapping | ported from `src/sub-agents/tx-classifier/index.ts` |
| PNL FIFO engine | Disposal + cost basis | ported from `src/sub-agents/pnl-calculator/fifo.ts` |
| CARF schema | `buildOecdCarfRows` + `renderOecdCarfCsv` | `mcp-server/src/lib/csv-schemas/oecd-carf.ts` (ported in Section 5.7) |

### 6.5 Required Env Vars

Same as Tool 2.

### 6.6 Dependencies

- **Hard:** `mcp-server/src/lib/celoscan.ts` (Section 3.7).
- **Hard:** `mcp-server/src/lib/coingecko.ts` (Section 1.1).
- **Hard:** `mcp-server/src/lib/csv-schemas/oecd-carf.ts` (Section 5.7).
- **Hard:** the rule-engine port + FIFO port (shared with Tool 2 — see "Shared core" below).

### 6.7 Shared Core — `mcp-server/src/lib/pipeline-core.ts`

**Blocker for Tools 2, 3 (partially), 5.** All three need a mini-pipeline (fetch → classify → price → PNL). Extract the inner logic of `calculate_tax_liability` (Section 3.8) into a shared `pipelineCore(address, network, fromBlock, toBlock)` function that returns `{ classified, pnl, priceGaps }`. Tools 2 and 5 then wrap this with jurisdiction-specific output formatting.

**Effort:** S (1h, refactor of Tool 2's implementation). **File:** `mcp-server/src/lib/pipeline-core.ts` (new, ~150 lines, contains the rule-engine port + FIFO port + price-resolver).

### 6.8 Implementation Approach

1. Validate input.
2. Call `pipelineCore(address, network, fromBlock, toBlock)` → `{ classified, pnl, priceGaps }`.
3. Call `buildOecdCarfRows(classified, pnl, taxYear)` (reuses Tool 5's ported schema).
4. Render to CSV.
5. Compute `summary` aggregates (`totalGrossProceedsUsd`, `totalCostBasisUsd`, `totalPnlUsd`, `byAssetType`).
6. Attach `carfMetadata` (reportingEntity, frameworkVersion, etc.).
7. Base64-encode CSV.

**High-level:** 1 pipeline call + 1 schema call + 1 summary computation. ~100 lines of new code (on top of the shared pipeline).

### 6.9 Test Plan

| Test | Type | Fixture | Expectation |
|---|---|---|---|
| CARF on demo wallet | Integration | `0x4678…1c25`, userJurisdiction=NG | CSV header matches CARF schema, `rowCount > 0`, `summary.byAssetType` populated |
| Stablecoin detection | Unit | mock classified txs (cUSD + CELO) | `summary.byAssetType.stablecoin.count >= 1`, `other_crypto.count >= 1` |
| CARF tx_type mapping | Unit | mock classified txs (SWAP, YIELD, GAS) | `tx_type` column has `exchange`, `payment`, `fee` |
| frameworkVersion | Unit | — | `"OECD-CARF-2022"` |
| base64 round-trip | Unit | — | `Buffer.from(csvBase64, 'base64').toString() === csv` |

### 6.10 Error Handling

Inherits all error envelopes from `calculate_tax_liability`. One additional envelope:
- `{ error: "INVALID_JURISDICTION", message: "userJurisdiction must be ISO 3166-1 alpha-2" }` if the jurisdiction code is malformed.

### 6.11 Estimated Effort

**M** (~1.5h). Most work is shared with Tool 2 via `pipelineCore`. Tool-specific code is CSV rendering + summary aggregation.

---

## 7. Cross-Cutting: Tests + Server Wiring

### 7.1 New test file: `mcp-server/test/test-tools-phase-c.ts`

Mirror the structure of `test/test-tools-direct.ts`. For each new tool, exercise:
1. `tools/list` returns 7 tools.
2. Happy path against `0x4678…1c25`.
3. Bad input returns `INVALID_INPUT`.
4. Rate-limit / API-down scenario returns the expected envelope.

### 7.2 `mcp-server/src/server.ts` Edits

- Import 5 new tool handlers in lines 28-29.
- Add 5 entries to `TOOL_HANDLERS` (lines 57-60) — alphabetical.
- Add 5 entries to `TOOL_DESCRIPTIONS` (lines 62-111) — alphabetical.
- Net diff: ~80 lines added (descriptions only; no protocol change).

### 7.3 `mcp-server/README.md` Updates

- Update `## Tool Inventory` section to document all 7 tools.
- Add "Post-Hackathon" section → remove the 5 "Post-hack" rows, replace with "Phase C: 7-tool inventory complete" (matches the new state).
- Add "Tool Inventory by Priority" with P0/P1/P2 sub-headers (matches `06-tools-mcp.md:92-101`).

### 7.4 `mcp-server/.env.example` Updates

No new env vars needed. Just bump the comment header to "Phase C — 7 tools".

---

## 8. Implementation Waves (Dependency-Aware Order)

### Wave 1 — Foundation (S, ~30 min)

- `mcp-server/src/lib/http.ts` (new)
- `mcp-server/src/lib/coingecko.ts` (new, includes spot + market_chart helpers)
- `mcp-server/src/lib/celoscan.ts` (new)
- Refactor `get-celo-portfolio.ts` and `get-celo-transaction-history.ts` to use the libs
- **Verification:** existing 2-tool integration test passes unchanged; `npx tsc --noEmit` clean

### Wave 2 — P0 leaf tool: `get_token_price_history` (S, ~1.5h)

- Implements `mcp-server/src/tools/get-token-price-history.ts`
- **Verification:** new unit test + integration test in `test-tools-phase-c.ts`

### Wave 3 — Core P0 tool: `calculate_tax_liability` (L, ~3h)

- Implements `mcp-server/src/lib/pipeline-core.ts` (rule port + FIFO port + price resolver)
- Implements `mcp-server/src/tools/calculate-tax-liability.ts`
- **Verification:** integration test for demo wallet + 3 jurisdiction variants

### Wave 4 — P1 tool: `get_staking_rewards` (M, ~2h)

- Implements `mcp-server/src/tools/get-staking-rewards.ts`
- Uses transfer-heuristic (no EpochRewards address yet)
- **Verification:** integration test for demo wallet + 2 unit tests

### Wave 5 — Schema port + `generate_tax_report` (M, ~2h)

- Port 3 CSV schemas to `mcp-server/src/lib/csv-schemas/`
- Implements `mcp-server/src/tools/generate-tax-report.ts` (composes Tool 2)
- **Verification:** integration test for NG/KE/OTHER variants

### Wave 6 — P2 tool: `get_carf_report` (M, ~1.5h)

- Implements `mcp-server/src/tools/get-carf-report.ts` (uses pipelineCore + CARF schema)
- **Verification:** integration test for demo wallet + 3 unit tests

### Wave 7 — Server wiring + docs (S, ~1h)

- Edit `mcp-server/src/server.ts` to register 5 new tools
- Update `mcp-server/README.md`
- Add `mcp-server/test/test-tools-phase-c.ts`
- **Verification:** `tools/list` returns 7 tools; full integration test passes; `npx tsc --noEmit` clean

**Total estimated effort: ~11-12h** (1.5 days of focused work). Risk: Rule-engine port and FIFO port are mechanical but ~600 LOC; mistakes here cascade into all 3 pipeline tools. Mitigation: incremental — port a small rule first, test, expand.

**Effort summary:**
- Wave 1: 30 min
- Wave 2: 1.5h
- Wave 3: 3h
- Wave 4: 2h
- Wave 5: 2h
- Wave 6: 1.5h
- Wave 7: 1h
- **Total: 11.5h**

---

## 9. External Blockers

| Blocker | Impact | Mitigation |
|---|---|---|
| `CELOSCAN_API_KEY` not set in `mcp-server/.env` | Tools 2, 4, 5 cannot fetch real data | Already set per `mcp-server/.env:6` (key `54WFY7SFU4ESVBD78JRMWG51MGHF4GNPCC`); no new action |
| `STAKING_REWARD_DISTRIBUTOR` address not populated | Tool 3 cannot use the direct `eth_getLogs` path | Transfer-heuristic fallback (planned default) |
| Moola cEUR cToken address unconfirmed (`CONTRACT-RESEARCH-NOTES.md:90`) | Rule engine may misclassify cEUR Moola deposits | Acceptable v1; cUSD address confirmed; cEUR fix is a follow-up |
| CoinGecko free tier rate limits (10-30 calls/min) | Tools 1, 2, 5 may 429 on multi-token multi-year queries | Per-token backoff; surface `gaps[]`; recommend `COINGECKO_API_KEY` for heavy use |
| CARF final spec ratification | Our schema is OECD-CARF-2022 (`.claude/skills/celo-chain-data.md:127`) | Header comment notes version; schema migration is a future PR |

---

## 10. Open Questions (Need User Input)

1. **Currency exchange rates for tax due** — `nigeria-firs.ts:22` hardcodes `1 USD = 1550 NGN`; `kenya-kra.ts:22` hardcodes `1 USD = 153 KES`. These are 2024 averages per the comment. Should the MCP tool:
   - (a) Use the same hardcoded rates as the existing CSV exporter (consistency, no extra deps), OR
   - (b) Fetch live rates from CBN/CBK/exchangerate.host (accurate but adds a new external dep + 1 HTTP call per report)?

   **Recommendation:** (a) for v1. Matches the rest of the codebase; live rates are a follow-up. **Action: confirm with user.**

2. **`get_carf_report` vs `generate_tax_report` with `jurisdiction=OTHER`** — both produce CARF CSV. Differ in: `get_carf_report` is **multi-year** (any timestamp range) and has `userJurisdiction` metadata; `generate_tax_report` with OTHER is **single-year** and lacks CARF metadata. Is this duplication acceptable, or should we make `get_carf_report` a thin wrapper around `generate_tax_report(jurisdiction=OTHER)`?

   **Recommendation:** keep them distinct. CARF has its own contract (`.claude/skills/celo-chain-data.md:128-131`); the userJurisdiction field is CARF-specific. **Action: confirm with user.**

3. **LLM fallback in MCP tools** — `calculate_tax_liability` and `generate_tax_report` will leave transactions as `flagged:UNKNOWN` (no LLM in the standalone MCP server). The orchestrator (monorepo) uses the LLM for ambiguous cases. Acceptable for v1?

   **Recommendation:** yes. The MCP server is documented as standalone (`.claude/skills/celo-chain-data.md:5` and `mcp-server/README.md:5`); adding an Anthropic SDK dep + ANTHROPIC_API_KEY env var is a bigger architectural change. Surface `flagged:UNKNOWN` count as a warning instead. **Action: confirm with user.**

4. **`get_token_price_history` default token list** — should the default (when `tokens` is omitted) be all 6 Celo native tokens (CELO, cUSD, cEUR, cREAL, USDC, USDT) or only the 2 most common (CELO, cUSD)?

   **Recommendation:** all 6. Matches the existing `get_celo_portfolio` token universe. **Action: confirm with user.**

---

## 11. Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| **Schema drift** — monorepo's CSV schemas evolve; MCP port lags | Med | Med | Header comment per file pointing to canonical source; add a "regen from monorepo" script in `mcp-server/scripts/` (optional, post-hackathon) |
| **Rule engine + FIFO port bugs** — ~600 LOC port introduces new bugs | Med | High | Unit tests for each ported function; compare outputs against the monorepo on the demo wallet (sanity check: PNL totals must match within $0.01) |
| **CoinGecko rate limits** during heavy use | High | Med | Per-token sequential fetch with 100ms delay; `gaps[]` surface; recommend API key |
| **Celoscan pagination edge cases** — wallets with > 10k txs | Low | Med | Already handled in `get_celo_transaction_history`; replicate the same pagination pattern (page=1..10) |
| **MCP server bundle size growth** — adding 5 tools pushes us past the "thin slice" goal | Med | Low | The plan explicitly adds ~1500 LOC of tool code + ~600 LOC of schema ports; this is by user request to override "post-hackathon" scope. Document the size in README. |
| **`userJurisdiction` validation** — malformed ISO codes | Low | Low | Regex `^[A-Z]{2}$`; return `INVALID_JURISDICTION` |
| **Test reliability on real CoinGecko** — market_chart data occasionally has gaps | Med | Low | Surface gaps in `gaps[]`; never silently return null prices |
| **Time-budget overrun** — 11.5h is 1.5 days; agent may be context-limited before completion | Med | Med | Stagger into 2 sessions: Waves 1-3 in session 1 (foundation + 2 P0 tools), Waves 4-7 in session 2 |

---

## 12. Acceptance Criteria Summary

| Tool | Priority | Lines (est) | Effort | Test coverage |
|---|---|---|---|---|
| `get_token_price_history` | P0 | ~140 | S (1.5h) | 5 unit + 1 integration |
| `calculate_tax_liability` | P0 | ~180 (tool) + ~600 (port) | L (3h) | 3 jurisdiction variants integration + 2 unit |
| `get_staking_rewards` | P1 | ~150 | M (2h) | 3 unit + 1 integration |
| `generate_tax_report` | P1 | ~80 (tool) + ~540 (port) | M (2h) | 3 jurisdiction variants integration + 2 unit |
| `get_carf_report` | P2 | ~100 (tool) | M (1.5h) | 1 integration + 4 unit |
| **Total new code** | | ~1,790 LOC | **~10-12h** | |

**Phase C ships when:**
1. `npx tsc --noEmit` passes (0 errors)
2. `tools/list` returns exactly 7 tools
3. Each new tool returns valid JSON for the demo wallet `0x4678…1c25`
4. Each new tool returns `INVALID_INPUT` for bad inputs
5. Existing 2 tools still work (regression check)
6. `mcp-server/README.md` documents all 7 tools
7. No tool file exceeds 200 lines (per `development-rules.md` file-size rule)

---

## 13. Open Decisions to Surface to User

1. Exchange rate policy (Q1 above) — recommend: hardcoded for v1
2. CARF tool duplication (Q2) — recommend: keep distinct
3. LLM fallback in MCP (Q3) — recommend: rule-only, surface UNKNOWN count
4. Default token list (Q4) — recommend: all 6 native

These are blocking only if the user disagrees with recommendations. If silence = approval, proceed with all 4 recommendations.

---

## 14. Phase C Plan vs. Phase A/B Plan (Reuse Map)

| Phase C component | Reuses from | Why |
|---|---|---|
| `mcp-server/src/lib/coingecko.ts` | `get-celo-portfolio.ts:44-117` (move only) | DRY — all 5 new tools need CoinGecko |
| `mcp-server/src/lib/celoscan.ts` | `get-celo-transaction-history.ts:96-153` (move only) | DRY — 3 new tools need Celoscan |
| `mcp-server/src/lib/csv-schemas/*` | `src/sub-agents/csv-exporter/schemas/*` (port) | Schema-only functions; no I/O |
| `mcp-server/src/lib/pipeline-core.ts` | `src/sub-agents/pnl-calculator/fifo.ts` + `src/sub-agents/tx-classifier/rules.ts` (port) | Pure compute; no LLM |
| `mcp-server/src/server.ts` | existing TOOL_DESCRIPTIONS map | Just register 5 more tools |
| `mcp-server/README.md` | existing patterns | Update tool inventory section |

**New ground (not in Phase A/B):**
- `mcp-server/src/lib/pipeline-core.ts` — the standalone pipeline (fetch → classify rules-only → price → FIFO)
- `mcp-server/src/tools/get-staking-rewards.ts` — transfer-heuristic is novel
- `mcp-server/src/tools/get-carf-report.ts` — CARF metadata is new (not in any existing tool)

---

**Status:** Plan complete. Ready for user review on the 4 open questions in Section 10/13 before implementation begins.
