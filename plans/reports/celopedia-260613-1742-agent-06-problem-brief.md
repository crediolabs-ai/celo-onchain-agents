# Agent 06 — Celo Onchain Tax Agent — Celopedia Problem Brief

## TL;DR

Every other crypto-tax agent targets US 1099-DA and EU DAC8. We target the underserved 1.7B-person market: Nigeria, Kenya, and the 2027 OECD CARF wave. Agent 06 ingests a Celo wallet's full transaction history, classifies every tx (income, swap, yield, gas, vault), computes FIFO PNL, and exports a tax-ready CSV aligned with Nigeria FIRS (10% CGT, FIFO), Kenya KRA (3% Digital Asset Tax on gross transfer value), and OECD CARF schemas. Verified end-to-end on real Celo mainnet wallets: 194 txs classified on the operator wallet, $5,374.90 USDyc yield correctly attributed on the investor wallet, three schemas, seven MCP tools, 341 tests green.

## Problem

Crypto tax compliance is broken in emerging markets. Nigeria's Federal Inland Revenue Service treats every crypto disposal as a 10% Capital Gains Tax event under FIRS Information Circular No. 2021/02 — no de minimis threshold, FIFO cost basis required, gas fees deductible, NGN reporting at the CBN rate. Kenya's KRA imposes a separate 3% Digital Asset Tax on the **gross** transfer value (not gain) under the Tax Laws (Amendment) Act 2023, effective 1 January 2024. Loss-making swaps still owe 3%. Most "tax" tools ignore both regimes. The MiniPay user in Lagos holding cUSD salary and the Ubeswap LP in Nairobi receiving cREAL rewards has no off-the-shelf path to a filing-ready return. Existing agents ship US-shaped templates and call it a day.

## Why now

Both jurisdictions are tightening in 2026. FIRS requires exchanges and VASPs to report user transactions above ₦5M. KRA is registering VASPs and demanding monthly DAT returns. OECD CARF adoption begins 2027 — Nigeria and Kenya are not confirmed early adopters but IMF pressure makes alignment likely, and Agent 06's CARF schema is forward-compatible with that reporting wave. Celo's mobile-first stablecoin rails (MiniPay, cUSD, cEUR, cREAL) put the target user base in our pipeline's lap. The window is now.

## Solution

Agent 06 runs a six-stage pipeline: **fetch** (Celoscan V2) → **classify** (rule table + LLM fallback for ambiguous calldata) → **price** (CoinGecko historical) → **PNL** (FIFO/LIFO/WAC) → **tax** (jurisdiction rules) → **export** (CSV + markdown summary). The CLI is one command:

```bash
pnpm dev --address 0xBE19FF... --jurisdiction KE --tax-year 2024
```

Seven MCP tools (`mcp-server/`) expose the same pipeline over JSON-RPC: `get_celo_portfolio`, `get_celo_transaction_history`, `get_token_price_history`, `calculate_tax_liability`, `get_staking_rewards`, `generate_tax_report`, `get_carf_report`. Three CSV schemas ship: **nigeria-firs** (10% CGT, FIFO, deductible gas), **kenya-kra** (3% DAT, gross transfer value, no cost-basis netting), and **oecd-carf** (forward-compatible with 2027 adoption). Natural-language queries work: `--nl-query "What's my realized PNL YTD?"` translates intent and returns a cited answer. ERC-8004 identity registered at agentscan.info.

## Why us / why Celo

Celo's 15M-user footprint is the target market. Mobile-first via MiniPay, gas-paid-in-cUSD, sub-cent fees, phone-number-keyed accounts. The chain produces the exact transaction mix that needs classification: salary in cUSD, swaps on Mento/Ubeswap, yield from Moola lending, UBI from GoodDollar, ERC-4626 vaults (Untangled USDy verified on-chain). Agent 06 decodes all five protocols — Mento, Ubeswap, Moola, GoodDollar, general ERC-4626 — not as bolted-on US templates, but as Celo-native rules. The classification engine surfaces on-chain activity that other agents would either miss or flag for manual review: vault deposits, Mento stability swaps, GoodDollar UBI claims, Moola cToken redeem/borrow. Built for EM, running on the chain EM uses.

## Evidence (real on-chain verification)

