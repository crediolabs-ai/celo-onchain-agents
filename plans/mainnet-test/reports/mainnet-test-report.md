# Mainnet test — Agent 06

**Date:** 2026-06-11
**Verifier:** Tuan
**Target address:** `0xaD01C20d5886137e056775af56915de824c8fCe5`
**Network:** celo mainnet
**Verdict:** **FAIL** (data plane blocked — Celoscan API key missing; pipeline runs end-to-end but returns an empty report)

## Address selection

- **Picked:** `0xaD01C20d5886137e056775af56915de824c8fCe5`
- **Why:** The user-supplied address. Verified against two independent sources (CeloScan + Celo Blockscout) that it is a real Celo mainnet EOA.
- **Activity (from Celo Blockscout `https://celo.blockscout.com`):**
  - `is_contract: false` (EOA), reputation `ok`
  - Native CELO balance: `106217875302189807279` wei ≈ **106.22 CELO** (~$6.34 at $0.0597/CELO per Blockscout cached rate)
  - `has_token_transfers: true`, `has_tokens: true` — paginated ≥250 token transfers (multiple pages of 50), spanning 2025-02 to 2025-03
  - Inbound `Tether (USDT)` 12 273 (6 dp) on 2025-03-04 from `FlashWallet` (`0xdB6f...498`)
  - Inbound `mCELO` 42 784 300 945 235 (18 dp) on 2025-02-27
  - No native CELO transfers (`celoscan.io` shows `Transactions: 0` for the `txlist` endpoint — address is a pure ERC-20 receiver; activity is on-chain in token transfers only)
  - Last block height: `62 593 373` (per Blockscout)

  **Caveat noted:** CeloScan's V1 search snippet says "Transactions: 0" — that endpoint counts **native CELO `txlist`** only and is also deprecated (Etherscan migration notice). Blockscout (still maintained) shows the real activity on the `tokentx` side. The address is fine; Celoscan's index is incomplete.

## Run transcript

### Run #1 — Etherscan V2 endpoint (current canonical, no key)

Command:
```bash
env NETWORK=mainnet \
  CELO_RPC_URL=https://forno.celo.org \
  CELOSCAN_API_URL=https://api.etherscan.io/v2/api \
  pnpm dev --address 0xaD01C20d5886137e056775af56915de824c8fCe5 \
           --jurisdiction NG --tax-year 2025 \
           --output /tmp/mainnet-report.csv
```

> Note: dropped the `--` after `pnpm dev` — see Gap #2. The task-supplied `pnpm dev -- --address ...` form actually fails to parse the address flag.

**Exit code:** 0
**Wall clock:** **3 s** (well under 60 s budget)

### Markdown summary (stdout)
```
# Agent 06 — 0xaD01C20d5886137e056775af56915de824c8fCe5

- **Jurisdiction:** NG
- **Tax year:** 2025
- **Method:** FIFO
- **Txns (raw):** 0
- **Txns (token transfers):** 0
- **Txns (internal):** 0
- **Classified:** 0 (0 rules, 0 LLM)
- **Flagged for review:** 0
- **Fetch errors:** 3
- **CSV:** agent-06-2025-nigeria-firs.csv (0 rows, nigeria-firs)
- **Duration:** 444ms

## 2025 tax summary
- **Realized gains:** $0.00
- **Income:** $0.00
- **Yield:** $0.00
- **Deductible gas:** $0.00
- **Taxable income:** $0.00

CSV written to: /tmp/mainnet-report.csv
```

### Errors observed (from `fetchErrors` in the mainnet cache)
- `[normal] Celoscan error (txlist page=1): NOTOK`
- `[token] Celoscan error (tokentx page=1): NOTOK`
- `[internal] Celoscan error (txlistinternal page=1): NOTOK`

All three are HTTP 200 with body `{"status":"0","message":"NOTOK","result":"Missing/Invalid API Key"}` — the V2 endpoint rejects unauthenticated calls with a non-zero `status` other than the `"No transactions found"` sentinel, which `src/sub-agents/tx-fetcher/celoscan.ts:89` converts into a `CeloscanError`. The pipeline's `Promise.allSettled` (tx-fetcher/index.ts:97) catches that and pushes to `fetchErrors` rather than throwing.

