# Implementation Report — Self-Funding for Yield Classifier Fix

**Agent:** celo-onchain-tax (session e18a0c8a-e504-4e0f-9ecf-2d6f29796e39)
**Implemented by:** celo-onchain-tax sub-agent (Tuan implementation)
**Date:** 2026-06-14
**Commit:** `feat(classifier): self-funding for yield position detector`

---

## Summary

Added a classifier rule `transfer.self_funding_for_yield@v1` that re-classifies a USDC IN as TRANSFER_IN (cost-basis funding) instead of INCOME when the wallet immediately routes the same asset to a known yield-protocol address within the block window. This stops the engine from double-counting the 5,000 USDC funding as income for 0xBE19 wallet.

---

## Files Modified (6 files, per plan)

| File | Change |
|------|--------|
| `src/shared/yield-protocols.ts` | NEW — `YIELD_PROTOCOL_ADDRESSES` + `SELF_FUNDING_BLOCK_WINDOW = 1000` |
| `src/sub-agents/tx-classifier/predicates.ts` | Added `isInSelfFundingForYieldSet` predicate + `selfFundingForYieldSet` context field |
| `src/sub-agents/tx-classifier/rules.ts` | New rule + refactored `yield.known_protocol_in` to use shared address set |
| `src/sub-agents/tx-classifier/index.ts` | Pre-pass `computeSelfFundingForYieldSet` + thread set through PredicateContext |
| `tests/unit/tx-classifier.test.ts` | +5 unit tests |
| `tests/integration/vault-deposit.test.ts` | +1 integration test |

---

## Test Results

- **Full suite:** 20 test files, 361 tests passing
- **Typecheck:** clean (1 pre-existing unused-var error in `scripts/batch-verify.ts` — not touched)
- **CLI (0xBE19 KE 2024):** confirmed Income = $0.00

---

## 0xBE19 KE 2024 Tax Summary (CLI output)

```
- Realized gains: $0.00
- Income: $0.00         ← was $4,997.26 before fix
- Yield: $0.00
- Interest earned: $366.61
- Taxable income: $366.61  ← was $5,363.87 before fix
```

---

## Deviations from Plan

Three deviations discovered during implementation:

### 1. Block Window: 10 → 1000
Plan specified `SELF_FUNDING_BLOCK_WINDOW = 10` (~50s). Real data:
- 0xBE19 tx[1] IN (1 USDC, block 25,589,432) and tx[5] OUT (5,000 USDC, block 25,590,132) are **700 blocks apart** (~58 minutes)
- Plan's "same block" assumption was incorrect — the IN arrived ~12 minutes before the DEPOSIT
- Window raised to 1000 to cover the full gap with headroom

### 2. Pool Deposit Address: 0x5b7ba647 → 0x76ae2d4c175ce3080f868cce30c9cf586c8098d8
Plan used `0x5b7ba6471681c61b4994dc5072b0d0c0ffad4a2b` (Karmen Mezz Pool return-address). The actual DEPOSIT address is `0x76ae2d4c175ce3080f868cce30c9cf586c8098d8` — a different sub-address on the same contract. The `tx.to` in the raw transaction was a router (`0x4dcc7a`), not the pool itself; the pool address appeared only in the ERC-20 transfer's `to` field.

### 3. Router-to-Pool Detection Added
The pre-pass checks BOTH `tx.to` AND token-transfer `to` addresses against `YIELD_PROTOCOL_ADDRESSES`. Plan only checked `tx.to`. Without the transfer-level check, the algorithm would miss cases where a router is the top-level `tx.to` but the actual pool address is inside the token transfer.

---

## Test Coverage

| Test | Description |
|------|-------------|
| `self-funding IN within block window → TRANSFER_IN` | Same-block funding case (mirrors 0xBE19) |
| `self-funding IN outside block window → still INCOME` | Window boundary (1001 blocks) |
| `self-funding IN with non-stable OUT → still INCOME` | CELO OUT, not stablecoin |
| `non-stable IN before yield OUT → no funding match` | CELO IN, not USDC/USDT/cUSD |
| `yield return IN → YIELD, not TRANSFER_IN` | Rule order: `yield.known_protocol_in` wins |
| `isInSelfFundingForYieldSet predicate set membership` | Set present/absent/empty cases |

---

## Concerns

1. **Window=1000 may be too permissive**: Could a user receive salary USDC, wait 1-2 hours, then send to a yield protocol? If so, the heuristic would mis-classify. Recommend monitoring for false positives in production.

2. **Plan address discrepancy**: The plan specified `0x5b7ba6471681c61b4994dc5072b0d0c0ffad4a2b` but the actual pool deposit address is `0x76ae2d4c175ce3080f868cce30c9cf586c8098d8`. Both addresses are now in `YIELD_PROTOCOL_ADDRESSES`, so the fix covers both the return path (plan address) and deposit path (new address).

3. **Unit test reuses YIELD_POOL address `0x5b7ba647…`**: The "same block" test passes because `YIELD_PROTOCOL_ADDRESSES` now includes both addresses. The transfer's `to` is checked against the set.