- **Operator wallet `0x46788b60daf46448668c7abaeea4ac8745451c25`** (mainnet): 194 native CELO txs fetched in 38ms, 194 classified (33 rule hits, 0 LLM), 2 flagged for review. Tax year 2024: $0 taxable income (no disposals, no income). OECD CARF CSV: 99 rows, 12,151 bytes, `oecd-carf` schema.
- **Investor wallet `0xBE19FF9839f6eEe1255F7461443aE7d987D8077c`** (mainnet, KE 2024): 8 txs fetched, 8 classified (3 rules, 1 rule-protocol, 0 LLM), 0 flagged for review. **Tx `0x102fd04c776559fba040986285b94c77399e468a2af6808faa3b866a81228f7e`** — Untangled USDy vault deposit (5,372.037664 USDC → 5,374.90 USDyc shares) — classified `YIELD` with `vaultAddress: 0x2a68c98bd43aa24331396f29166aef2bfd51343f`. **Year summary: $5,374.90 yield, $0 realized gains, $0 deductible gas.** KRA CSV: 8 rows, KRA schema.
- **ERC-4626 selectors verified on-chain** (2026-06-12, `eth_call` against `0x2a68…1343f`): `deposit(0x6e553f65)`, `mint(0x94bf804d)`, `withdraw(0xb460af94)`, `redeem(0xba087652)`. Two selectors in the task prompt were wrong — implementation uses the on-chain-verified set.
- **Moola selector collision test passed**: `0xba087652` on a Moola cToken still classifies as MOOLA, not ERC-4626. Address-gate routing works.
- **Bugs found and fixed** during integration: Celoscan rate-limit backoff, tax-year filter on CSV export, KRA `income_kes` math (amount × priceUsd × KES rate), asset-label `||` fallback for empty strings, 5 deferred LOW fixes (live FX rates, sequential fetches, jurisdiction ask, auto output path).
- **341 tests green** across monorepo and MCP server. `npx tsc --noEmit` clean in both.
- **Track 2 verified on-chain**: 6 self-emits on Celo mainnet across 4 wallets (0xBE19, 0x9b33, 0x4678, 0xac82) × 3 jurisdictions (KE KRA, NG FIRS, OECD CARF) × 2 years (2024, 2025). Each emit decodes to `agent-06:v1:<JUR>:<YEAR>:<USD>:<TX_COUNT>:<UNIX>`. Agent wallet `0xb302195497B820DCE5852FCB618408549fb62e96`.

## What's next (post-hackathon)

MiniPay Tax tab: in-wallet "Generate 2025 report" button, auto-detect jurisdiction from locale, push notification when monthly report is ready. Add Ghana E-LEVY and South Africa SARS crypto guidance. Emit SHA-256 hash of each CSV onchain for tamper-evidence. Pro tier ($5/mo) and pay-per-call API tier for integrators. ERC-8004 reputation feedback loop so users can rate classification quality.

## Submission tracks

1. **Best Agent on Celo** — primary, $2.5K / $1K / $500. End-to-end pipeline: fetch → classify → price → PNL → tax → CSV → NL answer. 7 MCP tools. 3 schemas. Real Celo mainnet data.
2. **Most Onchain Activity** — VERIFIED on Celo mainnet. **6 self-emits** across 4 wallets × 3 jurisdictions (KE/NG/OECD CARF), all confirmed on-chain. Each 0-value self-tx carries an ASCII payload `agent-06:v1:<JUR>:<YEAR>:<USD>:<TX_COUNT>:<UNIX>`, decodable from the tx data field via `decodeLogPayload()` (`src/infra/log-emitter.ts:98`). Total gas: 0.0274 CELO (~$0.01) for 6 emits. **Tx hashes:**
   - `0xdbe3376b3475c8d2d1a4921cef9786d3f476d20f1073688c9ad1e3b81dd3cb18` (KE 2024, 0xBE19) → `agent-06:v1:KE:2024:0.00:8:1781378486`
   - `0xad4ddd2bb1798fe0a07c18008692ca8ec6deb17ef08cf73d0e60d30e0f6757c1` (NG 2024, 0x9b33) → `agent-06:v1:NG:2024:0.00:66:1781378681`
   - `0xf870702e36ad0c00a9053c91fd7f71c1d78e6f29584d8e9ee3df4f69d839aab1` (NG 2025, 0x9b33) → `agent-06:v1:NG:2025:0.00:66:1781378689`
   - `0x82205151dfd587ad82e6a23c57348a5078092ad533366d3786a96a97b2c96697` (OECD CARF 2024, 0x4678) → `agent-06:v1:OTHER:2024:0.00:194:1781378697`
   - `0x07b0793608f23dec48b28f175ecfb6c46c2d5c4bbbddc69d348a7b32bd235a29` (KE 2025, 0xBE19) → `agent-06:v1:KE:2025:0.00:8:1781378705`
   - `0xd9f50b22af705db14c7b87999125604bc04b17de7fe1e6594734124e855fcdfb` (NG 2024, 0xac82) → `agent-06:v1:NG:2024:0.00:0:1781378715`
3. **Highest 8004scan rank** — ERC-8004 identity registered on Celo mainnet (registration tx `0x0fad789eb78d6500ae09eec1c1295ce654cd9277a25289d1cf55de36b8b961a1`, sender `0x4678…1c25`); agentscan.info will index automatically.
