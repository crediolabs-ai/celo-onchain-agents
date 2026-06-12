@Credio — tx-classifier port done. Ready for your review.

**Files (all under `src/sub-agents/tx-classifier/`):**
- `predicates.ts` (210 lines) — DSL + Rule type + engine
- `rules.ts` (206 lines) — 13 rules, IDs follow `category.pattern@vN` convention
- `llm-fallback.ts` (335 lines) — tool_use pattern (SDK 0.40.1), opus-4-6, post-parse validation
- `index.ts` (237 lines) — orchestration, LLM cap (50), minRuleConfidence threshold (0.7)
- `CONTRACT-RESEARCH-NOTES.md` — what I tried, what's still missing, recommended next step
- `tests/unit/tx-classifier.test.ts` (520 lines, 28 tests, all green)

**Tests:** `pnpm test` → 48/48 pass (28 new + 20 pre-existing). `pnpm typecheck` clean.

**Three small amendments to surface:**

1. **SDK 0.40.1 doesn't have `thinking.type: 'adaptive'`** on its union — I disabled it for now with a TSDoc note to re-enable on `^0.50.0`. (Matches your earlier note: "bump to `^0.50.0` in the next sync".)

2. **Added `.transform()` to `TxHashSchema` / `HexAddressSchema`** in `src/shared/types.ts` to preserve the `0x${string}` literal through Zod's regex — `ClassifiedTxSchema.parse(...)` would otherwise widen back to `string`, breaking `exactOptionalPropertyTypes: true`. Non-breaking, same runtime behaviour, narrower inferred type.

3. **Rule source marking:** if a rule's `confidence < minRuleConfidence` (default 0.7), I mark `classifierSource: 'flagged'` and add the tx to `flaggedForReview` — so a low-confidence rule hit shows up in the audit trail honestly rather than as a confident 'rule'. Let me know if you'd rather have it stay 'rule' with just a lower confidence value.

**Open question for you:** when the LLM succeeds with `confidence: 0.65` (between 0.5 and 0.7), do you want the same flagging treatment as low-confidence rules, or treat the LLM as the "second opinion" and accept it? I went with "flag it" for now — easy to flip.

**Blockers still on the table:**
- Wallet `0x0F5d112fBE6320E2C249326C62a69d87aF436CAb` needs ~0.5 CELO for the Track 2 on-chain log tx. Quan pinged.
- 4 rules are silent no-ops until contract addresses land (Discord / Celoscan API per the research notes).

Ping me when you've reviewed. I'll stand by for the query-interface port or any fix-ups here. — Tuan
