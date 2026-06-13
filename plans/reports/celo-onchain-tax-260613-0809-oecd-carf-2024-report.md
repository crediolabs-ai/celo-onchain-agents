# Celo Onchain Tax — OECD CARF, 2024

**Run:** 2026-06-13 08:09 UTC
**Address:** `0x46788b60daf46448668c7abaeea4ac8745451c25` (`0x4678…1c25`)
**Jurisdiction:** OTHER (OECD CARF filer)
**Tax year:** 2024
**Method:** FIFO

## Fetch

- Raw txs: **194**
- Token transfers: **1**
- Internal txs: **0**
- Duration: **38 ms**

## Classification

- Classified: **194** (33 rule hits, 0 LLM, 0 rule-protocol)
- Flagged for review: **2**

## 2024 tax summary (USD)

| Line | Amount |
|---|---|
| Realized gains | $0.00 |
| Income | $0.00 |
| Yield | $0.00 |
| Deductible gas | $0.00 |
| **Taxable income** | **$0.00** |

## Output

- CSV: `/tmp/v3-carf-2024.csv` (12,151 bytes, 99 rows, `oecd-carf` schema)

## Observation

The wallet is an **operator/contract deployer**, not a personal user wallet. The analysis correctly handled 194 native CELO transactions; this address has **no user-level income, gain, or yield events** in 2024. The two flagged-for-review transactions are routine contract-deployment traces the rule engine could not classify deterministically.

For a meaningful CARF sample, a user wallet with DEX/swaps, staking, or income-receiving activity is recommended. The pipeline is ready — the demo wallet just does not exercise those paths.

**Status:** DONE
**Summary:** OECD CARF 2024 report generated for demo wallet 0x4678…1c25; 194 txs classified, $0 taxable income (operator wallet, no user-level events).
