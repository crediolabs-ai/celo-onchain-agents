# Celoscan V1 → V2 migration

**Date:** 2026-06-11
**Implementer:** Tuan
**Verdict:** **PARTIAL** — V1→V2 code migration verified successful (fetcher returns real mainnet data); acceptance criterion #5 (Classified > 0) blocked by pre-existing classifier limitation, not a V1/V2 issue.

## Files changed

| File | Lines changed | What |
|------|---------------|------|
| `src/sub-agents/tx-fetcher/celoscan.ts` | ~10 | New optional `chainId` in `CeloscanClientOptions`; `buildUrl()` appends `chainid` when set; file header updated to reflect V2 endpoint. |
| `src/sub-agents/tx-fetcher/index.ts` | ~5 | New optional `chainId` in `FetchTxsDeps`; forwarded to the client via `CeloscanClientOptions`. |
| `src/orchestrator/production.ts` | 1 | Pass `chainId: config.chainId` to `fetchTxs` (sourced from `AppConfig` — already derived from viem chain). |
| `.env.example` | 1 | `CELOSCAN_API_URL` default → `https://api.etherscan.io/v2/api` (works for both networks; `chainid` disambiguates). |
| `tests/unit/tx-fetcher-celoscan.test.ts` | +18 | New tests: chainid appended when set; chainid absent when unset (V1 backward compat). |

`src/sub-agents/tx-fetcher/types.ts` and `pagination.ts` — **untouched**. V2 response shape is identical to V1 (`status` / `message` / `result`), confirmed by live curl.

`.env` (local, gitignored) — **restored to V1 per task instructions** ("don't change the default for other users"). The committed default for new users is `.env.example` (updated).

### Implementation details

- `celoscan.ts:32–44` — added `chainId?: number` to `CeloscanClientOptions`.
- `celoscan.ts:62` — destructured `chainId` from options.
- `celoscan.ts:68` — `if (chainId !== undefined) u.searchParams.set('chainid', String(chainId));`
- `index.ts:41–54` — added `chainId?: number` to `FetchTxsDeps`; JSDoc notes Celo mainnet 42220, Alfajores 44787.
- `index.ts:81` — `...(deps.chainId !== undefined && { chainId: deps.chainId })` forwarded to client.
- `production.ts:91–99` — `chainId: config.chainId` added to the `fetchTxs` call.
- No new helper map (network → chainId). `config.chainId` is already the canonical source, derived from `viem/chains` (`celo.id` = 42220, `celoAlfajores.id` = 44787). Passing it through keeps a single source of truth.

## Test results

### Real mainnet run (V2 endpoint, real API key)

Command:
```bash
NETWORK=mainnet \
CELO_RPC_URL=https://forno.celo.org \
CELOSCAN_API_URL=https://api.etherscan.io/v2/api \
pnpm dev --address 0xaD01C20d5886137e056775af56915de824c8fCe5 \
          --jurisdiction NG --tax-year 2025 \
          --output /tmp/mainnet-v2-report.csv
```

Exit code: **0**
Wall clock: **4.2 s** (under 60 s budget)

### Acceptance criteria

| # | Criterion | Status | Evidence |
|---|-----------|--------|----------|
| 1 | Exit code 0 | ✅ | Verified via `$?` after second run. |
| 2 | Markdown summary prints | ✅ | Full markdown table printed to stdout (see "Sample output"). |
| 3 | Fetch errors: 0 | ✅ | `**Fetch errors:**` line absent from markdown (CLI only prints when `> 0`, see `src/cli/index.ts:116-118`). Was 3 on V1, 0 on V2. |
| 4 | Token transfers > 0 | ✅ | `**Txns (token transfers): 1421**` (was 0 on V1; target address has ≥250 per Blockscout). |
| 5 | Classified > 0, CSV has rows | ❌ | `**Classified:** 0`; CSV has 1 line (header only). Root cause below. |
| 6 | No `--emit-onchain-log` | ✅ | Confirmed — flag absent from command. The 8004-identity wallet `0x0F5d...cAb` was not used for any onchain action. |

### Why criterion 5 failed (NOT a V1/V2 issue)

The classifier at `src/sub-agents/tx-classifier/index.ts:132` iterates `fetched.rawTxns` only — `fetched.tokenTransfers` are used as supplementary context (`transfersByHash.get(tx.hash)`) for normal txs, not classified on their own.

The target address `0xaD01C20d5886137e056775af56915de824c8fCe5` is a **pure ERC-20 receiver**: 0 native CELO txs, 1421 token transfers, 1075 internal txs. The prior mainnet test report (`plans/mainnet-test/reports/mainnet-test-report.md`) confirmed this on Blockscout ("no native CELO transfers" / "pure ERC-20 receiver").

So:
- `rawTxns.length = 0` → classifier loop runs 0 iterations → 0 classified.
- The V2 fetcher returns 1421 token transfers correctly (V1 returned 0 because the endpoint was deprecated).
- The CSV is empty not because of V2, but because nothing enters the classifier.

Per task rules: "If you find a TODO or pre-existing bug OUTSIDE this scope, mention it in the report but don't fix it." — this is out of scope for the V1→V2 migration and is flagged here for the next iteration.

