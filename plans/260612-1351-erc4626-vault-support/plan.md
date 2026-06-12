---
title: "ERC-4626 Vault Support — function-selector + position tracking"
description: "Add general ERC-4626 vault support to the Celo Onchain Tax Agent: function-selector detection, FIFO position tracking per-vault, and tax classification for deposit/withdraw. Validated against the live Untangled USDy vault on Celo mainnet."
status: done
priority: P1
effort: ~3-4h (3 waves, code + tests + dual repo port)
branch: feat/erc4626-wave3-pnl-vault
tags: [agent-06, classifier, fifo, celo, erc-4626, vault, untangled, phase-d]
created: 2026-06-12
completed: 2026-06-12
---

# ERC-4626 Vault Support — Plan

**Owner:** planner (this plan) → fullstack-developer (implementation)
**Trigger:** Investor wallet `0xBE19FF9839f6eEe1255F7461443aE7d987D8077c` deposited 5,372.037664 USDC into the Untangled USDy vault (`0x2a68c98bd43aa24331396f29166aef2bfd51343f`) at block 29597172 (tx `0x102fd04c…8f7e`). The classifier currently flags this as `INTERACTION` (the `/Vault|ERC-?4626/i` name pattern matches and falls through to the generic VAULT branch in `src/sub-agents/tx-classifier/index.ts:498-506`). The user wants **general ERC-4626 support** — not a hard-coded Untangled entry — but with the verified vault registered so the demo works.

**Foundation:** Phase A/B/C (Mento, Ubeswap, Moola, GoodDollar, 5 MCP tools) are done. The protocol-decoder pattern (`src/sub-agents/tx-classifier/protocol-decoder.ts`) is the established template.

---

## 0. Behavioral Checklist (Tech-Lead self-verification)

- [x] **Data flows documented** for each wave (calldata → selector → protocol action → classified tx → FIFO lot → CSV row)
- [x] **Dependency graph complete** — Wave 1 unblocks Wave 2; Wave 3 builds on both
- [x] **Risk assessed per wave** with likelihood × impact + mitigation
- [x] **Backwards compatibility strategy** — all 3 waves are **additive**; existing rule table, protocol-decoder, FIFO, and CSV schemas untouched
- [x] **Test matrix defined** — unit (selectors, FIFO lots, CSV rows), integration (real investor tx), regression (no drift on existing 4 protocols)
- [x] **Rollback plan** — each wave is a small, isolated diff; revert = revert that commit. Wave 1 alone gets the investor tx classified correctly.
- [x] **File ownership** — distinct files; no overlap with Phase A/B/C
- [x] **Success criteria measurable** — investor tx `0x102fd04c…` classified as YIELD, USDy position tracked, withdraw tx round-trip is FIFO-disposal, dual repo port verified by `npx tsc --noEmit`

---

## ⚠️ Critical findings during planning (READ FIRST)

### F1. Two of the four selectors in the task prompt are WRONG

