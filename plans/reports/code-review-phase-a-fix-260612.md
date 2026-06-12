# Code Review — Phase A Path-Ordering Fix

**Date:** 2026-06-12
**Reviewer:** code-reviewer (Staff Engineer pass)
**Scope:** 3 changed files, ~22 lines net diff
**Verification:** grep + read; no execution of tests (orchestrator already verified 301/301 + E2E)

## Verdict

**APPROVED_WITH_NITS**

The fix is correct, minimal, and surgical. The 10-line guard properly redirects selectors in the protocol-decoder's `SELECTOR_MAP` away from the selector-registry path. The 4-line E2E result (4 rule-protocol hits on DeFi wallet, 0 regressions on the 62 INTERACTION rows) confirms the path-ordering is fixed. No P0 issues found.

## Findings

### [P1] Path-ordering guard lacks direct unit test coverage (regression risk)
`src/sub-agents/tx-classifier/index.ts:244-253` — The guard is currently only verified indirectly via:
- 20 protocol-decoder unit tests that exercise `decodeProtocolAction()` in isolation
- 1 E2E run on a real DeFi wallet (DeFi-specific, hard to reproduce in CI)

A future refactor that moves the guard, removes the `SELECTOR_MAP` import, or inverts the condition would silently re-break Phase A without any test failure. **301/301 tests pass today, but none of them assert "selector in BOTH maps → classifierSource is 'rule-protocol'".**

Suggested tests in `tests/unit/tx-classifier.test.ts`:

1. **`tx with selector in BOTH maps uses protocol-decoder path`**
   - `tx.input = '0x4e71d92d...'`, `tx.to = '0x94A3240f484A04F5e3d524f528d02694c109463b'` (GoodDollar reserve), no LLM deps
   - Assert: `output.classified[0].classifierSource === 'rule-protocol'`
   - Assert: `output.classified[0].type === 'INCOME'` (verify via `protocolActionToTxType` — current Phase A report shows `income`)
   - Assert: `output.classified[0].notes` includes `'GOODDOLLAR:CLAIM_YIELD'`
   - Assert: `output.protocolDecoderHits === 1`
   - Assert: `output.interactionBreakdown` does NOT have a key for `'claim'` (this is the specific behavior change — the selector-registry path was previously incrementing this counter)

2. **`tx with selector in SELECTOR_MAP only (not in selector-registry) uses protocol-decoder path`**
   - `tx.input = '0x8d46b1e8...'` (Mento `swapExactIn` — not in selector-registry), `tx.to = MENTO_BROKER`
   - Assert: `output.classified[0].classifierSource === 'rule-protocol'`
   - This is the canonical "decoder fires on its own table" path

3. **`tx with selector in selector-registry only (not in SELECTOR_MAP) still uses selector-registry path`**
   - Pick a selector in `selector-registry.ts` not in `SELECTOR_TABLE` (e.g., `0xa9059cbb` = `transfer(address,uint256)` on a non-ERC20 contract)
   - Assert: `output.classified[0].classifierSource === 'rule'` (NOT `'rule-protocol'`)
   - Assert: `output.interactionBreakdown` has the function-name key
   - This is the regression guard — verifies the new path doesn't accidentally swallow all selector-registry hits

### [P1] TS type / Zod schema drift is a pre-existing pattern, not a one-off
`src/shared/types.ts:152` (TS interface) vs `:359` (Zod schema) — Both define `classifierSource` independently. The TS interface was updated in commit `a1ee767` (Phase A) but the Zod schema was forgotten. The current fix correctly patches the Zod enum, but the file's own comment at line 314-320 says "Zod schemas (single source of truth for runtime validation) … Do not redefine these elsewhere." — which is contradicted by maintaining parallel TS/Zod definitions.

**Root cause:** TS type and Zod schema are not derived from each other. Drift is inevitable.

**Recommendation (not blocking, separate refactor):** Derive the TS type from the Zod schema:
```typescript
export type ClassifiedTx = z.infer<typeof ClassifiedTxSchema>;
```
Or extract a `const CLASSIFIER_SOURCES = ['rule', 'rule-protocol', 'llm', 'flagged'] as const;` and reference it from both the TS union and `z.enum(...)`. The current fix is correct; this P1 is to surface the systemic risk for a future refactor.