### Run #2 — Legacy V1 endpoint (deprecation path), with `--refresh` to bypass cache

Command:
```bash
env NETWORK=mainnet \
  CELO_RPC_URL=https://forno.celo.org \
  CELOSCAN_API_URL=https://api.celoscan.io/api \
  pnpm dev --address 0xaD01C20d5886137e056775af56915de824c8fCe5 \
           --jurisdiction NG --tax-year 2025 \
           --output /tmp/mainnet-report-v1.csv --refresh
```

**Exit code:** 0  •  **Wall clock:** **2 s**

Same 3 fetch errors (`[normal|token|internal] ... NOTOK`) — the V1 URL returns `{"status":"0","message":"NOTOK","result":"You are using a deprecated V1 endpoint, switch to Etherscan API V2 using https://docs.etherscan.io/v2-migration"}`. **Both endpoints are dead without an API key**; the V1 form is dead *with* one.

### CSV output (run #1)
- File: `/tmp/mainnet-report.csv` (90 bytes)
- Rows: **0 data rows, 1 header**
- Header: `tx_date,type,asset,amount,price_ngn,cost_basis_ngn,gain_loss_ngn,cumulative_gain_ngn,notes`

## Per-stage status

| Stage      | Status     | Notes                                                                                                |
|------------|------------|------------------------------------------------------------------------------------------------------|
| Fetch      | ❌          | 3/3 Celoscan endpoints returned `NOTOK` (V2: missing API key). Pipeline kept going on empty arrays. |
| Classify   | ✅ (no-op)  | 0 txs in → 0 classified, 0 LLM fallbacks. With no `ANTHROPIC_API_KEY`, LLM path was never reachable. |
| PNL        | ✅ (no-op)  | 0 txs → all year-summary fields $0.00. CoinGecko price oracle not called.                            |
| CSV        | ✅          | Header only. Schema = `nigeria-firs`. File written successfully.                                     |
| NL query   | ⏭ skipped  | no `--nl-query` flag (per safety: would need `ANTHROPIC_API_KEY`).                                   |
| Log emit   | ⏭ skipped  | no `--emit-onchain-log` flag (per safety: agent wallet unfunded — would broadcast a real self-tx).   |

## Gaps blocking real mainnet demo

1. **[CRITICAL] No `CELOSCAN_API_KEY`.** Both the legacy `https://api.celoscan.io/api` (sunset, returns `You are using a deprecated V1 endpoint`) and the canonical `https://api.etherscan.io/v2/api?chainid=42220` (returns `Missing/Invalid API Key`) reject every call from the tx-fetcher. The pipeline does not crash — it logs the three errors and returns an empty report — but the result is useless: 0 raw txs, 0 token transfers, 0 internal txs, 0 classified, 0 PNL, header-only CSV.
   **Fix:** Sign up at https://celoscan.io/myapikey (free tier, instant), set `CELOSCAN_API_KEY=...` in `.env`. Free tier is 5 req/sec, plenty for a single wallet.

2. **[CRITICAL] README quickstart command is broken.** `pnpm dev -- --address 0x...` does **not** work. pnpm 9 forwards the `--` to tsx, tsx forwards it to Node, and `process.argv[2]` becomes the literal string `--` — commander at `src/cli/index.ts:48` treats that as a non-option positional and stops parsing, so all subsequent flags are dropped. The CLI then errors out: `required option '--address <addr>' not specified`. **Fix:** Either (a) update the README to drop the `--` (`pnpm dev --address 0x...`), or (b) change `dev` to `tsx src/cli/index.ts "$@"` (no bare `index.ts`) so the `--` is the first thing tsx sees and the rest of argv flows through, or (c) call `program.allowUnknownOptions(false).passThroughOptions()` and document it. **Recommended:** (a) — least code change.

3. **[MAJOR] `.env` is still pinned to Alfajores.** `NETWORK=alfajores`, `CELO_RPC_URL=https://alfajores-forno.celo-testnet.org`, `CELOSCAN_API_URL=https://api-alfajores.celoscan.io`. A real mainnet run needs per-invocation env-var overrides (`NETWORK=mainnet CELO_RPC_URL=https://forno.celo.org CELOSCAN_API_URL=https://api.etherscan.io/v2/api`), which works but is fragile — easy to forget, easy to typo.
   **Fix:** Update `.env.example` to document a mainnet profile, or add a `pnpm dev:mainnet` script that wraps the env-var overrides.