Verified against 4byte.directory AND the on-chain bytecode at `0x2a68…1343f` (which contains all 6 standard ERC-4626 selectors — see [§3.2](#32-verified-erc-4626-function-selectors)):

| Function | Task prompt said | **Actual selector** | Task prompt was |
|---|---|---|---|
| `deposit(uint256,address)` | `0x6e553f65` | `0x6e553f65` | ✅ correct |
| `mint(uint256,address)` | `0x94bf804d` | `0x94bf804d` | ✅ correct |
| `withdraw(uint256,address,address)` | `0x2e17de78` | **`0xb460af94`** | ❌ wrong (`0x2e17de78` is `unstake(uint256)` — see `src/shared/selector-registry.ts:178-182`) |
| `redeem(uint256,address,address)` | `0xdb006a75` | **`0xba087652`** | ❌ wrong (`0xdb006a75` is `redeem(uint256)` WETH-style) |

If implemented as-stated, the classifier would silently misattribute every vault withdraw as an unstake and every vault redeem as a WETH redeem — destroying downstream FIFO disposal math. **The plan uses the verified selectors.**

### F2. ERC-4626 `redeem` selector (`0xba087652`) collides with Moola `redeem`

`0xba087652` is already in `src/sub-agents/tx-classifier/protocol-decoder.ts:126-130` as **MOOLA WITHDRAW**. The Moola cToken uses the same selector for `redeem(uint256,address,address)` because it conforms to a Compound-fork interface. The protocol-decoder already handles this kind of collision via `isKnownProtocolAddress()` — the Moola gate uses `isMoolaCToken()`; we need a parallel `isERC4626Vault()` gate. **No conflict in practice as long as we keep address-based protocol attribution.**

### F3. Vault metadata verified on-chain (2026-06-12)

Confirmed via `eth_call` against `https://celo-rpc.publicnode.com`:

| Field | Value | Source |
|---|---|---|
| `name()` | "USDy" | `0x06fdde03` |
| `symbol()` | "USDy" | `0x95d89b41` |
| `decimals()` | 6 | `0x313ce567` |
| `asset()` | `0xcebA9300f2b948710d2653dD7B07f33A8B32118C` (USDC bridged, already in `CELO_NATIVE_TOKENS` at `src/shared/contracts.ts:68`) | `0x38d52e0f` |
| Investor deposit tx | `0x102fd04c…8f7e`, block `0x1C39DF4` (29597172) | `eth_getTransactionByHash` |
| Deposit event | topics `[sender, owner]` = `[0xBE19…, 0xBE19…]`, data `(assets, shares)` = `(5372037664, 5372037664)` (1:1 ratio, fresh vault) | `eth_getLogs` filter on Deposit topic |
| Selector in tx `input` | `0x6e553f65` (= `deposit(uint256,address)`) | confirmed |

**The vault is real ERC-4626, wraps USDC, and the investor's deposit is a clean test fixture.** No new env vars needed.

---

## 1. Wave 1 — Function-selector detection (THE MINIMUM VIABLE)

**Blocker for: Wave 2 (event enrichment), Wave 3 (position tracking).**
**Unblocks:** The investor tx gets classified as YIELD instead of INTERACTION on the first PR.

### 1.1 Scope & Purpose

Teach the protocol-decoder to recognize the four ERC-4626 standard mutators (`deposit`, `mint`, `withdraw`, `redeem`) and map them to the existing `DEPOSIT` / `WITHDRAW` `ProtocolActionType` values. The existing `protocolActionToTxType()` in `src/sub-agents/tx-classifier/protocol-actions.ts:44-72` already maps both DEPOSIT and WITHDRAW to `YIELD` — exactly what we want for vault flows (acquisition = shares minted, disposal = underlying returned).

The user wants **general** support, not just Untangled, so we need a way to attribute any contract that *could* be an ERC-4626 vault — not only the one we manually registered. Two complementary mechanisms:

1. **Address allowlist** (`src/shared/contracts.ts`): pre-registered vault addresses — start with the verified `0x2a68…1343f` (alias `UNTANGLED_USDY_VAULT`).
2. **Name-pattern fallback**: keep the existing `/Vault|ERC-?4626/i` rule in `src/shared/protocol-registry.ts:73` for unknown vaults. This currently lifts to `INTERACTION` only — we need to extend it to also feed into the protocol-decoder path via the `ProtocolName.ERC4626` route.

### 1.2 Verified ERC-4626 function selectors

From 4byte.directory and cross-checked against the on-chain bytecode at `0x2a68c98bd43aa24331396f29166aef2bfd51343f`:

| Function signature | Selector | Source |
|---|---|---|
| `deposit(uint256,address)` | `0x6e553f65` | 4byte ID 14299; investor tx input matches |
| `mint(uint256,address)` | `0x94bf804d` | 4byte — confirmed |
| `withdraw(uint256,address,address)` | `0xb460af94` | 4byte — verified (NOT `0x2e17de78` = `unstake`) |
| `redeem(uint256,address,address)` | `0xba087652` | 4byte — verified (NOT `0xdb006a75` = WETH-style `redeem`) |
| `convertToAssets(uint256)` | `0x07a2d13a` | 4byte — for Wave 3 valuation |
| `convertToShares(uint256)` | `0x4cdad6ef` | 4byte — not in this contract's bytecode (uses default OZ impl) |
| `totalAssets()` | `0x01e1d114` | 4byte — for Wave 3 valuation |
| `asset()` | `0x38d52e0f` | 4byte — for Wave 3 underlying-token discovery |

**Wave 1 only needs the 4 mutators.** The 4 view functions are deferred to Wave 3 (position valuation).

### 1.3 Implementation steps

**Step 1.1 — Add `ERC4626` to `ProtocolName` enum.**
File: `src/sub-agents/tx-classifier/protocol-actions.ts`
Insert `ERC4626 = 'ERC4626'` in the `ProtocolName` enum (line 11-16).
Add a `case ProtocolName.ERC4626:` branch to `protocolActionToTxType()` (after line 71) mapping `DEPOSIT` → `'YIELD'` and `WITHDRAW` → `'YIELD'`.

**Step 1.2 — Register the verified vault address.**
File: `src/shared/contracts.ts`
- Extend the `ContractAlias` union (line 37-45) with `'UNTANGLED_USDY_VAULT'`.
- Append a `NamedContract` entry:
  ```ts
  {
    alias: 'UNTANGLED_USDY_VAULT',
    description: 'Untangled USDy — ERC-4626 vault wrapping USDC on Celo mainnet.',
    source: 'verified on-chain 2026-06-12 via eth_call on 0x2a68…1343f; name=USDy symbol=USDy decimals=6 asset()=0xcebA9300…',
    addresses: {
      alfajores: null,
      mainnet: '0x2a68c98bd43aa24331396f29166aef2bfd51343f',
    },
  }
  ```

**Step 1.3 — Add the selector table entries.**
File: `src/sub-agents/tx-classifier/protocol-decoder.ts`
Append a new `SELECTOR_TABLE` entry (after the GOODDOLLAR block, line 158):
```ts
{
  protocol: ProtocolName.ERC4626,
  action: ProtocolActionType.DEPOSIT,
  selectors: [
    '0x6e553f65', // deposit(uint256,address)
    '0x94bf804d', // mint(uint256,address)
  ],
  functionName: 'deposit/mint',
},
{
  protocol: ProtocolName.ERC4626,
  action: ProtocolActionType.WITHDRAW,
  selectors: [
    '0xb460af94', // withdraw(uint256,address,address)
    '0xba087652', // redeem(uint256,address,address)
  ],
  functionName: 'withdraw/redeem',
},
```

**Step 1.4 — Address gate.**
File: `src/sub-agents/tx-classifier/protocol-decoder.ts`
- Add constant `const UNTANGLED_USDY_VAULT = '0x2a68c98bd43aa24331396f29166aef2bfd51343f'.toLowerCase();` (line 53, after the GOODDOLLAR_CLAIMERS block).
- Extend `isKnownProtocolAddress()` (line 249-260) with a `case ProtocolName.ERC4626:` that returns `true` when the address is in the `ERC4626_VAULTS` set (initially just the one alias — but designed as a Set so more can be added).
- Add helper:
  ```ts
  function isERC4626Vault(addr: string): boolean {
    return ERC4626_VAULTS.has(addr);
  }
  ```
- Initialize `ERC4626_VAULTS` as a `Set<string>` with the one verified address; this is the seam where future vault registrations land.

**Step 1.5 — Update the comment header.**
File: `src/sub-agents/tx-classifier/protocol-decoder.ts:6-13`
Add `ERC-4626 vault (any registered address) — DEPOSIT, WITHDRAW` to the supported protocols list.

**Step 1.6 — Add the same protocol-decoder path to the standalone MCP pipeline.**
File: `mcp-server/src/lib/pipeline-core.ts`
- The standalone pipeline (line 137-188) only uses the rule table; the protocol-decoder is not ported. **However, `pipeline-core.ts` is a self-contained lib with no `../../src` imports** (per its header). For Wave 1 we do NOT port the full protocol-decoder; instead we add a minimal ERC-4626-aware rule that mimics the decoder's behavior for the 4 mutators + 1 address. This keeps Wave 1 small.

  **New rule** (insert after `yield.staking@v1` at line 174):
  ```ts
  { id: 'yield.erc4626@v1', matches: { kind: 'allOf', children: [
    { kind: 'toIn', refs: ['UNTANGLED_USDY_VAULT'] },
    { kind: 'hasMethod', method: 'deposit' },  // broader; matched by raw input
    { kind: 'isError', is: false }] },
    classify: 'YIELD', confidence: 0.9 },
  ```
  **Note:** The MCP predicate DSL doesn't expose `extractSelector` — the `hasMethod` matches on `tx.methodName` (set by Celoscan). For the demo this is good enough; the monorepo classifier handles the broader case via the protocol-decoder. Document this limitation in a comment.

**Step 1.7 — Tests.**
File: `tests/unit/protocol-decoder.test.ts` (extend existing file — owner: Tuan)
Add 4 new test cases mirroring the Mento pattern at line 64-116:
1. `decodeProtocolAction` with `tx.to = UNTANGLED_USDY_VAULT`, `input = 0x6e553f65 + ...` → `{ protocol: ERC4626, action: DEPOSIT, confidence: 0.9 }`.
2. Same vault, `input = 0x94bf804d` → `{ protocol: ERC4626, action: DEPOSIT, functionName: 'deposit/mint' }`.
3. Same vault, `input = 0xb460af94` → `{ protocol: ERC4626, action: WITHDRAW, confidence: 0.9 }`.
4. Same vault, `input = 0xba087652` → `{ protocol: ERC4626, action: WITHDRAW, functionName: 'withdraw/redeem' }`.
5. **False-positive guard**: same selector on a wrong address returns `null` (mirrors line 182-195 in existing tests).
6. **Selector-collision guard**: `0xba087652` on a Moola cToken address must still classify as MOOLA, NOT ERC-4626 (regression test — confirms the address-gate works both ways).
7. **Investor integration test**: feed the real tx `0x102fd04c…8f7e` into `classify()` and assert `result.classified[0].type === 'YIELD'`, `assetIn.symbol === 'USDC'`, `amount === '5372037664'`. Lives in a new `tests/integration/vault-deposit.test.ts` (or extends `tests/unit/tx-classifier.test.ts` if it has an investor-fixture hook).

**Step 1.8 — Update `CONTRACT-RESEARCH-NOTES.md`.**
File: `src/sub-agents/tx-classifier/CONTRACT-RESEARCH-NOTES.md`
Append a "Phase D — ERC-4626 vault support" section with: the verified vault address, the 4 mutator selectors (with the 2 corrections noted in F1), and the investor tx as the canonical test fixture.

### 1.4 Test matrix

| Test | Type | Expectation |
|---|---|---|
| 4 mutator selectors → correct (protocol, action) | Unit | protocol=ERC4626, action∈{DEPOSIT,WITHDRAW}, conf=0.9 |
| Selector on wrong address | Unit | `null` (no false positive) |
| `0xba087652` on Moola cToken | Unit | protocol=MOOLA, action=WITHDRAW (regression — Moola still wins) |
| Real investor tx `0x102fd04c…` | Integration | classified type=YIELD, assetIn.symbol=USDC, amount=5372037664 |
| Existing 4-protocol tests (Mento, Ubeswap, Moola, GoodDollar) | Regression | no drift |

### 1.5 Risk

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Selector collision with Moola on `0xba087652` | Low | High (wrong disposal math) | Address gate is mandatory; add explicit regression test |
| Unknown vault not in `ERC4626_VAULTS` set | Medium | Low (still classified as INTERACTION via the existing VAULT name pattern; not a regression) | Document the path; Wave 2 event enrichment closes this gap |
| New `ContractAlias` breaks Alfajores | Low | Low (alias has `alfajores: null`, no-op on testnet) | Mirror existing pattern; null address means rule is no-op on Alfajores |

### 1.6 Effort

**S** (~1.5h): 30 LOC protocol-decoder + 8 LOC contracts + ~50 LOC tests. Single PR, single commit, easy revert.

### 1.7 Success criteria

- `npx tsc --noEmit` clean in both monorepo and mcp-server.
- `pnpm test tests/unit/protocol-decoder.test.ts` passes with the 7 new cases.
- `pnpm test` (full suite) — no regression in existing 4 protocols.
- The investor tx `0x102fd04c…` fed into the monorepo classifier produces `type: 'YIELD'`, `assetIn.symbol: 'USDC'`, `amount: '5372037664'`, `confidence: 0.9`.
- Demo: re-run the demo script against the investor wallet; the deposit now appears in the classified-tx list (no longer `INTERACTION`).

---

## 2. Wave 2 — Event-based enrichment (MORE ACCURATE, OPTIONAL)

**Blocker for:** Wave 3 (need exact `assets` and `shares` amounts).
**Status:** **Defer to post-hackathon unless Wave 3 is in scope.** The user asked for v1; event enrichment adds an `eth_getLogs` dependency per tx that isn't free.

### 2.1 Scope & Purpose

Decode the ERC-4626 `Deposit(address,address,uint256,uint256)` and `Withdraw(address,address,address,uint256,uint256)` events to extract the exact `assets` and `shares` amounts — bypassing the calldata parsing. The events are emitted by EVERY ERC-4626 vault, so this works for unknown vaults too (no need to maintain the address allowlist).

### 2.2 Trade-off

| Aspect | Function-selector (Wave 1) | Event enrichment (Wave 2) |
|---|---|---|
| Data source | `tx.input` (1 read, always available) | `eth_getLogs` (1+ reads, may be rate-limited) |
| Works for unknown vaults | ❌ (address allowlist only) | ✅ (event signature is standard) |
| Returns exact `assets`/`shares` | ❌ (must decode calldata) | ✅ (in event `data`) |
| Existing protocol-decoder pattern | ✅ (matches Phase A) | ❌ (new code path) |
| Effort | done in Wave 1 | ~1.5h |

**Recommendation:** Defer to post-hackathon. The investor tx is the only known example and Wave 1's selector match is sufficient. Wave 2 makes sense once multiple vault types appear in production wallets.

### 2.3 Open question for the user

**Should Wave 2 be in scope for the hackathon demo, or post-hackathon?**
- "Yes, include it" → adds ~1.5h; demo becomes vault-agnostic.
- "No, defer" → ship Wave 1 + Wave 3; address allowlist grows as we discover vaults.

---

## 3. Wave 3 — Per-vault FIFO position tracking (THE TAX-CORRECT PART)

**Blocker for:** Any future unrealized-PNL feature (out of scope here).
**Scope:** Replace the per-symbol FIFO lot queue with a per-(vault-address, symbol) queue for ERC-4626 lots. Without this, vault shares (e.g. `USDy`) are conflated with the underlying (e.g. `USDC`), and a withdraw would consume lots from the wrong queue.

### 3.1 Scope & Purpose

The existing FIFO at `src/sub-agents/pnl-calculator/fifo.ts:69` uses a per-symbol queue (`Map<string, AssetLot[]>`). For a vault deposit, the lot is for the **share token** (e.g. `USDy`); for a vault withdraw, the lot consumed is also the **share token** (we surrender shares, get underlying back). This is already correct *if* the share token has a unique symbol — `USDy` ≠ `USDC`, so the per-symbol queue works for this vault.

**However**, two vaults wrapping the same underlying may issue share tokens with **the same symbol** (e.g. two USDC vaults both calling their share `usdcVault`). When that happens, the per-symbol queue conflates them. The fix: include the vault address in the lot's identity. Concretely:

- Extend the `AssetLot` interface (`src/sub-agents/pnl-calculator/engine.ts:18-33`) with an optional `vaultAddress?: Address` field. Populated only for ERC-4626 lots.
- Extend the FIFO queue key from `string` (symbol) to a string that includes vault address for vault lots: e.g. `key = vaultAddress ? `${vaultAddress.toLowerCase()}:${symbol}`` : symbol`.
- The PNL engine already calls `lotFromAcquisition(asset, decimals, hash, source, timestamp)`; add a 6th optional param `vaultAddress?: Address` and plumb through.

### 3.2 Why the simple change works

- For non-vault assets (CELO, cUSD, direct USDC transfers), `vaultAddress` is undefined and the key degenerates to the symbol — no behavior change.
- For vault shares, the key is `0x2a68c98b…:USDy` — distinct from any other vault's `usdcVault` token.
- The disposal math (consuming front lot, computing gain) is unchanged.
- The CSV exporter and downstream code consume `Disposal.symbol` which is still `USDy` — no CSV schema change.

### 3.3 Test matrix

| Test | Type | Expectation |
|---|---|---|
| Deposit + withdraw of full position | Unit | Lot created on deposit, consumed on withdraw, 1 disposal emitted, gain = 0 |
| Two deposits, partial withdraw | Unit | Two lots, withdraw consumes front lot first, second lot survives |
| Two vaults with same share symbol | Unit | Lots kept in separate queues (regression — this is the bug Wave 3 fixes) |
| Existing non-vault FIFO tests | Regression | unchanged |

### 3.4 Risk

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Symbol collision in existing wallets | Low | Medium (wrong lot consumption) | The fix is the fix; no new failure mode introduced |
| Breaking change to AssetLot shape | Low | Medium (other engines — LIFO, WAC — share the type) | New field is optional; LIFO/WAC identical math; tests cover |
| `Disposal.symbol` ambiguity for CSV | Low | Low | Symbol is still the share token symbol; vault address available via `Disposal.lotSourceHash` lookup if needed |

### 3.5 Effort

**M** (~2h): ~20 LOC in `engine.ts`, ~15 LOC in `fifo.ts`, ~30 LOC in `lifo.ts` (mirror), ~30 LOC in `wac.ts` (mirror), ~50 LOC tests. Touches 4 files but each diff is mechanical.

### 3.6 Open question for the user

**What is the right lot identity for cross-protocol vault shares?**
- "Per-vault address" (Wave 3) — treats each vault as a separate asset.
- "Per-symbol" (no Wave 3) — accepts the collision risk; document it.
- "Per-(vault, underlying)" — uses the underlying token symbol instead of the share symbol; treats vault shares as fungible across vaults (incorrect for FIFO basis tracking).

**Recommendation: per-vault address.** It's the only one that preserves the FIFO contract.

---

## 4. Tax classification (already correct via the existing type system)

The existing `protocolActionToTxType()` mapping (planned in §1.3 Step 1.1) gives us:

- `DEPOSIT` on ERC-4626 → `YIELD` (acquisition; `isAcquisition()` returns true at `engine.ts:122-127`; FIFO lot is created)
- `WITHDRAW` on ERC-4626 → `YIELD` (disposal; `isAcquisition()` returns false; falls into the BRIDGE/MENTO_STABILITY/MINT/BURN/UNKNOWN branch at `fifo.ts:151-153` which **is a bug** for our use case)

**Bug found in existing FIFO:** The `if (isAcquisition)` + `if (isDisposal)` branches don't cover `YIELD` as a disposal. The YIELD classification was historically only used for income events (staking rewards, GoodDollar claims). A vault **withdraw** is a YIELD-tagged *disposal* — surrender shares, receive underlying. The current FIFO silently skips it (`fifo.ts:151-153`).

**Required fix (1 line in `fifo.ts`):** change the disposal detection to `c.type === 'TRANSFER_OUT' || c.type === 'SWAP' || (c.type === 'YIELD' && c.assetOut !== undefined)`. Wave 3 covers this since we're touching the FIFO. The disposal is recorded under the **share token symbol** (e.g. `USDy`) and the gain is computed against the share's cost basis — exactly the desired behavior.

**Note on the underlying token:** When a vault withdraw is recorded, `c.assetIn` is the **underlying** (e.g. `USDC`) received, and `c.assetOut` is the **share** (e.g. `USDy`) surrendered. The `enrichClassifiedWithAssetLegs()` step (`src/sub-agents/tx-classifier/index.ts:354-409`) already populates both legs from the token transfers. So `assetIn.symbol = 'USDC'` (or `cUSD` etc.), `assetOut.symbol = 'USDy'`. The disposal uses `assetOut` (shares); the gain is `share_disposal_proceeds - share_cost_basis` in USD.

**Open question for the user:** Should the disposal **proceeds** be priced in:
- (a) **share units** (1 USDy ≈ 1 USD — what CoinGecko would show for the share token if it existed)
- (b) **underlying units at withdrawal** (1 USDy redeemed for 1 USDC ≈ 1 USD)

For a 1:1 vault, they're identical. For a yield-bearing vault, (b) is more accurate (you receive more underlying per share). **Recommendation: (b) — price the disposal at the **incoming** asset's USD price** (the underlying), since that's what you actually receive. The existing FIFO reads `c.assetOut.priceUsd` (the share); the fix is to also use `c.assetIn.priceUsd` when both are set, with a clear note in the disposal record.

This is a **small but important detail** for the v1 demo. See §6 open question 1.

---

## 5. Test plan (consolidated)

| Wave | Test | File | Type | Expectation |
|---|---|---|---|---|
| 1 | 4 mutator selectors decode correctly | `tests/unit/protocol-decoder.test.ts` | Unit | (see §1.4) |
| 1 | Selector collision `0xba087652` still routes to MOOLA on cToken | same | Unit | protocol=MOOLA |
| 1 | Real investor tx classifies as YIELD | `tests/integration/vault-deposit.test.ts` (new) | Integration | type=YIELD, assetIn.symbol=USDC, amount=5372037664 |
| 1 | MCP pipeline sees the vault deposit | `mcp-server/src/lib/pipeline-core.ts` (extend) | Unit | rule fires, classified type=YIELD |
| 3 | FIFO: 2 deposits + partial withdraw | `tests/unit/pnl-calculator.test.ts` | Unit | 2 lots, withdraw consumes front lot |
| 3 | FIFO: 2 vaults same share symbol stay separate | same | Unit | separate queues |
| 3 | FIFO: vault withdraw computes gain correctly | same | Unit | gain = proceeds_USDC - cost_basis_USDy |
| 1+3 | CSV: vault deposit shows in NG FIRS + CARF + KRA | `tests/unit/csv-exporter.test.ts` | Unit | 1 income row + 1 disposal row |

Total new tests: ~12 cases, ~150 LOC. Estimated test-writing effort: ~1h.

---

## 6. Open questions for the user

1. **Disposal pricing for vault withdraws** (see §4): share-price vs underlying-price? Recommendation: **underlying at withdraw** (more accurate for yield-bearing vaults).
2. **Wave 2 in scope for hackathon?** Recommendation: **defer**. Wave 1 is sufficient for the demo; Wave 2 matters only once the address allowlist is too long to maintain.
3. **Asset leg convention**: should `assetIn` on a vault withdraw be the **underlying** (e.g. `USDC`) or the **share** (e.g. `USDy`)? The existing enrichment logic picks the largest incoming — for a 1:1 vault the amounts are equal and the symbol disambiguates. For yield-bearing vaults, the underlying amount may be larger and the share smaller. **Recommendation: pick by symbol** (share token = known `USDy`; incoming `USDC` = underlying). Add explicit test.
4. **Should `vault.notes` include the underlying symbol?** E.g. `"ERC4626:DEPOSIT (deposit) — underlying: USDC"`. Useful for the audit trail. **Recommendation: yes**, populate from `asset()` call cached at the first deposit.
5. **Celo mainnet address for `UNTANGLED_USDY_VAULT` only, or also Alfajores?** The investor's deposit is on mainnet; no known Alfajores vault. **Recommendation: mainnet-only for hackathon**; Alfajores can be added if a test contract is deployed.

---

## 7. Recommended implementation order

1. **Wave 1** (S, 1.5h) — protocol-decoder additions, address registration, tests. **First PR.** Demo can show the investor tx classified correctly.
2. **Wave 3** (M, 2h) — FIFO per-vault lot identity, disposal branch fix, tests. **Second PR.** Cost basis is now correct for any ERC-4626 vault.
3. **Wave 2** (M, 1.5h) — event-based enrichment. **Third PR, post-hackathon.** Optional; only needed when vault allowlist grows.

Total estimated effort (Waves 1 + 3): **~3.5h**, well within the 1.5-day hackathon budget.

---

## 8. Cross-cutting concerns

### 8.1 File ownership (parallel work)

| File | Owner | Touched by |
|---|---|---|
| `src/shared/contracts.ts` | Credio (build) | Wave 1 (add UNTANGLED_USDY_VAULT alias) |
| `src/shared/protocol-registry.ts` | Tuan | not touched (existing VAULT pattern is fine) |
| `src/sub-agents/tx-classifier/protocol-actions.ts` | Tuan | Wave 1 (add ERC4626 enum + mapping) |
| `src/sub-agents/tx-classifier/protocol-decoder.ts` | Tuan | Wave 1 (add selectors + address gate) |
| `src/sub-agents/tx-classifier/CONTRACT-RESEARCH-NOTES.md` | Tuan | Wave 1 (Phase D section) |
| `src/sub-agents/pnl-calculator/engine.ts` | Credio (pnl) | Wave 3 (AssetLot.vaultAddress) |
| `src/sub-agents/pnl-calculator/fifo.ts` | Credio (pnl) | Wave 3 (queue key + YIELD-disposal branch) |
| `src/sub-agents/pnl-calculator/lifo.ts` | Credio (pnl) | Wave 3 (mirror) |
| `src/sub-agents/pnl-calculator/wac.ts` | Credio (pnl) | Wave 3 (mirror) |
| `mcp-server/src/lib/pipeline-core.ts` | Credio (mcp) | Wave 1 (minimal rule for UNTANGLED_USDY_VAULT) |
| `tests/unit/protocol-decoder.test.ts` | Tuan | Wave 1 (4+ new cases) |
| `tests/integration/vault-deposit.test.ts` | Tuan | Wave 1 (real investor tx) |
| `tests/unit/pnl-calculator.test.ts` | Credio (pnl) | Wave 3 (3 new cases) |

**No file is touched by two waves in parallel** — Wave 1 finishes before Wave 3 starts.

### 8.2 Dual-repo port

Both monorepo (`src/`) and mcp-server (`mcp-server/src/lib/pipeline-core.ts`) need Wave 1 changes. The MCP lib is a stripped-down port (per its header) and the protocol-decoder isn't ported there. We add a **minimal rule-only** path for the MCP (covers the demo). The full protocol-decoder port is out of scope for the hackathon.

### 8.3 Backwards compatibility

- All changes are **additive**: new enum value, new alias, new selector entries, new optional field on `AssetLot`.
- Existing wallets (no vault txs) see no behavior change — verified by the existing test suite.
- Existing rule table and CSV schemas untouched.
- The YIELD-disposal branch fix in `fifo.ts:151-153` (the `BRIDGE / MENTO_STABILITY / MINT / BURN / UNKNOWN — explicitly skipped` comment) is the only **behavioral** change. It now also matches `YIELD` when `c.assetOut` is set. Risk: a wallet that previously had YIELD with `assetOut` set (none observed in fixtures) would change behavior. **Mitigation:** add a regression test asserting that staking-reward YIELD txs (no `assetOut`) are still treated as income (the `isAcquisition` branch already handles this — the new branch only fires when `assetOut` is present, which is never for staking rewards).

### 8.4 Rollback plan

- **Wave 1:** revert the commit; the classifier reverts to flagging vault txs as `INTERACTION` via the existing VAULT name pattern. No data loss.
- **Wave 3:** revert the commit; FIFO reverts to per-symbol queues. Vault lots are tracked under their share symbol — works for the demo (only one vault registered, no symbol collision). Data loss: any vault txs classified during the Wave 3 deployment would need to be re-processed.

### 8.5 Success criteria (overall)

1. `npx tsc --noEmit` clean in both repos.
2. `pnpm test` passes; 0 regressions in the 4 existing protocols.
3. The investor tx `0x102fd04c…` is classified as `YIELD` with `assetIn.symbol === 'USDC'` and `amount === '5372037664'`.
4. A second test fixture (synthesized deposit + withdraw round-trip on the same vault) produces a `Disposal` with `gainMicroUsd === 0` (1:1 vault).
5. Demo script: investor wallet's deposit no longer appears in the `flaggedForReview` list.

---

## 9. Related files for context (read-before-implement)

- `src/shared/contracts.ts:31-83` — contract registry pattern (mirror for `UNTANGLED_USDY_VAULT`)
- `src/shared/protocol-registry.ts:63-74` — name patterns (existing `/Vault|ERC-?4626/i` is good; do not modify)
- `src/sub-agents/tx-classifier/protocol-actions.ts:11-72` — ProtocolName + TxType mapping (extend with ERC4626)
- `src/sub-agents/tx-classifier/protocol-decoder.ts:36-53, 65-158, 249-260` — address constants, SELECTOR_TABLE, isKnownProtocolAddress (extend with ERC4626_VAULTS set)
- `src/sub-agents/pnl-calculator/fifo.ts:65-75` — acquisition branch (untouched in Wave 1; modified in Wave 3)
- `src/sub-agents/pnl-calculator/engine.ts:18-33` — AssetLot interface (extend with `vaultAddress?` in Wave 3)
- `mcp-server/src/lib/pipeline-core.ts:18-21, 138-179` — minimal rule pattern (mirror for `UNTANGLED_USDY_VAULT`)
- `tests/unit/protocol-decoder.test.ts:62-116` — selector test pattern (extend with 4 new cases)
- `src/sub-agents/tx-classifier/CONTRACT-RESEARCH-NOTES.md:79-128` — Phase A/B notes; mirror for Phase D section
- `.claude/skills/celo-chain-data.md:61-73` — native token addresses (USDy asset() = USDC, already in `CELO_NATIVE_TOKENS`)

---

## 10. Unresolved questions (consolidated)

1. **Disposal pricing for vault withdraws** — share vs underlying? **Recommended: underlying at withdraw.**
2. **Wave 2 in scope?** **Recommended: defer to post-hackathon.**
3. **Asset leg selection for vault withdraw** — share or underlying? **Recommended: by symbol.**
4. **Should `notes` include underlying symbol?** **Recommended: yes.**
5. **Mainnet-only for hackathon?** **Recommended: yes.**

**These are all non-blocking for implementation** — the recommended defaults are sensible and the plan is executable. Surfacing them here so the user can override before code is written.
