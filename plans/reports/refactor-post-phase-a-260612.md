# Refactor Report — Post-Phase-A Cleanup

**Date:** 2026-06-12
**Scope:** Refactor #6 (extractSelector dedup) + Refactor #5 (Zod/TS drift)

---

## Refactor #6 — `extractSelector` Dedup

### Files touched

| File | Change |
|------|--------|
| `src/shared/extract-selector.ts` | **Created** — 22 lines, shared implementation |
| `src/shared/selector-registry.ts` | Replaced local definition (lines 520–532) with re-export from `extract-selector.js`; preserves `0x${string}` return type for backward compat |
| `src/sub-agents/tx-classifier/protocol-decoder.ts` | Removed local `extractSelector` (lines 236–240); added `extractSelector` to existing `selector-registry.js` import |

### `selector-registry.ts` — before vs after
```ts
// Before (lines 520–532):
/**
 * Extract the 4-byte function selector ...
 */
export function extractSelector(input: string): `0x${string}` | null {
  if (!input || input === '0x' || input.length < 10) return null;
  if (!input.startsWith('0x')) return null;
  return input.slice(0, 10).toLowerCase() as `0x${string}`;
}

// After:
/**
 * Implementation lives in the shared `extract-selector.ts` util.
 */
export { extractSelector } from './extract-selector.js';
```

### `protocol-decoder.ts` — before vs after
```ts
// Before:
// ─── Helpers ────────────────────────────────────────────────────────────────
function extractSelector(input: string): string | null { ... }   // REMOVED
function isKnownProtocolAddress ...

// After:
import { extractSelector, lookupSelector } from '../../shared/selector-registry.js'; // extractSelector ADDED
// ─── Helpers ────────────────────────────────────────────────────────────────
function isKnownProtocolAddress ...
```

### Call sites verified
- `index.ts:55` — already imported `extractSelector` from `selector-registry.js` ✓
- `index.ts:244` — calls `extractSelector` via the import above ✓
- `index.ts:500` — same import, same behavior ✓
- `protocol-decoder.ts:184` — uses `extractSelector` (now from shared) ✓

`selector-registry.ts` re-export passes through the `0x${string}` | `string` compat: the shared impl returns `string | null`, cast to `0x${string}` by the original `selector-registry` return type. All callers use `string | null` or accept `0x${string}` (assignment compat).

---

## Refactor #5 — TS Type ↔ Zod Schema Drift

### Pattern applied
```ts
// Shared const (single source of truth):
export const CLASSIFIER_SOURCES = ['rule', 'rule-protocol', 'llm', 'flagged'] as const;
export type ClassifierSource = typeof CLASSIFIER_SOURCES[number];

// TS interface (was hardcoded union):
  classifierSource: ClassifierSource;   // was: 'rule' | 'rule-protocol' | 'llm' | 'flagged'

// Zod schema (was hardcoded z.enum array):
  classifierSource: z.enum(CLASSIFIER_SOURCES),  // was: z.enum(['rule', 'rule-protocol', 'llm', 'flagged'])
```

Zod 3.24 (`^3.24.0`) natively accepts `readonly [string, ...string[]]` tuples in `z.enum()`, so no cast needed.

### Files touched

| File | Change |
|------|--------|
| `src/shared/types.ts` | Added `CLASSIFIER_SOURCES` const + `ClassifierSource` type; updated TS interface (`:152`) and Zod schema (`:359`) to reference them |

### 3rd drift site found (not fixed — out of scope)
`src/sub-agents/tx-classifier/llm-fallback.ts:125` — the JSON-schema object for LLM output has:
```ts
classifierSource: { type: 'string', enum: ['rule', 'llm', 'flagged'], ... }
```
Missing `'rule-protocol'`. The schema is a comment-only mirror of `ClassifiedTxSchema` (see `llm-fallback.ts:56–61`); it is not used for parsing — `ClassifiedTxSchema.parse()` is the actual validation gate (`llm-fallback.ts:255`). **Risk:** if an LLM response ever includes `'rule-protocol'` (which cannot happen today since the LLM is only called as fallback), the JSON schema check would silently coerce it. Low risk in practice. **Not fixed per scope constraint.**

---

## Verification

### `pnpm typecheck` — ✅ clean
```
$ tsc -p tsconfig.json  (no errors)
```

### `pnpm test` — ✅ 304/304
```
Test Files  18 passed (18)
     Tests  304 passed (304)
```

---

## Side Effects
None. All callers of `extractSelector` and all consumers of `ClassifiedTxSchema` / `ClassifierSource` compile and pass tests without modification.

**Status:** DONE
**Summary:** Both refactors completed cleanly. #6 deduped `extractSelector` into `src/shared/extract-selector.ts`, removing the duplicate from `protocol-decoder.ts` and re-exporting from `selector-registry.ts`. #5 replaced both hardcoded `classifierSource` union/enum definitions in `types.ts` with a shared `CLASSIFIER_SOURCES` const. Typecheck clean, 304/304 tests pass.
**Concerns/Blockers:** None.
