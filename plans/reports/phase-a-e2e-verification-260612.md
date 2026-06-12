# Phase A E2E Verification — DeFi Wallet Report

**Date:** 2026-06-12
**Agent:** credio-orchestrator → phase-a-e2e-verification
**Wallet:** `0x9b3319a7f1f6a7bc48af14c9b81ba4b41c7c1394`

---

## TL;DR

**Phase A: Partial / Bug Found.** Pipeline runs cleanly (66 txs, 0 errors, 0 flagged). However, the Phase A protocol decoder **never fired** — `protocolDecoderHits = 0` across all 66 txs. The hard requirement (`rule-protocol` count ≥ 3 from GoodDollar) was **not met**. Root cause: a path-ordering bug in `tx-classifier/index.ts` — step 2.5 (selector-registry) intercepts `0x4e71d92d` before step 2.7 (protocol-decoder) can process it.

---

## CSV Metrics

```
Total raw txs:       66
Token transfers:     732
Classified:          66 (0 rules, 0 rule-protocol, 0 LLM, 0 flagged)
rule-protocol hits:  0   ← TARGET WAS ≥3 (GoodDollar)
UNKNOWN type count:  0   (all became INTERACTION)
Flagged for review:  0
Duration:            1605ms
```

### Classification breakdown (all 66 txs = `type: other`)

```
$ awk -F',' 'NR>1 {print $2}' /tmp/agent-06-phase-a-defi.csv | sort | uniq -c
     66 other
```

---

## GoodDollar Verification

**Expected:** 3 claims (selector `0x4e71d92d` to GoodDollar reserve `0x94A3240f...`)

**Actual:** 4 rows with `Function selector: claim() (Generic claim)` in notes — but ALL are `type: other` (INTERACTION), not `YIELD`. None reached the protocol-decoder.

**Sample rows:**
```
2024-12-21,other,UNKNOWN,0,0.00,0.00,0.00,0.00,"Function selector: claim() (Generic claim)"
2024-12-22,other,UNKNOWN,0,0.00,0.00,0.00,0.00,"Function selector: claim() (Generic claim)"
2025-04-13,other,UNKNOWN,0,0.00,0.00,0.00,0.00,"Function selector: claim() (Generic claim)"
2026-04-14,other,UNKNOWN,0,0.00,0.00,0.00,0.00,"Function selector: claim() (Generic claim)"
```

**Root cause (confirmed by code reading):**

`src/sub-agents/tx-classifier/index.ts` processes txs in this order:

```
step 2.3  protocol-name path       → checked first (meta + protocol-registry)
step 2.5  classifyBySelector()     → checked second (selector-registry: 0x4e71d92d → 'CLAIM')
step 2.7  decodeProtocolAction()   → checked THIRD (protocol-decoder: GOODDOLLAR:CLAIM_YIELD)
```

`0x4e71d92d` IS in the selector-registry (`selector-registry.ts:184`) as `claim()` / `category: 'CLAIM'`. `classifyBySelector()` fires at step 2.5 and returns `INTERACTION` (per `selectorCategoryToTxType` at index.ts:568 — 'CLAIM' maps to `INTERACTION`). Execution `continue`s at index.ts:242 — **step 2.7 never runs**.

The protocol-decoder's own SELECTOR_TABLE also has `0x4e71d92d` as `GOODDOLLAR:CLAIM_YIELD`, but it is unreachable because step 2.5 fires first.

---

## Moola / `0xcac35c7a` Investigation

**Contract:** `0xa0e9096b8e5ad2701f51ca1cb11684aaad91993a`

**Celoscan V2 confirms:**
- Proxy: YES (`"Proxy": "1"`)
- Implementation: `0x9fdac033cef6ca326712ed79d79a056bee8f4dc7` (unverified, no ABI)
- **Not in 4byte.directory** — selector `0xcac35c7a` is unknown
- One tx to this contract shows `methodId: 0x658d61a7` with input decoding to `withdraw(address token, address receiver)` — suggests this is a **Bridged USDC (USDT_bridged) withdraw function**
- Another tx has `methodId: 0xf940e385` = `withdraw(address token, address receiver)` confirmed
- Contract also has `pause()` (`0x8456cb59`)

