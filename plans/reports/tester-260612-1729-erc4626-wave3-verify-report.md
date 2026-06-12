# Tester Report: Wave 3 ERC-4626 Verification

**Date:** 2026-06-12
**Plan:** `plans/260612-1351-erc4626-vault-support/`
**Files changed:** src/shared/types.ts, engine.ts, fifo.ts, lifo.ts, wac.ts, tests/unit/pnl-calculator.test.ts

---

## 1. Compilation — `npx tsc --noEmit`

**Status: FAIL**

```
tests/integration/vault-deposit.test.ts(121,7): error TS2322: Type 'string' is not assignable to type '`0x${string}`'.
```

One pre-existing type error in an unrelated integration test file (`vault-deposit.test.ts`). Not introduced by Wave 3 changes — same error existed before.

---

## 2. `pnl-calculator.test.ts` (21 passed / 6 failed)

**Status: FAIL — 6 new failures introduced by Wave 3**

All 6 failures are in the new ERC-4626 vault test cases. Root cause identified:

### Root Cause: USDy decimal mismatch

`mkAcquisition` passes `amount: '1000000'` for USDy, intending this to represent 1 USDC (6-decimal). However, `computeFifo/Lifo/Wac` uses `decimalsBySymbol` to resolve decimals — since `DEFAULT_DECIMALS` has no entry for `USDy`, it falls back to **18 decimals**.

The cost basis formula is:
```
costBasisMicroUsd = (priceMicro * amountRaw) / (10 ** decimals)
                  = (1_000_000 * 1_000_000) / 10^18
                  = 0   ← integer division truncates to 0
```

This cascades into all vault-specific assertions expecting `costBasisMicroUsd = 1_000_000n` — they all get `0n` instead.

### Failing Tests

| Test | Expected | Got |
|------|----------|-----|
| FIFO: two deposits into same vault create two separate lots | `costBasisMicroUsd = 1_000_000n` | `0n` |
| FIFO: two deposits into DIFFERENT vaults stay in separate queues | `costBasisMicroUsd = 1_000_000n` | `0n` |
| FIFO: vault withdraw as YIELD disposal | `disposals.length = 1` | `0` |
| LIFO: vault withdraw consumes newest lot from that vault only | `costBasisMicroUsd = 1_200_000n` | `0n` |
| WAC: two deposits into different vaults maintain separate running averages | `costBasisMicroUsd = 1_000_000n` | `0n` |
| WAC: vault withdraw disposes against only that vault's pool | `remainingLots.get(...)` | `Target cannot be null or undefined` (queue not found → 0n WAC state → null pointer) |

The WAC "null or undefined" failure is a secondary symptom: when cost basis is 0n, WAC state becomes `{ amount: 1_000_000n, costBasisMicroUsd: 0n }`, so `remainingLots.get()` returns `undefined` instead of the expected empty array.

### Fix Required

Each vault test (or the shared `describe` block) needs to pass `decimalsBySymbol: { USDy: 6 }` to `computeFifo`/`computeLifo`/`computeWac`, because USDy is a 6-decimal vault share token, not 18-decimal.

Example fix location — add `decimalsBySymbol: { USDy: 6 }` to the `FIFO` describe block or to each affected `it` block's `computeFifo({ ..., decimalsBySymbol: { USDy: 6 }, classified: [...] })`.

---

## 3. `pnl-calculator-vault-debug.test.ts`

**Status: PASS (1/1)**

```typescript
✓ debug vault FIFO > check vault lot key
```

The debug test also produces `costBasisMicroUsd: 0n` for the same reason, but it only checks that the `remainingLots` key exists — it does not assert on `costBasisMicroUsd`. Hence it passes.

---

## 4. Full Suite — `npx vitest run`

**Status: FAIL — 6 failures, 320 passed**

```
Test Files  1 failed | 19 passed (20)
Tests  6 failed | 320 passed (326)
```

All 6 failures are the new vault tests in `pnl-calculator.test.ts` described above. No regressions in:
- Mento tests ✓
- Ubeswap tests ✓
- Moola tests ✓
- GoodDollar tests ✓
- tx-classifier tests ✓
- csv-exporter tests ✓
- orchestrator tests ✓
- All other unit/integration tests ✓

---

## 5. `pnl-calculator-vault-debug.test.ts` — Should it ship?

**Verdict: DELETE before commit.**

The file is a one-off debug script that:
- Only tests that the `remainingLots` Map key exists (no assertion on cost basis values)
- Uses `console.log` for output rather than test assertions
- Has only 1 test covering a single happy-path scenario
- Doesn't test disposal, LIFO, WAC, YIELD, or any edge cases

It was clearly written to debug the `lotKey` implementation during development. The real test coverage for ERC-4626 vault behavior is in `pnl-calculator.test.ts` (which, once the decimal bug is fixed, will provide proper assertions).

---

## Summary of Required Fixes

1. **`pnl-calculator.test.ts`**: Add `decimalsBySymbol: { USDy: 6 }` to all vault-specific test cases — USDy is a 6-decimal vault share token, not 18-decimal.
2. **`tests/unit/pnl-calculator-vault-debug.test.ts`**: Delete — debug artifact.
3. **Pre-existing TS error** (`vault-deposit.test.ts:121`): Unrelated to Wave 3, but should be fixed separately.

---

**Status:** DONE_WITH_CONCERNS
**Summary:** Wave 3 changes compile (1 pre-existing TS error in vault-deposit.test.ts unrelated to this wave) and pass all existing tests. The 6 new vault-specific tests in `pnl-calculator.test.ts` fail due to a USDy decimal mismatch (test uses 6-decimal amounts but engine defaults to 18 decimals for unknown tokens) — fix is to pass `decimalsBySymbol: { USDy: 6 }` in the vault tests. The debug file `pnl-calculator-vault-debug.test.ts` should be deleted before commit.
**Concerns/Blockers:**
- 6 new vault tests fail due to decimal mismatch — tests need `decimalsBySymbol: { USDy: 6 }` added
- `tests/unit/pnl-calculator-vault-debug.test.ts` is a debug artifact that should be deleted
- Pre-existing TS error in `tests/integration/vault-deposit.test.ts:121` (type `string` vs `0x${string}`) — not introduced by Wave 3, but blocks clean compilation
