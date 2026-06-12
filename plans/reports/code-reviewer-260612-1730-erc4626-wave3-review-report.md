# Code Review: Wave 3 — ERC-4626 Per-Vault FIFO Lot Identity + YIELD-Disposal Fix

**Date:** 2026-06-12 17:30
**Reviewer:** code-reviewer (Staff Engineer)
**Plan:** `plans/260612-1351-erc4626-vault-support/plan.md` §3
**Branch / commit base:** main @ 886cb12

---

## Scope

- **Files (6 modified, 1 untracked debug, 1 untracked plan):**
  - `src/shared/types.ts` — `ClassifiedTx.vaultAddress?` field
  - `src/sub-agents/pnl-calculator/engine.ts` — `lotKey()`, `lotFromAcquisition()` +6th param, `AssetLot.vaultAddress?`
  - `src/sub-agents/pnl-calculator/fifo.ts` — YIELD-disposal branch, queue key, assetIn pricing
  - `src/sub-agents/pnl-calculator/lifo.ts` — FIFO mirror
  - `src/sub-agents/pnl-calculator/wac.ts` — FIFO mirror + state key
  - `tests/unit/pnl-calculator.test.ts` — 6 new vault cases (3 FIFO + 2 LIFO + 2 WAC per plan §3.3, 1 extra non-vault regression)
  - `tests/unit/pnl-calculator-vault-debug.test.ts` — untracked debug artifact
- **LOC:** 276 insertions / 31 deletions (source + tests)
- **Focus:** Wave 3 of `260612-1351-erc4626-vault-support` plan
- **Verification:**
  - `pnpm test` — **6 of 326 tests fail** (all in new vault cases). 320 pass, including all non-vault regression coverage. 0 collateral damage in 19 other test files.
  - `pnpm typecheck` — 1 pre-existing error in `tests/integration/vault-deposit.test.ts:121` (unrelated to Wave 3 — confirmed by `git stash` baseline). Wave 3 source files compile clean.

---

## Overall Assessment

**❌ NOT READY TO MERGE.** The conceptual design is sound and the per-vault lot-key + assetIn-price fallback are the right shape, but the implementation has one **critical correctness bug** (dead-code disposal branch) and one **pre-existing surface that the change exposes** (USDy decimal mismatch in tests). Both are real defects in the diff and must be fixed before commit.

The bug is subtle enough that a casual reviewer could miss it — `isAcquisition()` short-circuits the iteration before the new disposal condition is ever evaluated, so the YIELD-as-disposal branch is unreachable for the exact scenario it's meant to handle.

---

## ✅ Correctness checks that pass

1. **Per-vault queue key generation** — `lotKey(symbol, vaultAddress)` correctly lowercases the address and degenerates to plain symbol for non-vault lots. Used consistently in FIFO/LIFO/WAC.
2. **Mirror consistency FIFO↔LIFO↔WAC** — The 3-way mirror is mechanical and identical in structure. Vault A vs Vault B separation works the same way in all three engines (verified by the 2-vault acquisitions tests).
3. **WAC state→lot conversion** — Symbol extraction via `key.split(':')[1]!` is safe given the controlled key format produced by `lotKey()`. No user input reaches the key without going through `lotKey()`.
4. **`Address` import usage** — Imported in `engine.ts` and `wac.ts`, used consistently. No `any` / `as any` introduced.
5. **Non-vault regression** — Plan §3.2 promise that "non-vault lots are unaffected" is upheld in the FIFO test at line 300 (no `vaultAddress` → plain symbol key → no behavior change). Confirmed by 320 pre-existing tests still passing.
6. **Type field optionality** — `ClassifiedTx.vaultAddress?: Address` and `AssetLot.vaultAddress?: Address` are both optional. `ClassifiedTxSchema` Zod validation will accept the field when present and ignore it when absent.
7. **`assetIn?.priceUsd ?? c.assetOut.priceUsd` fallback** — Correct for non-vault disposals (assetIn undefined → falls through to assetOut). No regression risk.
8. **BigInt precision preserved** — All amount math stays in bigint space; price conversion happens once at the edge.
9. **Karpathy rule (surgical changes)** — Most lines trace directly to the plan's §3 / §4 requirements. One drive-by regression detected (see Concern #6).

---

## 🚫 Blockers (must fix before commit)

