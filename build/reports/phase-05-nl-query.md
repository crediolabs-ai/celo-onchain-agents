# Phase 05 — NL Query Interface

**Sub-agent:** 5/5 (the last piece of the pipeline)
**Owner:** Tuan
**Status:** ✅ completed
**Date:** 2026-06-09

## Scope

The natural-language query interface is the user-facing Q&A layer of Agent 06. It accepts free-form questions ("What's my 2024 income?") and returns a structured answer with cited transactions, supported by the classified-transaction and PNL outputs from upstream sub-agents.

This is the last of the 5 sub-agents, so completing it unblocks the orchestrator integration step.

## Architecture

**Single-LLM-call, deterministic-execution hybrid.** The LLM's job is restricted to NL → structured intent translation; all data access and answer formatting are deterministic code.

```
Question → LLM (emit_intent tool_use) → QueryIntent (Zod-validated)
       → executeQuery(intent, classified, pnl) → QueryOutput { answer, supportingNumbers, citedTxHashes }
```

Key properties:

1. **Safety boundary.** The LLM never produces code or free-form query strings — it picks from an 8-intent enum. Prompt-injection in the user's question cannot steer computation beyond the structured menu.
2. **No LLM in the final answer.** The deterministic formatter produces the user-visible `answer` string. This eliminates hallucination in the output and makes the answer auditable.
3. **Testable.** All 8 intent handlers are pure functions; the LLM is stubbed in unit tests via the same `Pick<Anthropic, 'messages'>` seam as `tx-classifier/llm-fallback.ts`.

## Intent vocabulary (8 arms)

| Intent | Purpose | Example question |
|---|---|---|
| `year_summary` | Per-year totals | "What was my 2024 taxable income?" |
| `tx_type_breakdown` | Sum/count/list of one tx type | "Total SWAPs in 2024" / "List my INCOME transactions" |
| `asset_pnl` | Per-asset PNL metric | "How much did I make on CELO?" |
| `jurisdiction_compat` | (method, jurisdiction) legality | "Is LIFO allowed in Nigeria?" |
| `top_assets` | Top-N by metric | "My top 3 income sources" |
| `list_transactions` | Filtered transaction list | "Show me my flagged transactions" |
| `price_gaps` | Missing-price audit | "Did I have price gaps in 2024?" |
| `unknown` | Fallback | Off-topic / ambiguous / chitchat |

Each arm is a Zod-discriminated union (`.strict()` so unknown fields are rejected at parse time). The LLM's tool definition mirrors the schema, then `QueryIntentSchema.parse()` re-validates the response as the actual safety net.

## Files

| File | LOC | Purpose |
|---|---:|---|
| `src/sub-agents/nl-query/intents.ts` | 116 | Zod schemas for the 8-intent vocabulary, plus typed constants |
| `src/sub-agents/nl-query/execute.ts` | 287 | 8 deterministic handlers, dispatched by `intent.kind` |
| `src/sub-agents/nl-query/llm-translator.ts` | 248 | LLM call (Anthropic SDK 0.40.1, `tool_use` pattern) |
| `src/sub-agents/nl-query/index.ts` | 65 | Orchestration: `answerQuery` (env-driven) + `answerQueryWithDeps` (testable) |
| `tests/unit/nl-query.test.ts` | 374 | 39 tests covering schema, handlers, translator, and end-to-end |

## Test results

```
✓ tests/unit/nl-query.test.ts (39 tests) 26ms
Test Files  7 passed (7)
     Tests  115 passed (115)
```

- **9 tests** for `QueryIntentSchema` (all 8 valid arms, invalid kind, missing required field, out-of-range taxYear, invalid type enum, empty asset, out-of-range n/limit, unknown-field rejection via `.strict()`)
- **22 tests** for `executeQuery` handlers (one block per intent, multiple cases per intent including edge cases — missing year, asset uppercasing, n=1, limit, year filter, source filter, etc.)
- **4 tests** for `llmTranslateQuestion` (valid parse, malformed input rejected, missing tool_use block, abort signal)
- **5 tests** for `answerQueryWithDeps` end-to-end (year_summary, list_transactions, LLM unreachable, malformed intent, unknown intent)

