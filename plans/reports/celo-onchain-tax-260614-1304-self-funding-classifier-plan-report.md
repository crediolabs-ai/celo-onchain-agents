# Agent 06 — Self-funding for yield classifier — plan read-out

- **Run timestamp:** 2026-06-14 13:04 UTC
- **Agent:** celo-onchain-tax (session e18a0c8a-e504-4e0f-9ecf-2d6f29796e39, read-only)
- **Trigger:** sếp Quân's feedback "the income should be $374 (5374-5000)"; corrected to 5,000 capital funding + 5,374.90 yield return = 374.90 net income
- **Decision:** option B (heuristic self-funding detector) + keep CoinGecko prices

## What sếp confirmed

The 0xBE19 wallet's 2024 sequence is **capital funding → yield deposit →
yield return → vault re-invest**, not employer income → yield return. The
5,000 USDC IN on 2024-05-13 is the investor's own money flowing in to fund
a yield position, not compensation. The engine currently mis-classifies it
as INCOME via `income.stablecoin_in_no_native_out@v1` (the address-book
"employer match" lifts confidence 0.75 → 0.95).

## What the fix does

Add a new classifier rule (`transfer.self_funding_for_yield@v1`) that runs
**before** the income rule. It pre-computes a set of "self-funding" tx
hashes: a USDC IN gets tagged if a subsequent USDC OUT to a known
yield-protocol address (currently `0x5b7ba647…` = Karmen Mezz Pool)
happens within a 10-block window (~50s on Celo). The IN is then classified
as `TRANSFER_IN` (cost-basis funding), not `INCOME`.

The yield round-trip math in `pnl-calculator/index.ts:266-307` stays
unchanged. After the fix, the 5,000 USDC IN becomes a cost-basis lot
consumed by the 5,000 USDC OUT (zero gain), the 5,374.90 USDC YIELD-IN
stays in Yield, and the round-trip adjustment nets the gross IN vs the
earliest prior OUT → Interest earned = $366.61, Yield = $0, Income = $0,
Taxable = $366.61.

## Scouted code (read-only)

| File | Lines | What |
|---|---:|---|
| `src/sub-agents/tx-classifier/rules.ts` | 56-83 | `income.stablecoin_in_no_native_out@v1` — the rule we'll precede |
| `src/sub-agents/tx-classifier/rules.ts` | 35-52 | `yield.known_protocol_in@v1` — the rule that handles Dec 14 return |
| `src/sub-agents/tx-classifier/predicates.ts` | 33-46 | `PredicateContext` interface — add `selfFundingForYieldSet` |
| `src/sub-agents/tx-classifier/predicates.ts` | 50-89 | `Predicate` union — add `isInSelfFundingForYieldSet` |
| `src/sub-agents/tx-classifier/index.ts` | 140-180 | `classifyWithDeps` main loop — pre-pass location |
| `src/shared/protocol-registry.ts` | 38-48 | `ProtocolEntry` — model for the new yield-protocol registry |
| `tests/integration/vault-deposit.test.ts` | 1-50 | existing 0xBE19 fixture — extend with self-funding case |

The yield-protocol address `0x5b7ba647…` is currently hardcoded in
`rules.ts:41` (the `fromAddress` predicate). The fix extracts it into a
`YIELD_PROTOCOL_ADDRESSES` set in `src/shared/yield-protocols.ts` (new
file, ~15 lines) and references it from both the new rule and the
existing `yield.known_protocol_in@v1` rule.

## Expected post-fix output (0xBE19 KE 2024)

| Line | Pre-fix (current) | Post-fix (predicted) |
|---|---:|---:|
| Realized gains | $0.00 | $0.00 |
| Income | **$4,997.26** | **$0.00** |
| Yield | $0.00 | $0.00 |
| Interest earned | $366.61 | $366.61 |
| Taxable income | **$5,363.87** | **$366.61** |

The $366.61 is the engine's net round-trip gain (5,371.61 IN − 5,005.00
OUT, with CoinGecko USDC spot prices). Sếp understands the ~$8 gap vs his
$378 expectation is price rounding, not a math bug. Per sếp's instruction,
CoinGecko prices stay as source of truth.

## What I need from sếp

1. **Approve the plan** at `plans/260614-1304-self-funding-for-yield-classifier-fix/plan.md`
2. **Confirm 4 open questions** at the bottom of the plan (block window,
   confidence, stablecoin set, address-book scope)
3. **Pick the implementation agent** — Tuan (tx-classifier owner),
   fullstack-developer, or default. Once you pick, I'll hand off the
   file-edit work to that agent and re-verify afterward.

This celo-onchain-tax agent stays read-only and continues to handle
report runs / verification after the fix lands.

## Status

**Status:** DONE_WITH_CONCERNS
**Summary:** Plan drafted, code locations scouted (read-only), open questions
listed. Awaiting sếp's go-ahead on the 4 design choices and the
implementation-agent pick before any source files are touched. Expected
post-fix: KE 2024 0xBE19 taxable income drops from $5,363.87 to $366.61
(no more double-count of the 5,000 USDC funding + yield gain).
