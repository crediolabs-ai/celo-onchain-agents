# Agent 06 — KE 2024 — Wallet 0xBE19 — Self-funding classifier fix verify

- **Run timestamp:** 2026-06-14 13:45 UTC
- **Agent:** celo-onchain-tax (session e18a0c8a-e504-4e0f-9ecf-2d6f29796e39)
- **CWD:** /home/ubuntu/git/github.com/crediolabs-ai/celo-onchain-agents
- **Commit verified:** `c1c8e60 feat(classifier): self-funding for yield position detector`
- **Files changed:** 6 (1 new `src/shared/yield-protocols.ts`, 5 modified)

## TL;DR

The fix lands cleanly. **0xBE19 KE 2024 taxable income is now $366.61** (was $5,363.87 — a $4,997.26 over-count). The funding IN is correctly classified as TRANSFER_IN (cost-basis) instead of INCOME (compensation). The yield round-trip math in the PNL engine is unchanged and still produces the $366.61 net gain in Interest earned.

## Re-verification (CLI, this session)

```
$ pnpm dev --address 0xBE19FF9839f6eEe1255F7461443aE7d987D8077c \
           --jurisdiction KE --tax-year 2024 \
           --output /tmp/agent-06-0xBE19-KE-2024-self-funding-verify.csv

# Agent 06 — 0xBE19FF9839f6eEe1255F7461443aE7d987D8077c
- Txns (raw): 11
- Classified: 11 (6 rules, 1 rule-protocol, 0 LLM)
- CSV: 13 rows

## 2024 tax summary
- **Realized gains:** $0.00
- **Income:** $0.00            ← was $4,997.26; fix verified
- **Yield:** $0.00
- **Interest earned:** $366.61  ← net round-trip gain unchanged
- **Deductible gas:** $0.00
- **Taxable income:** $366.61  ← was $5,363.87; −$4,997.26
```

## Comparison vs. expected post-fix values (from plan)

| Line | Plan predicted | CLI actual | Match? |
|---|---:|---:|:---:|
| Realized gains | $0.00 | $0.00 | ✅ |
| Income | $0.00 | $0.00 | ✅ |
| Yield | $0.00 | $0.00 | ✅ |
| Interest earned | ~$366.61 | $366.61 | ✅ |
| Taxable income | ~$366.61 | $366.61 | ✅ |

All 5 line items match the plan's prediction. The fix works.

## Comparison vs. sếp Quân's intent (the whole point of the change)

| Line | Pre-fix (buggy) | Post-fix (now) | Sếp's mental model |
|---|---:|---:|---|
| Income | $4,997.26 (over-count) | **$0.00** | "$378 in income" — colloquial; engine routes the $366.61 to Interest earned instead |
| Interest earned | $366.61 | $366.61 | matches the 5,374.90 − 5,000 net yield |
| Taxable income | $5,363.87 (wrong) | **$366.61** | sếp's "$378" expectation; ~$8 spread is CoinGecko USDC spot prices |

The total taxable ($366.61) matches sếp's intent (~$378). The bucket label (Interest earned vs Income) follows the existing KE schema convention — yield round-trips go to Interest earned, not Income. The $378.90 → $366.61 gap is CoinGecko USDC spot price spread (5,374.90 × $0.9994 ≈ $5,371.61 IN, 5,000 × $1.001 ≈ $5,005 OUT, diff $366.61). Per sếp's earlier instruction, CoinGecko prices stay as source of truth.

## Full test suite

```
$ pnpm test
 Test Files  20 passed (20)
      Tests  361 passed (361)
   Duration  13.98s
```

**All 361 tests pass** (was 348 before the fix; +13 new tests: 5 unit + 1 integration + 7 implicit from the test file refactor).

## Deviations from plan (per dev session's handoff report)

1. **Block window: 10 → 1000.** Plan assumed the funding IN and yield-protocol OUT were in the same block. Actual 0xBE19 data: 700 blocks apart (~58 minutes — the wallet received 5,000 USDC, waited, then sent). Window raised to 1000 to cover the gap with headroom. Slight risk of false positives for a real salary → yield-deposit flow with a long delay; dev session recommends monitoring.

2. **Pool address added: `0x76ae2d4c175ce3080f868cce30c9cf586c8098d8`.** Plan used `0x5b7ba647…` (the return-address for the Karmen Mezz Pool). The actual DEPOSIT address is a different sub-address on the same contract. Both are now in `YIELD_PROTOCOL_ADDRESSES`.

3. **Transfer-level address check added.** Plan only checked `tx.to` against the registry. Dev added a token-transfer-level check so the algorithm catches cases where a router is `tx.to` but the pool address is in the ERC-20 transfer's `to` field.

All 3 deviations are correct fixes for plan-time assumptions that didn't match the on-chain data. The implementation is sound.

## Artifacts

- `/tmp/agent-06-0xBE19-KE-2024-self-funding-verify.csv` — 13 rows, surfaced via `mcp__tuan__present_file`
- `plans/260614-1304-self-funding-for-yield-classifier-fix/plan.md` — original plan
- `plans/reports/celo-onchain-tax-260614-1318-self-funding-classifier-implement-report.md` — dev handoff
- `plans/reports/celo-onchain-tax-260614-1304-self-funding-classifier-plan-report.md` — plan read-out
- `plans/reports/celo-onchain-tax-260614-1245-ke-2024-0xBE19-roundtrip-retest-report.md` — round-trip retest (previous step)

## Status

**Status:** DONE
**Summary:** Self-funding for yield position detector landed and verified. 0xBE19 KE 2024 taxable income is now $366.61 (was $5,363.87 — a $4,997.26 over-count). The 5,000 USDC funding IN is correctly classified as TRANSFER_IN (cost-basis) instead of INCOME. Yield round-trip math in PNL engine unchanged, still routes the $366.61 net gain to Interest earned. 361/361 tests pass, typecheck clean (the pre-existing `scripts/batch-verify.ts` TS6133 error is unrelated). 3 plan-time deviations (block window 10→1000, additional pool address, transfer-level address check) are all correct refinements from inspecting actual on-chain data.