### [P2] Redundant `extractSelector` call when selector IS in SELECTOR_MAP
`src/sub-agents/tx-classifier/index.ts:244` and `:500` — `extractSelector(tx.input)` runs once at the guard, then `classifyBySelector()` re-extracts the same selector internally. Cost is trivial (string slice + `toLowerCase()`), but the new code adds the second call point.

Not worth fixing — performance impact is negligible and the API change (passing the selector in) would couple the helper to its caller.

### [P2] `extractSelector` is duplicated across two files
`src/shared/selector-registry.ts:528` (returns `0x${string} | null`) and `src/sub-agents/tx-classifier/protocol-decoder.ts:236` (returns `string | null`) — Identical bodies, different return types. Pre-existing code smell. The new guard uses the `selector-registry` version (consistent with `classifyBySelector` at line 500), which is the right choice. Flag for a future cleanup, not this fix.

### [P2] `SELECTOR_MAP` export placed mid-file
`src/sub-agents/tx-classifier/protocol-decoder.ts:162` — The export sits between `buildSelectorMap()` and the "Public API" section. Convention in the rest of the codebase is to put exports at the top of the file or in a clearly marked section. Not a bug; the function still exports correctly. Stylistic.

### [NIT] Comment block uses the literal selector value `0x4e71d92d`
`src/sub-agents/tx-classifier/index.ts:241` — The comment hard-codes a selector as an example. If the table ever changes, the comment goes stale silently. Could reference `SELECTOR_TABLE` by index, but that's overengineering for a comment. Leave as-is.

## Correctness Verification

### 1. `extractSelector` format consistency ✅
Both `extractSelector` implementations (`selector-registry.ts:528`, `protocol-decoder.ts:236`) return lowercase `0x`-prefixed 10-char strings. `SELECTOR_MAP` keys in `protocol-decoder.ts:62-148` are also lowercase `0x`-prefixed 10-char strings. `Map.has()` lookups match. No format drift.

### 2. `continue` placement ✅
The `continue` is inside `if (selectorHit)` (line 251), which is inside the outer `if (!selector || !SELECTOR_MAP.has(selector))` (line 245). When the selector IS in `SELECTOR_MAP`:
- Outer condition is `false` → `classifyBySelector()` is NOT called → `continue` is NOT reached
- Execution falls through to step 2.7 (`decodeProtocolAction` at line 260)

Step 2.5 is skipped; step 2.7 runs. Exactly as intended.

### 3. Edge cases ✅
- **Empty `tx.input` (`''` or `'0x'`):** `extractSelector` returns `null` → `!selector` is `true` → guard enters → `classifyBySelector` returns `null` for empty calldata → falls through to step 2.7. Correct.
- **Non-hex input (no `0x` prefix):** `extractSelector` returns `null` → same path as above. Correct.
- **Lowercase vs uppercase input:** `extractSelector` lowercases its output. `SELECTOR_MAP` keys are lowercase. No mismatch. Correct.
- **`tx.input.length < 10`:** `extractSelector` returns `null` → falls through. Correct.

### 4. SELECTOR_MAP export safety ✅
- Exported value: `Map<string, { protocol, action, functionName }>` — all fields are already returned by `decodeProtocolAction()` to callers. No internal-only state leaked.
- Export pattern: matches `decodeProtocolAction` (named export, top-level const). Consistent.
- Privacy was incidental, not deliberate — the map was always consumed by the public `decodeProtocolAction`. Exporting it is a safe widening of the public surface.

### 5. `types.ts` schema fix ✅
- TS type at line 152: `'rule' | 'rule-protocol' | 'llm' | 'flagged'`
- Zod schema at line 359: now also includes `'rule-protocol'`
- After fix: both definitions match. The fix is a one-line change that brings them in sync.