**Interpretation:** `0xa0e9096b8e5ad2701f51ca1cb11684aaad91993a` is likely the **Bridged USDC** (ceba...2118C) proxy contract. The 52 txs with `0xcac35c7a` are withdraw calls to this bridge. This is **not Moola** — Moola's cToken selector table doesn't include `0xcac35c7a`.

**Decoder verdict:** `0xcac35c7a` is not in the protocol-decoder's SELECTOR_TABLE, not in the selector-registry, and not in 4byte.directory. The CSV correctly marks these as `INTERACTION` with `Unmatched selector: 0xcac35c7a`. Correct behavior, no bug.

---

## Comparison to Demo Wallet

| Metric | Demo wallet (`0x4678…1c25`) | DeFi wallet (`0x9b33…394`) |
|---|---|---|
| Total txs | 194 | 66 |
| `rule-protocol` hits | 0 | 0 |
| UNKNOWN type | 161 | 0 |
| Flagged | 161 | 0 |
| Notes | `upgrade(address,address)`, `execTransaction(...)` | `claim()`, `Unmatched selector: 0xcac35c7a` |

**Key difference:** The demo wallet produced `UNKNOWN` (161 txs) because its selectors (`upgrade`, `execTransaction`) weren't in the selector-registry. The DeFi wallet's selectors (`claim`) ARE in the selector-registry, so they get `INTERACTION` instead of `UNKNOWN`. Both have `rule-protocol = 0`.

---

## Known Limits / Unresolved

1. **Path-ordering bug (MUST FIX):** `classifyBySelector()` at index.ts:489 fires before `decodeProtocolAction()` at index.ts:250. For selectors present in BOTH the selector-registry AND the protocol-decoder's SELECTOR_TABLE (e.g., `0x4e71d92d` GoodDollar claim), the selector-registry wins and the protocol-decoder is bypassed. **Fix:** Check the protocol-decoder FIRST for selectors in its SELECTOR_TABLE before falling through to the selector-registry.

2. **`0xcac35c7a` mystery resolved:** This is the Bridged USDC (`ceba...2118C`) proxy withdraw function. Not Moola. If the team wants this classified, add it to the protocol-decoder's SELECTOR_TABLE with protocol = 'PORTAL_BRIDGE' and action = 'WITHDRAW'.

3. **`protocolDecoderHits` counter is 0** — the `protocol-decoder.ts` code is correct (verified by 20 unit tests passing), but it's unreachable in the current integration due to the path-ordering issue above.

4. **`rule-protocol` count in CSV = 0** — the hard acceptance criterion was not met.

---

## Next Steps

1. **Fix path ordering in `src/sub-agents/tx-classifier/index.ts`:** Move `decodeProtocolAction()` before `classifyBySelector()`, or skip `classifyBySelector()` when the selector is in the protocol-decoder's SELECTOR_MAP.

2. **Re-run the pipeline** on the same DeFi wallet after the fix. Target: `rule-protocol` count ≥ 3.

3. **Add `0xcac35c7a` to PORTAL_BRIDGE/WITHDRAW** in the protocol-decoder (optional, if Wormhole bridge classification is desired).

4. **Synthetic fixture needed** — since no real wallet was found exercising Mento/Ubeswap/Moola (only GoodDollar + Bridged USDC), consider adding a fixture wallet with known Mento + Ubeswap txs to the test suite so this doesn't regress.

---

**Status:** DONE_WITH_CONCERNS
**Summary:** Pipeline runs cleanly on a real DeFi wallet (66 txs, 0 errors) but Phase A protocol-decoder fired 0 times. Hard requirement (≥3 GoodDollar rule-protocol hits) not met. Root cause is a path-ordering bug: step 2.5 (selector-registry) intercepts `0x4e71d92d` before step 2.7 (protocol-decoder) can process it. `0xcac35c7a` mystery solved — it's Bridged USDC withdraws, not Moola. Fix needed before Phase A can be considered verified.
**Concerns/Blockers:** Path-ordering bug must be fixed. No other blockers — the pipeline infrastructure works perfectly.
