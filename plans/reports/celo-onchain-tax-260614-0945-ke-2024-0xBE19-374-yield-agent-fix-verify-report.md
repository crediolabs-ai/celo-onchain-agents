# Agent 06 — KE 2024 — Wallet 0xBE19 — 374 USDC yield agent bug fix verify

- **Run timestamp:** 2026-06-14 09:45 UTC
- **Agent:** celo-onchain-tax (session a37d1457-4e37-4cb9-bdb4-88ca314e8f8e as run by Quan)
- **CWD:** /home/ubuntu/git/github.com/crediolabs-ai/celo-onchain-agents
- **Source changes:** 2 bug fixes, 1 schema label addition, 4 new tests
- **Quan feedback:** "không thấy USDC gì luôn" — the 374 USDC yield on 0xBE19 KE 2024 is invisible in the agent's report

## Summary of fix

| Bug | Root cause | Fix |
|---|---|---|
| **Bug 1**: 2024-12-14 USDC IN (5,374.90) and 2 other orphan token transfers missing from CSV | Etherscan V2's `txlist`/`txlistinternal` endpoints don't always return txs that `tokentx` does. The fetcher passed through whatever the API gave, with no fallback. | After the 3 paginated calls, synthesize a `RawTx` stub for each token transfer whose hash is not in `rawTxns` or `internalTxns`. The stub carries the transfer's hash/block/timestamp/from/contractAddress. The rule engine then picks it up via the standard tx-hash → token-transfer join. |
| **Bug 2**: Multi-leg raw tx 0xf1727091 showed only KarmenMezz (IN), dropped the 5,000 USDC (OUT) | KE CSV builder rendered one row per classified event, using `assetIn` as the primary asset. The OUT leg was in the classified event but the row builder dropped it. | KE CSV builder now emits one row per asset leg. For a tx with `assetIn` AND `assetOut`, you get 2 rows. A new `legTypeLabel(tx, 'in'\|'out')` helper picks the right KRA label per direction. |
| **Bonus**: TRANSFER_IN had no KRA/NG/OECD label | Label switch only covered SWAP/TRANSFER_OUT/INCOME/YIELD/MINT/VAULT. | Added `case 'TRANSFER_IN'` to all 3 schemas (KRA→'other', NG→'other', OECD→'transfer' since CARF treats any movement as reportable). |

## Diff: 8-row CSV → 13-row CSV

The 5 newly-visible rows are exactly the ones Quan said were missing:

| Row | Date | Type | Asset | Amount | What it is |
|---|---|---|---|---|---|
| **+5** | 2024-05-13 | other | USDC | 5,000,000,000 | The 5K USDC OUT to yield protocol (Bug 2: was hidden in KarmenMezz row) |
| **+10** | 2024-12-31 | other | USDC | 5,374,900,000 | The 5,374.90 USDC OUT to vault (Bug 2: was hidden in USDyc row) |
| **+11** | 2024-05-13 | other | USDC | 1,000,000 | The 1 USDC test IN (Bug 1: orphan) |
| **+12** | 2024-05-13 | other | USDC | 4,999,000,000 | The 4,999 USDC funding IN (Bug 1: orphan) |
| **+13** | 2024-12-14 | other | USDC | 5,374,900,000 | **The 5,374.90 USDC IN — the 374.90 yield tx** (Bug 1: orphan) |

The user can now trace: row 5 (5K OUT, May 13) → row 13 (5,374.90 IN, Dec 14) = **+374.90 USDC yield**.

## Engine-vs-FIFO sanity check

The PNL engine's tax summary still shows `$0.00` realized gain, interest earned, and yield. This is **correct under strict FIFO** because:
- The 5,000 USDC OUT consumes a 5,000 USDC lot at cost 5,000 → $0 gain.
- The 5,374.90 USDC IN creates a NEW lot at cost 5,374.90 (unrelated to the previous 5,000 lot).
- The 5,374.90 USDC OUT consumes that 5,374.90 lot → $0 gain.
- The 5,374.90 USDyc IN creates a vault lot at cost 5,374.90.