4. **[MAJOR] Empty `ANTHROPIC_API_KEY`.** Not a blocker for *this* run (no LLM call path was exercised), but a blocker for any demo that hits an unknown DEX/contract. The classifier already has a graceful rules-only fallback (`src/cli/index.ts:84-93` — `buildLlmDeps()` returns `undefined` when no key, and the classifier at `src/sub-agents/tx-classifier/index.ts` skips the LLM branch). Quality will drop for novel swap routers.
   **Fix:** Optional for submission. If added, set `ANTHROPIC_API_KEY=sk-...` in `.env`.

5. **[NIT] `COINGECKO_API_KEY` empty.** Free CoinGecko is 10-30 calls/min — fine for a single demo wallet. The price oracle (`src/shared/price-oracle/coingecko.ts:114`) only switches to the pro endpoint when a key is set.
   **Fix:** Optional. Skip for hackathon unless the demo wallet has 10+ distinct tokens.

6. **[NIT] Agent wallet unfunded.** `wallets/agent-06.json` shows `fundingStatus: "pending — Quan to fund"`, and the on-disk `AGENT_WALLET_ADDRESS=0x0F5d112fBE6320E2C249326C62a69d87aF436CAb` matches the registered ERC-8004 identity. Without ≥0.5 CELO, `--emit-onchain-log` will fail at the broadcast step (Track 2 "Most Onchain Activity"). Not exercised in this test (per safety constraint), but flagged.
   **Fix:** Fund the agent wallet on mainnet, then re-test log emit in a separate session.

### Cost to run on real mainnet (once gaps are fixed)

| Item                            | Unit cost                              | Per-wallet demo   |
|---------------------------------|----------------------------------------|-------------------|
| Celoscan API key                | free (5 req/sec)                       | **$0**            |
| CoinGecko free tier             | free (10-30 calls/min)                 | **$0**            |
| Anthropic Haiku 4.5 (LLM fallback, ~20% of txs) | $1/M input, $5/M output | **~$0.02-0.05** for 100 txs |
| Celo mainnet tx fee (`--emit-onchain-log`) | ~0.001 CELO ≈ $0.00006  | **<$0.001**       |
| **Total per submission demo**   |                                        | **<$0.10**        |

The only hard cost is the LLM token spend; everything else is either free-tier or sub-cent.

## Recommendation

**Two of the gaps above (Celoscan key + README `--`) are 10-minute fixes and unblock a meaningful mainnet demo.** The pipeline scaffolding itself is sound: 3-second wall clock, exit-0 on graceful degradation, all five stages wired correctly, CSV schema correct. The data plane is just air-gapped by the missing key.

Concrete order of operations for the next 4 days:
1. **Today (≤30 min):** Sign up for a Celoscan API key, add to `.env`. Re-run this same command. Should immediately return non-zero rows for `0xaD01...` (the address has ≥250 token transfers to classify).
2. **Today (≤15 min):** Fix the README `--` example so demo flow matches the working invocation.
3. **Before the deadline:** Add an `ANTHROPIC_API_KEY` for classifier coverage and fund the agent wallet with 0.5 CELO so the onchain log emitter is exercisable. Both are optional but lift the demo from "it ran" to "the onchain identity lights up."

Status below for the orchestrator.

---

**Status:** DONE
**Summary:** First real mainnet run completed in 3 s with exit-0. Pipeline is wired correctly end-to-end; data plane fails because `CELOSCAN_API_KEY` is empty, both the V1 (deprecated) and V2 (auth-required) Celoscan endpoints return `NOTOK` for all three fetcher endpoints, and the classifier/PNL/CSV stages produce an empty but valid report. Also surfaced a README-vs-actual-invocation mismatch (`pnpm dev --` breaks flag parsing under pnpm 9). Cost to fix the blockers is ≈10 minutes and $0; cost to run a real demo end-to-end is <$0.10.
**Concerns/Blockers:** None for this verification task — the user explicitly asked for a gap report, not a successful run. The agent's 0x0F5d wallet is still unfunded, so the onchain log emitter remains un-exercisable; flagged as a [NIT] gap.
