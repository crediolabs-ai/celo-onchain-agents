# Phase A Bug Fix Report — tx-classifier path-ordering

**Date:** 2026-06-12
**Session:** 257c2228-7fad-40e6-adbc-6d6fc84cd4da
**Agent:** credio-orchestrator → phase-a-e2e-verification → phase-a-fix

---

## TL;DR

**Fix applied. Phase A protocol-decoder now fires correctly.**

| Metric | Before fix | After fix |
|---|---|---|
| `rule-protocol` hits | 0 | 4 |
| GoodDollar rows | `INTERACTION` / `claim() (Generic claim)` | `income` / `GOODDOLLAR:CLAIM_YIELD (claim/claimTokens)` |

---

## Root Cause

`src/sub-agents/tx-classifier/index.ts` processes txs in this order:

```
step 2.3  protocol-name path       → checked first
step 2.5  classifyBySelector()     → checked second  ← BUG: fires for 0x4e71d92d
step 2.7  decodeProtocolAction()   → checked third   ← never reached for known selectors
```

Selector `0x4e71d92d` (GoodDollar claim) is in **both** the selector-registry (`CLAIM` → `INTERACTION`) and the protocol-decoder's `SELECTOR_TABLE` (`GOODDOLLAR:CLAIM_YIELD`). The selector-registry path fired first and `continue`d before the protocol-decoder could run.

---

## Changes

### 1. `src/sub-agents/tx-classifier/protocol-decoder.ts` — line 162

```diff
- const SELECTOR_MAP = buildSelectorMap();
+ export const SELECTOR_MAP = buildSelectorMap();
```

**Why:** `SELECTOR_MAP` was already being built but was file-private. Exporting it allows `index.ts` to check whether a selector belongs to the protocol-decoder before delegating to the generic selector-registry path.

### 2. `src/sub-agents/tx-classifier/index.ts` — line 62 (import)

```diff
- import { decodeProtocolAction } from './protocol-decoder.js';
+ import { decodeProtocolAction, SELECTOR_MAP } from './protocol-decoder.js';
```

### 3. `src/sub-agents/tx-classifier/index.ts` — lines 231–243 (step 2.5 guard)

```diff
    // 2.5. No protocol hit. Try the function-selector path: extract the
    //      leading 4-byte selector from `tx.input` and look it up in the
    //      selector-registry. Matched selectors lift the tx to a
    //      category-specific type; unmatched selectors with non-empty
    //      input fall through as INTERACTION with the raw selector in
    //      notes (so the user sees the unknown call site).
+
+     // Guard: if the selector is in the protocol-decoder's SELECTOR_MAP,
+     // skip the selector-registry path so the decoder (step 2.7) can handle
+     // it. This avoids the case where a selector in both maps (e.g.
+     // 0x4e71d92d = GoodDollar claim) is captured by the generic
+     // selector-registry path as INTERACTION before the specific
+     // GOODDOLLAR:CLAIM_YIELD decoding can run.
+     const selector = extractSelector(tx.input);
+     if (!selector || !SELECTOR_MAP.has(selector)) {
+       const selectorHit = classifyBySelector(tx, ctx);
+       if (selectorHit) {
+         classified.push(selectorHit.tx);
+         interactionBreakdown[selectorHit.breakdownKey] =
+           (interactionBreakdown[selectorHit.breakdownKey] ?? 0) + 1;
+         continue;
+       }
+     }
-     const selectorHit = classifyBySelector(tx, ctx);
-     if (selectorHit) {
-       classified.push(selectorHit.tx);
-       interactionBreakdown[selectorHit.breakdownKey] =
-         (interactionBreakdown[selectorHit.breakdownKey] ?? 0) + 1;
-       continue;
-     }
```

**Total added lines:** 10 (guard + wrap of existing logic).

### 4. `src/shared/types.ts` — line 359 (schema fix)

```diff
- classifierSource: z.enum(['rule', 'llm', 'flagged']),
+ classifierSource: z.enum(['rule', 'rule-protocol', 'llm', 'flagged']),
```