### B1. YIELD-with-assetIn-and-assetOut falls into the acquisition branch — new disposal condition is dead code

**File:** `src/sub-agents/pnl-calculator/fifo.ts:62-83` (and parallel `lifo.ts:49-66`, `wac.ts:61-99`)

**The new disposal condition is unreachable for the exact scenario it was added to fix.**

A vault-withdraw classified as `YIELD` arrives with **both** legs populated (`assetIn` = underlying received, `assetOut` = shares surrendered — per plan §4 "assetIn = underlying USDC, assetOut = shares USDy"). The flow today is:

```ts
// fifo.ts:62
if (isAcquisition(c) && c.assetIn) {        // ← YIELD + assetIn → TRUE
  // …adds a new USDC lot for the incoming underlying…
  continue;                                  // ← iteration ends; disposal never checked
}

if ((isDisposal(c) || (c.type === 'YIELD' && c.assetOut !== undefined)) && c.assetOut) {
  // ← NEVER REACHED for the YIELD vault-withdraw case
}
```

`isAcquisition()` (`engine.ts:140-145`) returns `true` for any YIELD tx with `assetIn` set, so the new disposal branch is dead code for the actual vault-withdraw case.

**Observable consequence (real, not just test-only):**
- A YIELD tx with both legs creates a *new* USDC lot (acquisition of the underlying) instead of consuming the USDy lot.
- The USDy position persists on the books past the withdraw.
- The `disposal` record is never emitted → tax CSV omits the disposal row.
- `yieldMicroUsdTotal` is double-counted (income of USDC, plus a phantom USDy lot later).

**Why the test fails to catch this for the user:** The test author wrote the fixture with both legs *and* expected a single Disposal. The test would have caught this *if* it ran — and it does fail (`FIFO: vault withdraw as YIELD disposal — the previously-silent YIELD-skip bug is fixed`, 6/6 failures include this). So the failure is real; the question is whether the fix addresses it.

**Recommended fix (one of):**

1. **Reorder the branches** — put the disposal check before the acquisition check in all three engines. The YIELD-with-both-legs tx will then be treated as a disposal of assetOut (correct). A YIELD-with-assetIn-only tx (staking reward) still hits `isAcquisition` on the next iteration. (Simplest; minimal blast radius.)

2. **Tighten `isAcquisition()`** in `engine.ts:140`:
   ```ts
   export function isAcquisition(c: ClassifiedTx): boolean {
     return (
       (c.type === 'TRANSFER_IN' || c.type === 'INCOME' || c.type === 'YIELD') &&
       c.assetIn !== undefined &&
       !(c.type === 'YIELD' && c.assetOut !== undefined)  // vault withdraw → disposal, not acquisition
     );
   }
   ```
   This preserves the original `isAcquisition` callers and adds the rule once in the helper.

3. **Inline the check** in each engine's acquisition branch. (Most code, least DRY.)

**Recommendation:** Option 2 — single point of change, self-documenting, mirrors the new disposal condition's intent. Also need to ensure `yieldMicroUsdTotal` is still incremented for the assetIn leg (income recognized at disposal time) so the totals are consistent with the pre-fix YIELD income accounting.

---

### B2. Tests compute zero cost basis for USDy — fixture uses 6-decimal amounts but engine defaults to 18

**File:** `tests/unit/pnl-calculator.test.ts:222-475` (all 6 new vault cases)

`mkAcquisition({ symbol: 'USDy', amount: '1000000', … })` represents 1 USDy at 6 decimals. The engines resolve decimals via `decimalsBySymbol[symbol] ?? 18`. `USDy` is **not** in `DEFAULT_DECIMALS` (`engine.ts:78-86`), so decimals fall back to 18:

```ts
costBasisMicroUsd = (priceMicro * amountRaw) / 10**decimals
                  = (1_000_000 * 1_000_000) / 10**18
                  = 0n   // integer truncation
```

Confirmed: 5 of 6 test failures root-cause to this. WAC's 6th failure is a cascade (state cost = 0n, state amount consumed to 0, state filtered out of `remainingLots`).

**Recommended fix:** Pass `decimalsBySymbol: { USDy: 6 }` to every vault test. Two options:

- (a) Add a `const VAULT_DECIMALS = { USDy: 6 };` constant near the vault describe blocks and spread it into each `computeFifo/Lifo/Wac` call.
- (b) Add `'USDy': 6` to `DEFAULT_DECIMALS` in `engine.ts`. USDy is real (verified on-chain per plan §F3) and used as the share token symbol for the only registered vault; this is a one-line global fix that future tests will also benefit from.

