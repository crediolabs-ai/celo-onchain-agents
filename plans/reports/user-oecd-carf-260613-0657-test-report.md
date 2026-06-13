---
name: user-oecd-carf-260613-0657-test-report
description: First-time-user run of celo-onchain-tax agent on operator wallet under OECD CARF, 2024 FIFO
metadata:
  type: user
---

# User test report — OECD CARF, 2024 FIFO

## What I asked for
- Wallet: `0x46788b60daf46448668c7abaeea4ac8745451c25` (ERC-8004 deployer / operator)
- Jurisdiction: `OTHER` (CARF)
- Tax year: `2024`
- Method: FIFO (default)
- Output: `/tmp/user-oecd-carf.csv`
- No `--emit-onchain-log`

## CLI output (verbatim)

```
# Agent 06 — 0x46788b60daf46448668c7abaeea4ac8745451c25

- Jurisdiction: OTHER
- Tax year: 2024
- Method: FIFO
- Txns (raw): 194
- Txns (token transfers): 1
- Txns (internal): 0
- Classified: 194 (33 rules, 0 rule-protocol, 0 LLM)
- Flagged for review: 10
- CSV: agent-06-2024-oecd-carf.csv (194 rows, oecd-carf)
- Duration: 39ms

## 2024 tax summary
- Realized gains: $0.00
- Income:         $0.00
- Yield:          $0.00
- Deductible gas: $0.00
- Taxable income: $0.00
```

CSV written to `/tmp/user-oecd-carf.csv` (26 KB, 194 data rows).

## 1. Did it complete without errors?
Yes. Pipeline finished in 39 ms (most of the 739 ms was pnpm). No stack traces, no fetch errors, no provider failures. Clean run.

## 2. Is the CSV readable and does it show transactions?
Yes. 194 rows, 9 columns, plain CSV. Headers: `reporting_period, tx_date, asset_type, tx_type, gross_proceeds_usd, cost_basis_usd, pnl_usd, user_jurisdiction, notes`. Opens in any spreadsheet.

## 3. Do the summary numbers look reasonable?
**Yes, $0 PNL is correct for an operator wallet.** This is a contract-deployer / multisig operator address. It broadcasts and receives ERC-8004 / Gnosis Safe / Wormhole transactions; it does not trade, stake, or receive income. The summary correctly shows zero realized gains, zero income, zero yield, zero deductible gas. Nothing a CARF reporting entity would actually owe tax on. As a non-technical user this is the answer I would expect.

## 4. Did the OECD CARF schema render correctly?
**Partially.** The CSV is tagged `oecd-carf` and includes the right bookkeeping columns (`gross_proceeds_usd`, `cost_basis_usd`, `pnl_usd`, `user_jurisdiction`). But the user-facing prompt said columns like `asset_in`, `asset_out`, `proceeds`, `cost_basis`, `gain` — those exact names are not in the output. The schema is "CARF-flavored" (USD denominated, period-tagged, jurisdiction-tagged) but not the literal CARF XML field names. For a real CARF filing I'd have to map this to the CRS / CARF XML schema myself. The headers are close enough to be useful, not close enough to be filed as-is.

## 5. Did 161 "flagged for review" rows explain themselves?
**Big discrepancy from what the system prompt claimed.** The demo wallet's documented behavior is "194 txs, 161 flagged for review." This run flagged only **10**. Why? Looking at the notes:

> `"Flagged for review: No LLM deps provided; no rule matched"`

The LLM fallback layer is disabled in this environment. So the system downgrades to rule-only classification, which catches more (33 rule hits, 0 LLM), but the rows the LLM would have explained simply become "unmatched" with a one-line note. For a non-technical user: **I cannot tell what those 10 rows actually are.** The note doesn't tell me whether they're benign contract-deploy txs, suspicious bridge calls, or something I need to look at manually. "Flagged for review" should at least say *why* in human terms ("unknown function selector — manual classification recommended").

## 6. The thing I would actually complain about as a user

**`--tax-year 2024` did not filter to 2024 transactions.** The `reporting_period` column says `2024` for every row, but `tx_date` contains 99 rows from 2024, **94 rows from 2025, and 1 row from 2026-06-09** (a name registration two days ago). A real user filing 2024 taxes would be alarmed: "Why is my 2024 report showing 2025 and 2026 data? Is the year filter broken, or is the report mixing periods?"

This is a real bug-or-design-choice that needs product clarification. The user-facing summary header says "2024 tax summary" but the underlying transaction list is the full wallet history. A CARF report for 2024 should contain only 2024 transactions.

## 7. Other observations

- **Token transfers: 1.** Almost all of this wallet's 194 txs are contract calls (constructor deployments, Gnosis Safe execTransaction, attest, Wormhole callBridgeCall, TransparentUpgradeableProxy, register). The single token transfer is not a swap, just an ERC-20 movement. So "1 transfer" is consistent with "this is an operator, not a trader."
- **Notes column is the most useful part.** It tells me the function selector and a plain-English description for ~90% of rows ("Gnosis Safe multisig execution", "ERC-8004 attest", "Contract creation", "Wormhole/LayerZero callBridgeCall"). For an operator wallet that's actually the data a CARF reporter needs — proof that the wallet is infrastructure, not personal trading.
- **`user_jurisdiction` correctly says `OTHER` in every row.** Good.
- **`Duration: 39ms`** is suspiciously fast for 194 onchain lookups. This implies the data was cached. That's fine for a repeat run but a first-time user might wonder if anything was actually fetched. The system prompt warned me not to use `--refresh` on first run, so this is the expected path.

## What I would change as a user

1. **Fix the year filter.** A `--tax-year 2024` report should contain only 2024-dated transactions, or it should print a clear warning at the top: *"Note: 94 of 194 transactions fall outside 2024 — included for completeness."* Right now it does neither.
2. **Rename "Flagged for review" notes to be human-readable.** "No LLM deps provided; no rule matched" is engineering-speak. "Unknown function — please classify manually" is user-speak.
3. **Document the actual CSV schema somewhere visible.** The system prompt mentioned `asset_in`, `asset_out`, `proceeds`, `cost_basis`, `gain` — none of those columns exist. Either the docs are stale or the schema was renamed; a user who prepared for one schema would get a different one.
4. **Print a one-line cache indicator.** "39ms — data from cache, last refreshed X days ago" would help users trust the result.

## Status

**Status:** DONE_WITH_CONCERNS
**Summary:** Pipeline ran cleanly end-to-end, produced a 194-row OECD-tagged CSV with $0 PNL (correct for this operator wallet) in under a second, but the `--tax-year 2024` flag does not actually filter to 2024 transactions and the "flagged for review" notes are engineering-speak that a non-technical user cannot interpret.
**User concerns:** (1) 2024 report contains 2025 + 2026 transactions — year filter is misleading; (2) "Flagged for review" reasons are not human-readable; (3) CSV schema does not match the user-facing schema documentation; (4) 39 ms wall-clock is suspiciously fast — no indication whether data was cached or freshly fetched.
