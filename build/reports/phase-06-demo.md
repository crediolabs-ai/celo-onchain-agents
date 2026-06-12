# Phase 06 — Demo CLI

**Sub-agent:** 6/6 (the demo + writeup wrap-up)
**Owner:** Tuan
**Status:** ✅ completed
**Date:** 2026-06-09

## Scope

`src/cli/demo.ts` exercises the 3 shipped sub-agents (tx-classifier, pnl-calculator, nl-query) end-to-end against the wallet fixture, no network or API keys required. Single-file CLI built on `commander` (already a dep). Markdown output to stdout.

This is the user-facing entrypoint for the Agent 06 submission — runs in <100 ms, demonstrates the full intent-to-answer loop.

## Three modes

```
pnpm demo --mode=rules                      # show tx-classifier output
pnpm demo --mode=pnl                        # show pnl-calculator output
pnpm demo --mode=ask --question="..."       # show nl-query answer
pnpm demo --mode=all --question="..."       # run all three in sequence
```

Default mode is `all`. Default question is `"What was my 2024 taxable income?"`.

Additional flags: `--jurisdiction` (NG/KE/OTHER), `--method` (FIFO/LIFO/WAC), `--year`, `--real-llm` (use real Anthropic client if `ANTHROPIC_API_KEY` is set).

## Architecture

The demo uses `runPipeline` directly with `makeFixtureDeps` (from Credio's orchestrator) so the demo and orchestrator test suite share 100% of the orchestration code. The only customisation: for `ask` mode, build a `PipelineDeps` that uses the real `answerQueryWithDeps` (production NL-query path) but with a deterministic stub LLM client.

### Stub LLM

The stub mirrors the test seam in `tests/unit/nl-query.test.ts`:
- `messages.create(params)` returns a `Message` with a single `tool_use` block
- The `tool_use.input` is a `QueryIntent` picked deterministically from the question via a small keyword → intent regex map
- Mirrors the `SYSTEM_PROMPT` intent disambiguation in `llm-translator.ts` so the demo's intent matches what the real LLM would pick for common questions

Real LLM path: `--real-llm` flag swaps the stub for `new Anthropic()`. Same `PipelineDeps` wiring, different `llm` dep. The orchestrator and the demo share the production `answerQueryWithDeps` function either way.

### Why direct `runPipeline` instead of `runDemoWithFixtures`

`runDemoWithFixtures` (Credio's seam) uses `makeFixtureDeps` internally, which stubs `answerQuery` to a "[fixture-mode] Stub answer for: ..." string. That stub is useful for the orchestrator tests but not for the demo, which needs to actually exercise the NL-query intent dispatch. So the demo builds its own `PipelineDeps`:
- `fetchTxs`, `classify`, `computePnl`, `exportCsv` → from `makeFixtureDeps` (no LLM, no network)
- `answerQuery` → from `answerQueryWithDeps` with a stub or real LLM client

## Files

| File | LOC | Purpose |
|---|---:|---|
| `src/cli/demo.ts` | ~440 | CLI entrypoint, 3 modes, markdown formatters, stub LLM |
| `package.json` | +1 line | Added `"demo": "tsx src/cli/demo.ts"` script |

## Tested intent coverage

Verified end-to-end against the fixture with these questions (default stub LLM):

| Question | Picked intent | Answer |
|---|---|---|
| `"What was my 2024 taxable income?"` | `year_summary` (2024) | "For 2024: taxable income $0.65 (realized gains $0.05, income $0.60, yield $1.00, deductible gas $0.00)." |
| `"How much did I make on CELO?"` | `asset_pnl` (CELO, realized) | "CELO realized PNL: $0.05." |
| `"How many SWAPs did I do?"` | `tx_type_breakdown` (SWAP, count) | "1 SWAP transaction(s)." |
| `"What are my top 3 assets by PNL?"` | `top_assets` (3, realizedPnl) | "Top 1 assets by realizedPnl: 1. CELO: $0.05" |
| `"Show me my flagged transactions"` | `list_transactions` (source=flagged) | "1 transaction(s) (classifier=flagged). First 1: 0xee000000… BRIDGE @2024-12-07" |
| `"Is LIFO legal in Nigeria?"` | `jurisdiction_compat` (LIFO, NG) | "No compat entry for LIFO in NG." (correct — fixture only has FIFO entries) |
| `"What is the meaning of life?"` | `unknown` | "I couldn't map that question to a supported query." |

All 8 intent arms are reachable from the stub. The full demo (`--mode=all`) prints ~100 lines of markdown in <10 ms.

## Status

- ✅ `pnpm typecheck` — clean
- ✅ `pnpm test` — 132/132 pass (no test changes; demo is a script, not a module under test)
- ✅ `pnpm lint` — clean for `src/cli/demo.ts` (1 pre-existing error in `coingecko.ts` is Credio's)
- ✅ `pnpm format:check` — clean for `src/cli/demo.ts`
- ✅ `pnpm demo --mode=rules` / `--mode=pnl` / `--mode=ask` / `--mode=all` — all run end-to-end

## Coordination with Credio

- **File ownership respected:** only `src/cli/demo.ts` and `package.json` modified.
- **Imports from orchestrator:** `runPipeline`, `makeFixtureDeps`, `PipelineDeps`, plus the shared types. No edits to `src/orchestrator/*`.
- **Imports from nl-query:** `answerQueryWithDeps`, `AnswerQueryDeps`. The demo uses the same public surface the production wiring uses.
- **Imports from fixture:** `walletFixture` from `tests/fixtures/wallet-fixture.ts`. Tied to the fixture Credio shipped; if the fixture changes, the demo still works (markdown adapts).
- **No new dependencies:** `commander` was already in `package.json`.

## Open items / follow-ups

- **Writeup:** This is the demo half. The full writeup (hackathon submission narrative) is the next deliverable — Credio has the orchestrator section; Tuan will draft the cross-agent integration story + the demo walkthrough.
- **Network call:** `fetchTxs`, `exportCsv`, `emitOnchainLog` are still pending Credio pending the pilot's network decision (Celo Sepolia swap). The demo runs today against the fixture; the production wiring will slot in piecewise as each lands.
- **Stub LLM evolution:** The current regex-based dispatch is a stopgap. Once a real Anthropic key is available, the demo defaults to the real LLM by changing one constant. The stub is preserved for offline demos and CI runs.

— Tuan