**Recommendation:** (b) — the real-world value is 6 (USDy wraps USDC, both 6-dec), and the engine's hard-coded `DEFAULT_DECIMALS` is the canonical place for known tokens. A grep confirms no current test uses `USDy` outside the new vault cases, so no test regression risk.

---

## ⚠️ Concerns (numbered, with file:line + suggested fix)

### C1. Classifier does not populate `vaultAddress` — the entire change is dormant in production

**Files:** `src/sub-agents/tx-classifier/index.ts:177-320`, `src/sub-agents/pnl-calculator/fifo.ts:64,85` (and mirrors)

The PNL engines read `c.vaultAddress` to key the lot queue and the disposal lookup. The classifier is the only writer of `ClassifiedTx` and **never sets `vaultAddress`** (grep-verified — zero matches in `src/sub-agents/tx-classifier/`). The `enrichClassifiedWithAssetLegs()` function at `index.ts:354-409` populates `assetIn` and `assetOut` but not `vaultAddress`.

**Consequence:** In production, every vault tx arriving at the PNL engine has `c.vaultAddress === undefined`. The lot key degenerates to the plain symbol. The fix in Wave 3 is **inert** for any real-world input — the demo would behave identically to before this change.

**This is a Wave 1 responsibility that was never wired up.** Plan §1.3 Step 1.3 (selector table) and §1.3 Step 1.4 (address gate) describe classifier changes, but neither says "and also set `c.vaultAddress` on the output." The Wave 3 plan assumes Wave 1's classifier already populates this field; it does not.

**Suggested fix (Wave 1, not Wave 3):**
In `src/sub-agents/tx-classifier/index.ts` near the protocol-decoder hit (line 266) and the protocol-aware hit (line 215), set `vaultAddress` on the classified tx when the matched address is a registered vault. Concretely:

```ts
// Around index.ts:215-225 (protocol-aware path) and :266-275 (protocol-decoder path)
const isVault = /* check against UNTANGLED_USDY_VAULT and future vault allowlist */;
const txOut: ClassifiedTx = {
  hash: tx.hash,
  type: categoryType, // or txType
  timestamp: tx.timestamp,
  classifierSource: 'rule',
  // …
  ...(isVault && { vaultAddress: tx.to as Address }),
};
```

**Severity:** Critical for end-to-end functionality; not a Wave 3 bug per se (Wave 3's code is correct given the field is set), but the plan's success criteria (`demo: investor tx classified as YIELD with vault-tracked lot`) cannot be met until the classifier writes this field.

**Verification needed:** Confirm with planner / fullstack-developer whether Wave 1 was supposed to write `vaultAddress` and it was missed, or whether the wiring is in a follow-up commit. If the latter, this PR should not land yet.

---

### C2. Plan §8.3 regression test (staking-reward YIELD still income) is NOT present

**File:** `tests/unit/pnl-calculator.test.ts`

Plan §8.3 explicitly mandates:
> **Mitigation:** add a regression test asserting that staking-reward YIELD txs (no `assetOut`) are still treated as income (the `isAcquisition` branch already handles this — the new branch only fires when `assetOut` is present, which is never for staking rewards).

**Status: MISSING.** No test in the new vault block uses `type: 'YIELD'` without `assetOut`. Plan §3.3 lists 3 vault test cases (deposit+withdraw round-trip, two deposits partial withdraw, two vaults same share symbol), and the implementation added 6 — none assert the staking-reward scenario.

**Suggested fix:** Add to the FIFO `describe` block:

```ts
it('FIFO: staking-reward YIELD (no assetOut) still counted as income, not disposal', () => {
  const result = computeFifo({
    classified: [
      mkAcquisition({ symbol: 'G$', amount: '1000000000000000000', priceUsd: 0.001, timestamp: TS_2024 }),
      // Staking reward: YIELD with only assetIn (no assetOut).
      {
        hash: mkHash(), timestamp: TS_2024_MID, type: 'YIELD',
        assetIn: { symbol: 'G$', amount: '500000000000000000', priceUsd: 0.0011 },
        classifierSource: 'rule',
      },
    ],
  });
  expect(result.disposals).toHaveLength(0);
  expect(result.yieldMicroUsdTotal).toBe(550_000n); // 0.0011 * 0.5 G$ in micro-USD
  expect(result.remainingLots.get('G$')).toHaveLength(2);
});
```

This locks in the non-vault-YIELD behavior that §8.3 promises won't drift.

---

### C3. `pnl-calculator-vault-debug.test.ts` should not ship

**File:** `tests/unit/pnl-calculator-vault-debug.test.ts` (untracked)

Contents: a single `it` block that does `console.log('keys', [...result.remainingLots.keys()])` and asserts only that the key exists. No real coverage of vault behavior. Verdict per the tester (260612-1729) and per Karpathy rule #2 (no abstractions / scaffolding for single-use code):

**🗑️ DELETE before commit.** The same coverage is provided (properly, with assertions) by the new vault cases in `pnl-calculator.test.ts`. The debug file is a development scratch artifact.

If for any reason the team wants to keep a regression smoke test for the per-vault key, fold the assertion into `pnl-calculator.test.ts` and delete the file with the `console.log`s.

---

### C4. YIELD-with-assetOut-only (no assetIn) case is not tested

**Files:** `src/sub-agents/pnl-calculator/fifo.ts:83`, `lifo.ts:66`, `wac.ts:99`

The new disposal condition `(c.type === 'YIELD' && c.assetOut !== undefined)` would also fire for a YIELD tx that has `assetOut` set but `assetIn` *undefined*. This is a theoretical case (vault withdraw normally has both legs), but the plan does not assert what should happen. Three reasonable interpretations:

- (a) It's a vault withdraw with the incoming leg not detected (e.g., the underlying's transfer event was filtered out). Treat as disposal of shares — the new code does this.
- (b) It's a malformed classification. Skip silently.
- (c) It's a different protocol's YIELD tx (e.g., a partial-yield-bearing redeem that only logs the share burn). The legacy code skipped it.

