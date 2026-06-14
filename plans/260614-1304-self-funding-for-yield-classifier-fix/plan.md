# Plan — Self-funding for yield position detector (sếp Quân, 2026-06-14)

**Status:** DRAFT — awaiting sếp Quân go-ahead before code edits.
**Owner (post-approval):** Tuan (tx-classifier sub-agent) + Quan (round-trip math).
**Read-only scout:** Agent celo-onchain-tax session e18a0c8a-e504-4e0f-9ecf-2d6f29796e39 (this session, 2026-06-14 13:04 UTC).

## Problem (verified)

For wallet `0xBE19…077c` KE 2024, the engine reports $5,363.87 taxable — a
double-count. Sếp Quân's transaction sequence:

| # | Date | Event | Tax treatment (sếp) |
|---|---|---|---|
| 1 | 2024-05-13 | +5,000 USDC IN (capital funding from same investor) | **NOT income** |
| 2 | 2024-05-13 | −5,000 USDC → Karmen Mezz pool | cost basis |
| 3 | 2024-12-14 | +5,374.90 USDC IN (5,000 principal + 374.90 yield) | **Income = net 374.90** |
| 4 | 2024-12-31 | −5,374.90 USDC → USDyc vault | re-investment |

Current engine: 5,000 USDC IN is classified INCOME via
`income.stablecoin_in_no_native_out@v1` (the address-book
"employer match" lifts to 0.95). Round-trip fix correctly nets
the 5,374.90 IN vs the 5,000 OUT, but the engine also counts the
5,000 funding as income → $4,997.26 (income) + $366.61 (interest) = $5,363.87.

**Fix target:** ~$374.90 (or $366.61 with CoinGecko spot prices) in Interest
earned; Income = $0.

## Approach (sếp already chose option B; keep CoinGecko prices)

Add a "self-funding for yield position" detector to the classifier that runs
**before** the income rule. It downgrades USDC INs that the wallet immediately
routes to a known yield-protocol address from INCOME → TRANSFER_IN (cost-basis
funding).

The yield round-trip math in `pnl-calculator/index.ts:266-307` stays as-is.
After the classifier change, the 5,000 USDC IN becomes a cost-basis lot
consumed by the 5,000 USDC OUT (zero gain), the 5,374.90 USDC YIELD-IN stays
in the Yield bucket, and the round-trip adjustment nets the gross IN vs the
earliest prior OUT → Interest earned = $366.61, Yield = $0, Income = $0,
Taxable = $366.61.

## Files to change