### 6. Pipeline trace for `0x4e71d92d` to GoodDollar reserve ✅
1. Step 1 (rule): no match → continue
2. Step 2.3 (protocol-name): GoodDollar reserve is not a native token in `protocolIndex` and Celoscan metadata likely doesn't categorize it → falls through
3. Step 2.5 (NEW GUARD): `extractSelector` returns `'0x4e71d92d'`, `SELECTOR_MAP.has('0x4e71d92d')` is `true` → guard skips `classifyBySelector`, falls through
4. Step 2.7 (protocol-decoder): `decodeProtocolAction` called → `SELECTOR_MAP.get('0x4e71d92d')` returns `{ protocol: GOODDOLLAR, action: CLAIM_YIELD, ... }` → `isKnownProtocolAddress(GOODDOLLAR_RESERVE, GOODDOLLAR)` is `true` → returns `{ protocol: GOODDOLLAR, action: CLAIM_YIELD, confidence: 0.9, functionName: 'claim/claimTokens' }`
5. `protocolActionToTxType` maps to `INCOME`
6. `classifierSource: 'rule-protocol'`, type `'INCOME'`, notes `'GOODDOLLAR:CLAIM_YIELD (claim/claimTokens)'`

Matches the E2E output in `phase-a-fix-260612.md` lines 131-138.

### 7. Side effects for selectors NOT in SELECTOR_MAP ✅
- Outer `if (!selector || !SELECTOR_MAP.has(selector))` is `true` (the second clause)
- `classifyBySelector` is called as before
- Identical behavior to pre-fix for any selector not in `SELECTOR_TABLE` (e.g., `0xa9059cbb` = `transfer`, all the selector-registry-only entries)

The fix is a strict subset of pre-fix behavior plus a new path for the 14 selectors in `SELECTOR_TABLE`. No regressions possible for the 99%+ of selectors that aren't in the decoder table.

### 8. Out-of-scope changes ✅
Verified via `git diff --stat HEAD`:
- `.memo.jsonl` — internal memo, not code
- `src/shared/types.ts` — only the schema enum (1 char added)
- `src/sub-agents/tx-classifier/index.ts` — import line 62 + 10-line guard at 231-243
- `src/sub-agents/tx-classifier/protocol-decoder.ts` — 1-word export change at line 162

No adjacent refactoring. Karpathy "Surgical Changes" guideline satisfied.

## Recommended Actions (prioritized)

1. **Add 1-3 unit tests** for the path-ordering guard in `tests/unit/tx-classifier.test.ts` (P1, ~30 min, prevents silent regression). Use the test scenarios in the P1 finding above.
2. **Track TS/Zod drift as a separate refactor task** (P1, low priority) — derive TS types from Zod schemas via `z.infer<typeof ...>` or shared `as const` arrays. Don't block this fix on it.

## Metrics
- Files reviewed: 3 (plus 1 report for context, plus 1 selector-registry.ts for cross-check)
- LOC reviewed: ~700
- LOC changed in diff: ~22 net
- Test coverage: 301/301 (already verified) + 20 protocol-decoder unit tests
- Lint/typecheck: clean (already verified)

## Unresolved Questions

None — the fix is correct, the E2E confirms it works, and the only outstanding items are P1 tests and a separate refactor.

---

**Status:** DONE_WITH_CONCERNS
**Summary:** Path-ordering fix is correct, minimal, and surgical. The 10-line guard properly routes selectors in the protocol-decoder's `SELECTOR_MAP` to step 2.7 and bypasses step 2.5. E2E confirms 4 rule-protocol hits (was 0) with no regressions on the 62 other rows. Three P1/P2 concerns flagged, none blocking: (1) no direct unit test for the path-ordering guard — recommend 1-3 tests in `tx-classifier.test.ts` to prevent silent regression; (2) TS type / Zod schema drift is a pre-existing pattern issue (fix is in the right place, but the systemic risk should be addressed in a separate refactor); (3) minor stylistic nits (redundant `extractSelector` call, `extractSelector` duplication across two files, mid-file export placement).
**Concerns/Blockers:** None blocking. The P1 test gap is the only actionable follow-up; everything else is observation.