### Response shape verification (curl)

```bash
curl -s 'https://api.etherscan.io/v2/api?chainid=42220&module=account&action=tokentx&address=0xad01c20d5886137e056775af56915de824c8fce5&startblock=0&endblock=99999999&page=1&offset=2&sort=asc&apikey=...' | head -c 1500
```

Returns `{"status":"1","message":"OK","result":[{...}]}`. Per-row fields: `blockNumber`, `timeStamp`, `hash`, `from`, `to`, `value`, `contractAddress`, `tokenName`, `tokenSymbol`, `tokenDecimal`, `nonce`, `blockHash`, `transactionIndex`, `gas`, `gasPrice`, `gasUsed`, `cumulativeGasUsed`, `input`, `methodId`, `functionName`, `confirmations`, `statusRep`. All V1-expected fields present, no rename. The `types.ts` schema matches.

### Test suite

```
✓ tests/shared/http.test.ts (5 tests) 1516ms
✓ tests/shared/config.test.ts (8 tests) 94ms
✓ tests/unit/tx-fetcher.test.ts (6 tests) 25ms
✓ tests/unit/nl-query.test.ts (39 tests) 27ms
✓ tests/unit/orchestrator.test.ts (17 tests) 21ms
✓ tests/unit/pnl-calculator.test.ts (18 tests) 16ms
✓ tests/unit/wallet.test.ts (11 tests) 23ms
✓ tests/unit/tx-classifier.test.ts (30 tests) 22ms
✓ tests/unit/tx-fetcher-cache.test.ts (6 tests) 20ms
✓ tests/unit/csv-exporter.test.ts (67 tests) 18ms
✓ tests/shared/contracts.test.ts (14 tests) 13ms
✓ tests/unit/tx-fetcher-pagination.test.ts (6 tests) 8ms
✓ tests/unit/tx-fetcher-celoscan.test.ts (8 tests) 9ms
✓ tests/unit/erc8004.test.ts (13 tests) 8ms
✓ tests/unit/log-emitter.test.ts (12 tests) 9ms
✓ tests/unit/coingecko-oracle.test.ts (9 tests) 10ms

 Test Files  16 passed (16)
      Tests  269 passed (269)
```

- Previous: 267/267 green.
- After migration: **269/269 green** (+2 from the new chainid tests in `tx-fetcher-celoscan.test.ts`). No regressions.

## Sample output

```
$ NETWORK=mainnet CELO_RPC_URL=https://forno.celo.org \
  CELOSCAN_API_URL=https://api.etherscan.io/v2/api \
  pnpm dev --address 0xaD01C20d5886137e056775af56915de824c8fCe5 \
           --jurisdiction NG --tax-year 2025 \
           --output /tmp/mainnet-v2-report.csv

# Agent 06 — 0xaD01C20d5886137e056775af56915de824c8fCe5

- **Jurisdiction:** NG
- **Tax year:** 2025
- **Method:** FIFO
- **Txns (raw):** 0
- **Txns (token transfers):** 1421
- **Txns (internal):** 1075
- **Classified:** 0 (0 rules, 0 LLM)
- **Flagged for review:** 0
- **CSV:** agent-06-2025-nigeria-firs.csv (0 rows, nigeria-firs)
- **Duration:** 1340ms

## 2025 tax summary
- **Realized gains:** $0.00
- **Income:** $0.00
- **Yield:** $0.00
- **Deductible gas:** $0.00
- **Taxable income:** $0.00

CSV written to: /tmp/mainnet-v2-report.csv
```

## Notes / risks

- **V1→V2 migration is functionally complete.** The fetcher returns real mainnet data (1421 token transfers, 1075 internal, 0 normal — matching the address's ERC-20-only profile). Response shape unchanged. All 269 tests pass.
- **Pre-existing classifier limitation (out of scope here, do not fix in this PR):** `src/sub-agents/tx-classifier/index.ts:132` only iterates `rawTxns`. To classify ERC-20-only addresses, the classifier needs a second pass over `tokenTransfers` (or the orchestrator needs to synthesize a `RawTx` shell per transfer hash). Filed for the next sub-agent iteration.
- **Local `.env` is gitignored and not changed.** `.env.example` (committed) is the canonical V2 default. Users with existing local `.env` files pointing at V1 will need to update `CELOSCAN_API_URL` once.
- **`chainId` is optional in the client API.** This preserves backward compat for any external stub/tests; production always passes it via `production.ts:91`. No force-set in the client itself — keeps the client a pure URL builder.
- **CSV output:** `/tmp/mainnet-v2-report.csv` has 1 line (header only). Expected — see classifier limitation above.

**Status:** DONE_WITH_CONCERNS
**Summary:** V1→V2 code migration is done and verified on real mainnet (fetcher works, no errors, 1421 token transfers returned, response shape unchanged, 269/269 tests pass). Criterion 5 (Classified > 0) fails for a reason orthogonal to V1/V2: the target address has 0 native txs and the classifier doesn't iterate `tokenTransfers` standalone. That fix is out of scope per task rules.