1. **`src/shared/yield-protocols.ts`** (NEW, ~15 lines)
   - Export `YIELD_PROTOCOL_ADDRESSES: ReadonlySet<string>` containing
     `0x5b7ba6471681c61b4994dc5072b0d0c0ffad4a2b` (Karmen Mezz Pool).
   - Export `SELF_FUNDING_BLOCK_WINDOW = 10` (≈50s on Celo's 5s blocks).
   - JSDoc: extend as more yield protocols are discovered.

2. **`src/sub-agents/tx-classifier/predicates.ts`** (small add)
   - Add new predicate kind `isInSelfFundingForYieldSet` (line ~89, in the
     Predicate union).
   - Add `selfFundingForYieldSet?: Set<TxHash>` to `PredicateContext` (~line 45).
   - Add evaluation case in `evaluatePredicate` (~line 175):
     ```ts
     case 'isInSelfFundingForYieldSet':
       return ctx.selfFundingForYieldSet?.has(ctx.tx.hash) ?? false;
     ```

3. **`src/sub-agents/tx-classifier/rules.ts`** (small add)
   - Add new rule BEFORE `income.stablecoin_in_no_native_out@v1` (~line 54):
     ```ts
     {
       id: 'transfer.self_funding_for_yield@v1',
       description: 'USDC IN immediately routed to a known yield-protocol — capital funding, not income',
       matches: {
         kind: 'allOf',
         children: [
           { kind: 'tokenSymbolIn', symbols: ['USDC', 'USDT', 'cUSD'] },
           { kind: 'tokenDirection', is: 'in' },
           { kind: 'tokenTransferCount', op: 'eq', value: 1 },
           { kind: 'isError', is: false },
           { kind: 'isInSelfFundingForYieldSet' },
         ],
       },
       classify: 'TRANSFER_IN',
       jurisdiction: ['NG', 'KE'],
       confidence: 0.9,
       notes: 'Self-funding for a yield position: the USDC IN was routed to a known yield-protocol within the funding window. Pre-empts the income rule that would otherwise mis-classify self-funding as employer compensation.',
     }
     ```
   - Refactor the existing `yield.known_protocol_in@v1` rule to reference
     `YIELD_PROTOCOL_ADDRESSES` (DRY — single source of truth for the address).

4. **`src/sub-agents/tx-classifier/index.ts`** (pre-pass add)
   - In `classifyWithDeps`, BEFORE the `for (const tx of fetched.rawTxns)` loop
     (~line 180), add a pre-pass that builds the funding set:
     ```ts
     import { YIELD_PROTOCOL_ADDRESSES, SELF_FUNDING_BLOCK_WINDOW } from '../../shared/yield-protocols.js';
     const selfFundingForYieldSet = computeSelfFundingForYieldSet(
       fetched.rawTxns, transfersByHash, fetched.address,
       YIELD_PROTOCOL_ADDRESSES, SELF_FUNDING_BLOCK_WINDOW,
     );
     ```
   - In the loop, add `...(selfFundingForYieldSet.size > 0 && { selfFundingForYieldSet })`
     to the PredicateContext literal (~line 182).
   - New top-level helper:
     ```ts
     function computeSelfFundingForYieldSet(
       rawTxns: readonly RawTx[],
       transfersByHash: ReadonlyMap<TxHash, readonly TokenTransfer[]>,
       address: Address,
       yieldAddrs: ReadonlySet<string>,
       blockWindow: number,
     ): Set<TxHash> {
       const sorted = [...rawTxns].sort((a, b) => a.blockNumber - b.blockNumber);
       const funding = new Set<TxHash>();
       const myAddr = address.toLowerCase();
       for (let i = 0; i < sorted.length; i++) {
         const tx = sorted[i]!;
         if (!tx.to) continue;
         if (!yieldAddrs.has(tx.to.toLowerCase())) continue;
         const transfers = transfersByHash.get(tx.hash) ?? [];
         const isStableOut = transfers.some(t =>
           t.from.toLowerCase() === myAddr &&
           (t.tokenSymbol === 'USDC' || t.tokenSymbol === 'USDT' || t.tokenSymbol === 'cUSD'));
         if (!isStableOut) continue;
         // Walk backwards to find the most recent stable IN within blockWindow.
         for (let j = i - 1; j >= 0; j--) {
           const prev = sorted[j]!;
           if (tx.blockNumber - prev.blockNumber > blockWindow) break;
           const prevT = transfersByHash.get(prev.hash) ?? [];
           const isStableIn = prevT.some(t =>
             t.to.toLowerCase() === myAddr &&
             (t.tokenSymbol === 'USDC' || t.tokenSymbol === 'USDT' || t.tokenSymbol === 'cUSD'));
           if (isStableIn) { funding.add(prev.hash); break; }
         }
       }
       return funding;
     }
     ```

5. **`tests/unit/tx-classifier.test.ts`** (new tests, ~80 lines)
   - `self-funding IN within block window → TRANSFER_IN, not INCOME`
     (mirror the 0xBE19 case: USDC IN then USDC OUT to `0x5b7ba647...` in same block)
   - `self-funding IN outside block window → still INCOME`
   - `self-funding IN with non-stable OUT (e.g. CELO) → still INCOME`
   - `non-stable IN (e.g. CELO) before yield-protocol OUT → no funding match`
   - `yield return IN (from yield-protocol) is not classified as self-funding`
     (i.e. `yield.known_protocol_in@v1` still wins — order matters)
   - `isInSelfFundingForYieldSet predicate unit test` (set membership)

6. **`tests/integration/vault-deposit.test.ts`** (extend, ~10 lines)
   - Add a self-funding case to the existing 0xBE19 fixture: USDC IN hash
     immediately followed by USDC OUT to `0x5b7ba647…` → IN classified
     TRANSFER_IN.

## Expected post-fix output (0xBE19 KE 2024)

| Line | Pre-fix (current) | Post-fix (predicted) | Notes |
|---|---:|---:|---|
| Realized gains | $0.00 | $0.00 | unchanged |
| Income | $4,997.26 | **$0.00** | funding reclassified |
| Yield | $0.00 | $0.00 | round-trip still nets |
| Interest earned | $366.61 | **$366.61** | round-trip math unchanged |
| Taxable income | $5,363.87 | **$366.61** | −$4,997.26 (no more double-count) |

The $366.61 vs sếp's $378.90 expectation is the CoinGecko USDC spot price
spread (5,374.90 × $0.9994 ≈ $5,371.61 IN, 5,000 × $1.001 ≈ $5,005 OUT,
diff $366.61). Per sếp's instruction, we keep CoinGecko prices as source of
truth; sếp understands the ~$8 gap is price rounding, not a math bug.

## Tests + checks (post-implementation)

```
pnpm test tests/unit/tx-classifier.test.ts        # new tests
pnpm test tests/integration/vault-deposit.test.ts # extended fixture
pnpm test                                            # full suite, expect 348+N pass
pnpm typecheck                                       # 0 errors
pnpm dev --address 0xBE19FF9839f6eEe1255F7461443aE7d987D8077c \
         --jurisdiction KE --tax-year 2024 \
         --output /tmp/agent-06-0xBE19-KE-2024-self-funding-fix.csv
# Expected: Income $0.00, Yield $0.00, Interest earned ~$366.61, Taxable ~$366.61
```

## Risk + edge cases

1. **False positive**: a user receives a real salary IN, then 5 blocks later
   sends USDC to a yield protocol → IN gets mis-classified as TRANSFER_IN.
   **Mitigation:** the funding window is 10 blocks (≈50s). A real salary
   followed by an immediate yield deposit is rare; the user can re-classify
   via LLM fallback (low confidence on this rule → 0.9 still beats 0.75
   default threshold, but `belowThreshold` flag in index.ts:194 catches
   edge cases for review).

2. **Multiple yield protocols**: the rule is keyed on
   `YIELD_PROTOCOL_ADDRESSES` set, so adding `0x5b7ba648…` etc. is one line
   per protocol. We start with one (Karmen Mezz) and grow.

3. **Window too tight**: 10 blocks is heuristic. If a user funds then waits
   15 blocks to deposit, the heuristic misses. **Future work:** make the
   window configurable; for v1 keep 10 blocks (covers 0xBE19 case in same
   block, with comfortable headroom for gas/reorg variance).

4. **Cross-jurisdiction**: rule has `jurisdiction: ['NG', 'KE']` matching
   the existing income rule. OTHER (OECD CARF) is not affected — keeps
   behavior unchanged there.

5. **No `to` field on the OUT tx**: the funding check requires
   `tx.to !== null`. Contract-creation txs are skipped (correct — they
   can't be yield-protocol deposits).

## What stays the same

- The yield round-trip fix in `pnl-calculator/index.ts:266-307` (Quan
  2026-06-14) is untouched. It still does the right thing; it's just fed
  better input (TRANSFER_IN for the funding, YIELD for the return).
- The 5,374.90 USDC IN on Dec 14 is still classified YIELD by
  `yield.known_protocol_in@v1` (which runs before the new rule).
- The Dec 31 USDyc vault DEPOSIT is still classified via the protocol-decoder
  path (unchanged).
- The `address-book employer list` reference in the income rule's notes is
  cosmetic — we keep it for the address-book-based confidence lift (which
  the income rule still uses for non-self-funding INs).

## Open questions (sếp to confirm before I start)

1. **Block window = 10?** Or do you want a wider/narrower window?
   - Same-block only (1): tightest, no false positives, but misses cases
     with 2-3 block delay.
   - 10 blocks (≈50s): covers the 0xBE19 case with comfortable headroom.
   - 60 blocks (≈5min): catches users who fund then wait before clicking
     "deposit". Slight risk of false positives.

2. **Confidence 0.9?** I picked 0.9 (high but not 1.0). Lower = the rule
   fires but `flagged` for review. Higher = no human review ever.
   I think 0.9 is right but want your call.

3. **Stablecoins to detect**: `USDC`, `USDT`, `cUSD`. Should I also include
   `cEUR` / `cREAL`? 0xBE19 is USDC-only, but the rule should be generic.

4. **Backward compat with the address-book employer match**: the income
   rule's note still says "Address-book match against employer list lifts
   confidence to 0.95". The address-book isn't currently wired to
   actually adjust the confidence (the note is aspirational). I won't
   touch the address-book in this change — that's a separate workstream.

If you give a thumbs-up on this plan (with or without tweaks), I'll have
the implementation agent (Tuan, fullstack-developer, or default — your
choice) execute the file edits. I'll re-verify the 0xBE19 KE 2024 report
afterward and report back.