Plus 76 existing tests across the other sub-agents continue to pass.

## Notable design decisions

1. **Single LLM call, not two.** I considered NL → intent → execute → LLM-synthesized-answer, but skipped the synthesis step. Pros: auditable, fast, no hallucination. Cons: answers are templated, less natural-sounding. For a hackathon, determinism wins.

2. **`.strict()` on every Zod arm.** Zod 3's default is "strip" — unknown fields silently dropped. With `.strict()`, an LLM-injected `{ evil: 'delete wallet' }` is rejected at parse time. Defense-in-depth on top of the discriminated-union discrimination.

3. **Per-asset income / yield as approximation.** `PnlOutput.realizedPnlByAsset` exists but per-asset `incomeByAsset` / `yieldByAsset` do not. The `asset_pnl` intent with `metric='income'` or `metric='yield'` falls back to realized PNL with an explicit note. A future PNL enhancement should add these.

4. **SDK 0.40.1 compatibility.** Mirrors the pattern established in `tx-classifier/llm-fallback.ts`:
   - Hand-rolled JSON schema for the tool (no Zod `toJSONSchema` — not in 3.25.x)
   - `tool_choice: { type: 'tool', name: ... }` to force structured output
   - `thinking` field omitted (TS union doesn't include `'adaptive'` until SDK 0.50+)
   - TSDoc note left to re-enable both on SDK bump

5. **Graceful LLM degradation.** `answerQueryWithDeps` catches LLM failures and returns a transparent "could not reach the language model" answer with empty `supportingNumbers`. The orchestrator can surface the original error separately; the user gets a useful fallback.

6. **Per-asset income approximation in `top_assets`.** The LLM's `top_assets` intent supports `by: 'income' | 'yield' | 'realizedPnl'`, but only `realizedPnl` has per-asset data. Both `income` and `yield` use `realizedPnlByAsset` as a proxy. Same future-PNL-enhancement note applies.

## Open questions / follow-ups

- **PNL enhancement:** per-asset `incomeByAsset` and `yieldByAsset` would let `asset_pnl` with `metric='income' | 'yield'` and `top_assets` with `by='income' | 'yield'` return true per-asset values. Tracked for the next PNL pass.
- **NL coverage:** The 8-intent vocabulary covers the realistic user questions. New intents are easy to add (one Zod arm, one tool property, one handler, one test block). Voice / multi-turn not in scope for hackathon.
- **No streaming.** Answers are short; full-message response is fine. If we ever need streaming for the answer text, the LLM call would need to switch to `.stream()` + `.finalMessage()`.

## Coordination with other sub-agents

- **No imports from other sub-agents** — follows the established pattern (each sub-agent imports only from `src/shared/`). The orchestrator will import from `nl-query/index.ts` to wire up the pipeline.
- **Compatible with `tx-classifier` output** — consumes the same `ClassifiedTx[]` shape.
- **Compatible with `pnl-calculator` output** — consumes the same `PnlOutput` shape.
- **Piggybacks on `tx-classifier/llm-fallback.ts` patterns** — the LLM client seam, error mapping, and tool_use pattern are identical. If we ever bump SDK 0.40.1 → 0.50+, both files get the same `parse()` + `adaptive` thinking upgrade.

## Integration

The orchestrator can wire this up with:

```typescript
import { answerQuery } from './sub-agents/nl-query/index.js';
// ... in the pipeline ...
const queryAnswer = await answerQuery({
  question: pipelineRequest.nlQuery!,
  classified: classified.classified,
  pnl,
  jurisdiction: pipelineRequest.jurisdiction,
});
```

`answerQuery` reads `ANTHROPIC_API_KEY` from env. Tests use `answerQueryWithDeps` with a stub client.

— Tuan