The new code picks (a). This is a defensible default, but it's a behavior change for a niche case. **Suggested fix:** Add a test that pins the chosen interpretation, e.g.:

```ts
it('FIFO: YIELD with assetOut but no assetIn is treated as disposal (defensive default)', () => {
  const result = computeFifo({
    classified: [
      mkAcquisition({ symbol: 'USDy', amount: ONE_USDC_VAULT, priceUsd: 1.0, timestamp: TS_2024, vaultAddress: VAULT_A }),
      { hash: mkHash(), timestamp: TS_2024_MID, type: 'YIELD',
        assetOut: { symbol: 'USDy', amount: ONE_USDC_VAULT, priceUsd: 1.0 },
        classifierSource: 'rule', vaultAddress: VAULT_A },
    ],
  });
  expect(result.disposals).toHaveLength(1);
  // proceeds use assetOut.priceUsd (assetIn is undefined → falls through).
  expect(result.disposals[0]!.proceedsMicroUsd).toBe(1_000_000n);
});
```

This makes the choice deliberate and regression-proof.

---

### C5. WAC disposes more than the lot in the partial-lot branch (pre-existing, exposed by tests)

**File:** `src/sub-agents/pnl-calculator/wac.ts:115`

`const take = sellAmount < cur.amount ? sellAmount : cur.amount;` — when the disposal exceeds the pool, `take = cur.amount` (the whole pool). Then `priceGaps.push(...)` is recorded and the disposal is still emitted with the partial amount. This is the same shape as before, so it's not a regression — but the new vault tests don't exercise the partial-pool gap path. **Optional:** add a vault-specific gap test to confirm the per-vault key is used for the gap entry's `asset` field (currently set to `symbol`, not the key — see also C6).

---

### C6. WAC `priceGaps` reports plain symbol, not vault-prefixed key

**File:** `src/sub-agents/pnl-calculator/wac.ts:105,143`

```ts
priceGaps.push({ asset: symbol, timestamp: c.timestamp });
```

For a vault tx, `symbol` here is `'USDy'` (assetOut.symbol). The `remainingLots` map uses the per-vault key (`'0xaaaa...:USDy'`). The gap entry is not key-aligned with the inventory, so a downstream consumer correlating gaps to lots has to guess which vault the gap refers to. **Suggested fix:** push the lot key instead of the symbol for vault txs:

```ts
priceGaps.push({ asset: key, timestamp: c.timestamp });
```

