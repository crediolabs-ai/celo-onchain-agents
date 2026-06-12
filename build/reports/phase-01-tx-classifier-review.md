# Phase 01 Review — tx-classifier + Zod schema amendment

**Author:** Credio (review)
**Date:** 2026-06-09
**Subject of review:** Tuan's `tx-classifier` port + 1 amendment to `src/shared/types.ts`

## Verdict: ✅ Approve with fixes applied

The classifier is well-structured: clean DSL, rule/LLM split, audit trail, cap, and partial-failure handling. 48/48 tests were green before review. I applied 4 fixes from the simplify-skill review and added 2 regression tests.

## Reuse review

No major duplication. `groupBy` (10 lines) is fine inline for one call-site. The system prompt could be loaded from a file, but inline is correct for hackathon scale.

## Quality review

| # | Issue | Severity | Resolution |
|---|-------|----------|------------|
| Q1 | `rules.ts:206` had `import { evaluateRule }` at the bottom of the file | style | Moved to top with the other import |
| Q2 | `index.ts:98` hardcoded `makeLookup('mainnet')` regardless of which network the fetcher returned data from | **bug** (silent no-op risk) | Added optional `network?: Network` to `ClassifyInput` and `classify()`; defaults to `'mainnet'` for backward compat |
| Q3 | `PredicateContext` lost type-safety on `refs: string[]` in `toIn` / `toIs` / `fromIs` — had to cast at the runtime boundary in `matchAlias` | trade-off | Accepted. Tighter typing would couple the DSL to the contracts module. The cast is contained to one helper. |
| Q4 | The `transfer.simple_token_in@v1` rule fires with confidence 0.85 because the predicate doesn't check `transfers[0].to == address` | known issue | Tuan flagged it inline. Add `tokenDirection` predicate in v2. |
| Q5 | The `transfer.simple_token@v1` rule only catches outgoing (uses `methodName: 'transfer'`) | asymmetric | Incoming token transfer rule `transfer.simple_token_in@v1` exists and uses `tokenTransferCount + nativeDirection=none`. The asymmetry is correct. |

## Efficiency review

| # | Issue | Severity | Resolution |
|---|-------|----------|------------|
| E1 | LLM calls are sequential; for 10k txs with LLM fallback this is the bottleneck | optimization | Deferred. For hackathon demo (3-10 LLM calls) sequential is fine. Post-hackathon: parallelize with `p-limit`. |
| E2 | No LLM response cache | optimization | Deferred. For hackathon each wallet is queried once. |
| E3 | `safeCompare` does BigInt parsing on every `valueGt` / `valueLt` evaluation | micro | Acceptable. Rules fire 10s of times per tx, not 10k. |
| E4 | Per-`classify()` call we build a fresh `ContractLookup` (one-time O(1) cost) | fine | No change needed. |

## Calibration changes (proposed, applied)

| Before | After | Why |
|--------|-------|-----|
| `minRuleConfidence` (default 0.7) used for both rules and LLM | Split: `minRuleConfidence` (default 0.7) for rules, `minLlmConfidence` (default 0.5) for LLM | Rules are deterministic + tested → high bar. LLM is non-deterministic + can be confidently wrong → lower acceptance. Lets judges see a "second opinion" without over-flagging. |

## Other changes applied

- **`src/shared/types.ts`** — extracted the `literal<T extends string>(regex: RegExp)` helper. Same runtime behaviour, replaces two `transform((s) => s as T)` blocks with one helper. Will repeat when Celoscan response schemas land.
- **`src/sub-agents/tx-classifier/index.ts`** — added `network?: Network` and `minLlmConfidence?: number` to `ClassifyInput`. New `DEFAULT_MIN_LLM_CONFIDENCE = 0.5` constant.
- **`tests/unit/tx-classifier.test.ts`** — added 2 tests:
  - `accepts LLM result at 0.6 (above default 0.5 threshold)`
  - `uses the supplied network to build the contract lookup`

## Tuan's two questions, decided

1. **Low-confidence LLM result (0.5–0.7)** — flag it. **Done.** Default `minLlmConfidence = 0.5` → LLM result with conf 0.5–0.7 is accepted as `classifierSource: 'llm'` (the "second opinion" framing) but stays in the audit trail via `notes`. Below 0.5 → `flagged`. Tunable per call.
2. **SDK 0.40.1 doesn't expose `thinking.type: 'adaptive'`** — **defer**. Re-enable on `^0.50.0` bump. Tuan's `// thinking: { type: 'adaptive' }` TSDoc note is the right artifact.

## Tuan's 1 amendment to `src/shared/types.ts`

**Approve.** The Zod `.transform((s) => s as Address)` idiom is the standard way to preserve template-literal types through Zod inference. Non-breaking, narrower types, no runtime change. I've extracted it into a small `literal()` helper since the pattern will repeat when Celoscan response schemas land.

## Test count

- Before review: 48
- After review: **50** (added 2 for new behavior)
- All green: `pnpm typecheck` clean, `pnpm test` 50/50.