**Why:** The TypeScript type already had `'rule-protocol'` but the Zod schema was missing it, causing a runtime validation error when the protocol-decoder path emitted its `classifierSource: 'rule-protocol'` value.

---

## Test Results

```
$ pnpm typecheck
 → clean (tsc -p tsconfig.json, no errors)

$ pnpm test
 → 18 test files passed (18)
 → 301 tests passed (301)
 → Duration: 12.05s
```

No regressions.

---

## E2E Re-run Metrics (DeFi wallet `0x9b3319a7f1f6a7bc48af14c9b81c7c1394`)

```
Classified:       66 (0 rules, 4 rule-protocol, 0 LLM)
Flagged for review: 0
Duration:         1124ms
```

### Classification breakdown

| Type | Count |
|---|---|
| income | 4 |
| other | 62 |

### GoodDollar rows (sample)

```
2024-12-21,income,UNKNOWN,0,0.00,0.00,0.00,0.00,"GOODDOLLAR:CLAIM_YIELD (claim/claimTokens)"
2024-12-22,income,UNKNOWN,0,0.00,0.00,0.00,0.00,"GOODDOLLAR:CLAIM_YIELD (claim/claimTokens)"
2025-04-13,income,UNKNOWN,0,0.00,0.00,0.00,0.00,"GOODDOLLAR:CLAIM_YIELD (claim/claimTokens)"
2026-04-14,income,UNKNOWN,0,0.00,0.00,0.00,0.00,"GOODDOLLAR:CLAIM_YIELD (claim/claimTokens)"
```

**Before fix:** all 4 were `INTERACTION` with `Function selector: claim() (Generic claim)` — wrong type and wrong semantic label.

**After fix:** `income` type + `GOODDOLLAR:CLAIM_YIELD` semantic in notes — correct.

### Other rows (no regression)

The 62 `other` (INTERACTION) rows remain correctly classified — Bridged USDC withdraws (`0xcac35c7a`) still correctly show as `Unmatched selector: 0xcac35c7a`.

---

## Side Effects

- No side effects observed.
- All 62 other-classified rows unchanged.
- Protocol-decoder code (20 unit tests) remains untouched and fully verified.
- The selector-registry path is unaffected for selectors NOT in `SELECTOR_MAP`.

---

---

## Unit Test Coverage (added 2026-06-12)

3 regression tests added to `tests/unit/tx-classifier.test.ts` covering the path-ordering guard at `index.ts:244-253`.

| Test | Selector | Target | Path | Result |
|---|---|---|---|---|
| GoodDollar claim (selector in BOTH maps) | `0x4e71d92d` | GoodDollar reserve | `rule-protocol` | ✅ PASS |
| Ubeswap swap (selector in SELECTOR_MAP only) | `0x38ed1739` | Ubeswap router | `rule-protocol` | ✅ PASS |
| ERC-20 transfer (selector in selector-registry only) | `0xa9059cbb` | Any address | `rule` | ✅ PASS |

Notes:
- Mento swap (`0x8d46b1e8`) cannot be used for this test: a `flag.mento_stability` rule fires at step 1 for all MENTO_BROKER/MENTO_ROUTER addresses, blocking step 2.7. Ubeswap used instead — same protocol-decoder path verification.
- Test 1 also asserts `interactionBreakdown` has no `claim` key, directly verifying the guard skipped `classifyBySelector`.
- Test 3 asserts `protocolDecoderHits === 0` to confirm no protocol-decoder false-positive.

```
$ pnpm typecheck → clean
$ pnpm test       → 304/304 passed (+3)
```

**Status:** DONE
**Summary:** Path-ordering bug fixed. Protocol-decoder SELECTOR_MAP now guards step 2.5; GoodDollar claims (0x4e71d92d) now correctly reach decodeProtocolAction(). E2E: 4 rule-protocol hits (was 0), all 4 GoodDollar rows show correct income/YIELD classification. Schema missing 'rule-protocol' also fixed. No regressions. 3 unit tests added for the guard (304/304 total).
**Concerns/Blockers:** None.