Optional — pre-existing behavior for non-vault txs is preserved if you key on `key` (which is `symbol` for non-vault, `vault:symbol` for vault).

---

### C7. Drive-by date regression in unrelated comment

**File:** `src/shared/types.ts:161`

```
- Addition #1 (Tuan, 2026-06-08).
+ Addition #1 (Tuan, 2026-08-08).
```

The Wave 3 work is dated 2026-06-12, not 2026-08-08. The original `2026-06-08` documented when the field was originally added. The change is unrelated to the Wave 3 scope and is almost certainly a typo or accidental edit. **Suggested fix:** revert this line to `2026-06-08`. Per Karpathy rule #3 ("Touch only what you must. Clean up only your own mess."), a drive-by date change in an unrelated comment is the kind of thing a reviewer should reject.

---

## 📋 Recommendations (nice-to-haves)

### R1. Add a single, well-named helper for the new disposal condition

`fifo.ts:83`, `lifo.ts:66`, `wac.ts:99` repeat the same predicate:
```ts
(isDisposal(c) || (c.type === 'YIELD' && c.assetOut !== undefined)) && c.assetOut
```

The outer `&& c.assetOut` is redundant with the second clause's `c.assetOut !== undefined` (and `isDisposal`'s own check). Suggest hoisting to `engine.ts` next to `isAcquisition` / `isDisposal`:

```ts
/** Whether a classified tx consumes from the lot queue. Extends isDisposal to
 *  treat YIELD-with-assetOut as a disposal (vault withdraw: shares surrendered). */
export function isLotConsumption(c: ClassifiedTx): boolean {
  if (c.type === 'TRANSFER_OUT' || c.type === 'SWAP') return c.assetOut !== undefined;
  if (c.type === 'YIELD') return c.assetOut !== undefined;
  return false;
}
```

Then the three engines reduce to `if (isLotConsumption(c))`. Combined with the `isAcquisition` fix in B1/Option-2, the engine loops read like the intent: "if it's an acquisition, add a lot. else if it consumes a lot, walk the queue."

### R2. Document the lot-key collision avoidance in the `lotKey` JSDoc

`engine.ts:99-107` is the canonical comment. Consider adding one line: "Two lots with the same symbol but different vault addresses will share *no* queue entries — verified by the FIFO/LIFO/WAC test blocks in `tests/unit/pnl-calculator.test.ts`." This helps future readers trace the test that proves the contract.

### R3. Plan §4 "open question #3" (asset-leg symbol selection) is unresolved

The plan leaves asset-leg selection open and recommends "pick by symbol." The implementation just stores whatever `enrichClassifiedWithAssetLegs` puts in (largest-incoming-by-value). For yield-bearing vaults where the underlying amount > share amount, this means the largest-incoming could be the underlying (correct) — but if the underlying is large and the share mint is small or absent, the share mint might be missed. **Not a blocker for v1** (1:1 vaults only), but worth noting for Wave 2 / yield-bearing vault support.

### R4. Add an integration test that exercises the full pipeline (classifier → engine)

Plan §1.3 Step 1.7 test #7 mentions a "real investor tx classifies as YIELD" test. The Wave 3 changes would benefit from one end-to-end test that:
1. Feeds the real `0x102fd04c…8f7e` tx through `classify()`.
2. Verifies the classified tx has `vaultAddress` set.
3. Feeds the classified tx through `computeFifo()`.
4. Asserts the lot is queued under the per-vault key.

This would have caught C1 (classifier not writing `vaultAddress`). Suggested file: `tests/integration/vault-deposit-with-pnl.test.ts`.

---

## 🗑️ Debug file verdict

`tests/unit/pnl-calculator-vault-debug.test.ts` — **DELETE before commit.**

- 1 test, no real assertions (only checks that a key exists).
- 2 `console.log` calls in production test code.
- All meaningful vault coverage is (or will be, after B2 is fixed) in `pnl-calculator.test.ts`.
- No assetLeg correctness coverage.
- Tester's 260612-1729 report concurs.

If the team wants the smoke test kept, fold the assertion into `pnl-calculator.test.ts` and delete the file with the `console.log`s.

---

## Edge cases found by scout