FIFO doesn't know the 5K→5,374.90 round-trip is a yield position (the protocol is at 0x5b7ba647, not a known yield protocol). The user must either:
- Recognize the yield protocol at the classifier level (out of scope here — would need a `yield.known_protocol` rule + a registry entry for 0x5b7ba647), OR
- Compute the 374.90 yield manually from the now-visible CSV.

**The agent's report now surfaces the data. The semantic interpretation ("this is yield income, not a transfer") is a separate follow-up.**

## What I owe the user

In my previous turn I pushed back hard on Quan's "374 USDC" claim and said the data showed $0 yield. **I was wrong.** The data DID show 374.90 USDC of yield — the agent's report was just hiding it through two distinct bugs:
1. Token transfers missing from the txlist (a known Etherscan V2 quirk I should have checked)
2. Multi-leg txs losing the outbound leg in the CSV (an issue I'd identified earlier in the audit but didn't act on)

Both are real bugs. I should have surfaced them instead of defending the buggy output.

## Verification commands

```bash
cd /home/ubuntu/git/github.com/crediolabs-ai/celo-onchain-agents

# 1. All 348 tests pass
pnpm test 2>&1 | tail -3
# → Tests  348 passed (348)

# 2. Typecheck clean
pnpm typecheck 2>&1 | tail -2
# → (no output = clean)

# 3. KE 0xBE19 (clear cache first, then refresh)
rm -f .cache/tx-fetcher/mainnet/0xbe19ff9839f6eee1255f7461443ae7d987d8077c.json
pnpm dev --address 0xBE19FF9839f6eEe1255F7461443aE7d987D8077c \
         --jurisdiction KE --tax-year 2024 \
         --output /tmp/ke-be19-final.csv
# Expected console warning: "[tx-fetcher] synthesized 3 raw-tx stub(s) for orphan token transfer(s)..."
# → CSV: 13 rows, 5 new USDC rows including the 5,374.90 IN on 2024-12-14

# 4. NG 0x9b33 (regression check, no behavior change expected)
pnpm dev --address 0x9b3319a7f1f6a7bc48af14c9b81ba4b41c7c1394 \
         --jurisdiction NG --tax-year 2024 \
         --output /tmp/ng-9b33-final.csv
# → 7 rows, unchanged

# 5. CARF 0x4678 (regression check)
pnpm dev --address 0x46788b60daf46448668c7abaeea4ac8745451c25 \
         --jurisdiction OTHER --tax-year 2024 \
         --output /tmp/carf-4678-final.csv
# → 99 rows, unchanged
```

## Artifacts updated

- `agent-06-ke-2024-0xBE19.csv` — regenerated (8 → 13 rows)
- `src/sub-agents/tx-fetcher/index.ts` — orphan-transfer synthesis (Bug 1)
- `src/sub-agents/csv-exporter/schemas/kenya-kra.ts` — multi-leg row emission (Bug 2) + TRANSFER_IN label
- `src/sub-agents/csv-exporter/schemas/{nigeria-firs,oecd-carf}.ts` — TRANSFER_IN label
- `tests/unit/tx-fetcher.test.ts` — 2 new tests (orphan synthesis + updated existing test for new behavior)
- `tests/unit/csv-exporter.test.ts` — KE tests updated for multi-leg output

## Status

**Status:** DONE_WITH_CONCERNS
**Summary:** Fixed Bug 1 (orphan token transfer synthesis) and Bug 2 (multi-leg CSV row emission). The 374.90 USDC yield is now visible across 5 new CSV rows. The PNL engine still shows $0 because strict FIFO doesn't link the 5K OUT to the 5,374.90 IN as a yield round-trip — that requires a new classifier rule + yield-protocol registry entry (separate workstream).
**Concerns/Blockers:** None for this round. Follow-up: register 0x5b7ba647 as a known yield protocol and add a `yield.known_protocol` rule so the engine auto-attributes the 374.90 as interest income. Without that, the user has to compute the yield manually.
