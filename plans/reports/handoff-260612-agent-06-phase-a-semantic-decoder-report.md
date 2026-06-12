# Phase A Implementation Report — Agent 06 Semantic Decoder

## Status: DONE_WITH_CONCERNS

**Summary:** Shipped `protocol-decoder.ts` + `protocol-actions.ts` + 20 unit tests. Classifier integration in `index.ts` adds a `rule-protocol` path between the selector-registry step and LLM fallback. UNKNOWN reduction cannot be measured — `pnpm dev` requires `AGENT_WALLET_PRIVATE_KEY` which is not set in this environment.

---

## Files Created

| File | Lines | Purpose |
|------|-------|---------|
| `src/sub-agents/tx-classifier/protocol-decoder.ts` | ~215 | Semantic decoder (Mento/Ubeswap/Moola/GoodDollar) |
| `src/sub-agents/tx-classifier/protocol-actions.ts` | ~72 | `ProtocolName`, `ProtocolActionType`, `protocolActionToTxType()` |
| `tests/unit/protocol-decoder.test.ts` | ~275 | 20 unit tests covering all paths |

## Files Modified

| File | Change | Lines |
|------|--------|-------|
| `src/sub-agents/tx-classifier/index.ts` | Added `rule-protocol` step after selector path; added `protocolDecoderHits` counter | +22 |
| `src/shared/types.ts` | Added `protocolDecoderHits` to `ClassifyOutput`; added `rule-protocol` to `classifierSource` union | +4 |
| `tests/fixtures/wallet-fixture.ts` | Added `protocolDecoderHits: 0` to fixture | +1 |
| `tests/unit/log-emitter.test.ts` | Added `protocolDecoderHits: 0` to fixture | +1 |
| `src/sub-agents/tx-classifier/CONTRACT-RESEARCH-NOTES.md` | Appended Phase A section with Moola addresses, selector table, gaps | +60 |

## Test Results

- **Typecheck:** clean (no errors)
- **Unit tests:** 18 test files, **301 passed** (was 281 before — 20 new)
- **New tests cover:** Mento SWAP/DEPOSIT/WITHDRAW, Ubeswap SWAP, Moola DEPOSIT/WITHDRAW, confidence bands (0.9/0.7/0.5), null cases, transfer-shape heuristic

## Verification (manual, 9 cases)

```
  PASS  MENTO swapExactIn @ Broker → MENTO:SWAP → TxType:SWAP (conf:0.9)
  PASS  MENTO swapIn @ Router → MENTO:SWAP → TxType:SWAP (conf:0.9)
  PASS  MENTO deposit @ Router → MENTO:DEPOSIT → TxType:YIELD (conf:0.9)
  PASS  UBESWAP swapExactTokens → UBESWAP:SWAP → TxType:SWAP (conf:0.9)
  PASS  UBESWAP swapExactIn → UBESWAP:SWAP → TxType:SWAP (conf:0.9)
  PASS  Unknown selector → null
  PASS  Wrong addr+selector → MENTO:SWAP (conf:0.7)
  PASS  Moola cToken + transfer (DEPOSIT) → MOOLA:DEPOSIT → TxType:YIELD (conf:0.5)
  PASS  Moola cToken + transfer (WITHDRAW) → MOOLA:WITHDRAW → TxType:YIELD (conf:0.5)
9 passed, 0 failed
```

## Demo CLI Run — BLOCKED

```
ConfigError: AGENT_WALLET_PRIVATE_KEY: Required
```

The full end-to-end UNKNOWN count comparison (161 → target <80) **cannot be measured** in this environment. The `AGENT_WALLET_PRIVATE_KEY` env var is not set, and no `.env` file exists. The demo-video fixture (`demo-video/src/data.ts`) provides the baseline: **194 txs, 161 flagged (UNKNOWN)**. With 20 net-new tests passing and the decoder integration in place, the code path is verified.

**To complete verification**, run on a machine with the wallet key:
```bash
NETWORK=mainnet CELO_RPC_URL=https://forno.celo.org \
  CELOSCAN_API_URL=https://api.etherscan.io/v2/api \
  pnpm dev --address 0x46788b60daf46448668c7abaeea4ac8745451c25 \
           --jurisdiction NG --tax-year 2025 \
           --output /tmp/agent-06-phase-a.csv
grep -c ",UNKNOWN," /tmp/agent-06-phase-a.csv
```

Expected: `rule-protocol` hits printed in the markdown summary (new counter in `ClassifyOutput`).

## Protocols Covered

| Protocol | Actions | Confidence | Selector count |
|----------|---------|------------|---------------|
| MENTO | SWAP, DEPOSIT, WITHDRAW | 0.9 (selector), 0.5 (inferred) | 6 selectors |
| UBESWAP | SWAP | 0.9 (selector), 0.5 (inferred) | 8 selectors |
| MOOLA | DEPOSIT, WITHDRAW, MINT | 0.5 (inferred) | 4 selectors |
| GOODDOLLAR | CLAIM_YIELD | 0.5 (inferred) | 2 selectors |

## Classification Confidence Logic

1. **Exact selector match + known router/broker address** → `confidence: 0.9`, `classifierSource: 'rule-protocol'`
2. **Selector match + wrong address** → `confidence: 0.7`, `classifierSource: 'rule-protocol'`
3. **Transfer-shape heuristic (2+ transfers to known router)** → `confidence: 0.5`, `classifierSource: 'rule-protocol'`
4. **Below `minRuleConfidence` threshold (0.7)** → `classifierSource: 'flagged'` (still emitted as classified, not UNKNOWN)

## Gaps / Follow-ups

- **MOOLA borrow/repay** not decoded — would need `0x…` selectors from 4byte.directory; action mapping would be CLAIM_YIELD or YIELD
- **Moola cEUR address** (`0x6F673c23C7023f5E8C1f1aD1dA5C2F88e2C1b5F8`) is estimated from deployment pattern, not confirmed from tx trace
- **MENTO/UBESWAP LP operations** (addLiquidity, removeLiquidity) not decoded — would be INTERACTION
- **Demo CLI** cannot run without `AGENT_WALLET_PRIVATE_KEY` — full UNKNOWN count comparison pending

## Concerns

1. **UNKNOWN reduction unmeasured** — cannot confirm <80 target without CLI run. Recommend verifying on a keyful machine.
2. **Moola cEUR address unconfirmed** — if wrong, cEUR Moola txs will fall through to LLM or flag.
3. **`protocolDecoderHits` counter** added to `ClassifyOutput` — downstream consumers (orchestrator, PNL agent) should handle the new field (backward-compatible via Zod parsing).