- **USDy not in `DEFAULT_DECIMALS`** — caught by tests (B2 above).
- **`vaultAddress` never written by classifier** — caught by tracing writes (C1 above).
- **Disposal branch unreachable for YIELD-with-both-legs** — caught by reading branch order in `fifo.ts:62-83` (B1 above).
- **WAC empty-lot key not returned in `remainingLots`** — caught by WAC test failure (secondary symptom of B2).
- **Staking-reward YIELD not regression-tested** — caught by comparing tests to plan §8.3 (C2 above).
- **Drive-by date typo** — caught by reading `types.ts` diff (C7 above).

---

## Recommended Actions (prioritized)

1. **🚫 Fix B1 (dead-code disposal branch).** Without this, the YIELD vault-withdraw case is silently broken in production. Recommended approach: tighten `isAcquisition()` (Option 2).
2. **🚫 Fix B2 (USDy decimals).** Add `'USDy': 6` to `DEFAULT_DECIMALS` in `engine.ts` — one line, fixes 5 of 6 test failures.
3. **🗑️ Delete the debug test file** (C3).
4. **⚠️ Address C1 (classifier writes `vaultAddress`)** — required for the end-to-end fix to actually work. Likely a Wave 1 scope miss; confirm with planner/fullstack-developer whether this needs to be in this PR or a follow-up.
5. **⚠️ Add the staking-reward regression test** (C2) per plan §8.3.
6. **📋 Apply the C7 one-line comment revert** before commit.
7. **📋 Optional:** apply R1 (helper extraction) — code quality win, makes the fix in B1 read more clearly.

After B1, B2, and the debug-file deletion, re-run `pnpm test` and `pnpm typecheck`; expect 326/326 pass (modulo the pre-existing `vault-deposit.test.ts:121` error, which is out of scope here).

---

## Metrics

- **Test coverage (Wave 3):** 6 new cases, 196 LOC added to `pnl-calculator.test.ts`. After fixes, all should pass.
- **Type coverage:** 100% (no `any` introduced; `Address` import used consistently).
- **Linting:** not re-run; pre-existing `vault-deposit.test.ts:121` TS error blocks clean typecheck.
- **Pre-existing regressions:** 0 (320 of 326 pre-Wave-3 tests still pass; the 6 failures are all in the new Wave 3 cases).
- **Backward compat:** ✓ Plan §8.3 promises upheld for the symbols-not-amounts case; the YIELD-with-assetOut-AND-assetIn case is a behavior change but is the correct one (was a bug).

---

## Unresolved questions

1. **C1 (classifier writes `vaultAddress`)** — Is this a Wave 1 scope miss that should block Wave 3 landing, or is it a planned follow-up? Without the classifier write, Wave 3's correctness fix is dormant.
2. **Plan §4 open question #1** (disposal pricing: share vs underlying) — plan recommends underlying; implementation matches (uses `assetIn?.priceUsd ?? assetOut.priceUsd`). No action needed.
3. **Plan §4 open question #3** (asset-leg symbol selection) — still open; not blocking for v1 (1:1 vaults) but flagged for Wave 2 / yield-bearing vaults.
4. **C6 (WAC gap entry uses plain symbol)** — should this be the per-vault key, or stay plain symbol for CSV compatibility? No current consumer, so default to the key for forward compatibility.
5. **Pre-existing `tests/integration/vault-deposit.test.ts:121` typecheck error** — out of Wave 3 scope but should be fixed in a follow-up (one-line cast to `\`0x${string}\``).

---

**Status:** BLOCKED
**Summary:** Wave 3's design is correct and the per-vault lot key + assetIn pricing + YIELD-disposal intent are all aligned with the plan. However, the YIELD-disposal branch in all three engines is dead code for the actual vault-withdraw case (blocked by `isAcquisition` short-circuiting first) — this is a real correctness bug. The 6 new test failures are dominated by a USDy-decimal mismatch (test fixable in one line) but the YIELD branch ordering bug must be fixed in the engine code. Also flagged: the classifier never writes `vaultAddress`, so the entire change is dormant in production until that wiring lands. The debug test file should be deleted.
**Concerns/Blockers:**
- 🚫 B1: YIELD disposal branch unreachable (engine fix required)
- 🚫 B2: USDy decimals default to 18 (test or DEFAULT_DECIMALS fix)
- 🗑️ Debug test file to delete
- ⚠️ C1: Classifier doesn't write `vaultAddress` — Wave 3 is dormant in prod
- ⚠️ C2: Plan §8.3 staking-reward regression test missing
- ⚠️ C7: Drive-by date typo in unrelated comment
