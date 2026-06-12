# Contract research notes — Celo address registry

**Author:** Tuan (initial), Credio (population)
**Date:** 2026-06-08 (initial), 2026-06-10 (mainnet addresses populated)
**Owner of `src/shared/contracts.ts`:** Credio (build side)
**Status:** **5 of 8 mainnet addresses populated** (UBESWAP_V2_ROUTER, MENTO_BROKER,
MENTO_ROUTER, PORTAL_BRIDGE, GOOD_DOLLAR_RESERVE). 3 still TODO (staking rewards
distributor, pre-Plume native bridge, core registry). All Alfajores addresses
still TODO (docs only list mainnet + Celo Sepolia).

## What I tried

| Source | Result | Notes |
|---|---|---|
| `https://docs.mento.org/mento-101/deployed-contracts` | 404 | Mento docs restructured; old anchor dead. |
| `https://docs.ubeswap.org/reference/deployments` | 404 | Ubeswap docs site returns 404. |
| `https://docs.celo.org/developer/deployments/mainnet` | 404 | Celo docs restructured; old anchor dead. |
| `https://celoscan.io/address/0x…` | 403 | Cloudflare blocks headless browser fetch. Would need Celoscan API key (env: `CELOSCAN_API_KEY`) — Quan to fund or we ask in Discord. |
| `https://api-alfajores.celoscan.io/api?module=contract&action=listcontracts` | (not tried) | Requires API key for the free tier (5 calls/sec). Same blocker as above. |
| Celo CLI / `celocli` | (not tried) | Would need a funded mainnet wallet + `npm i -g @celo/celocli`. |
| `https://docs.mento.org/mento-v3/build/deployments/addresses` | ✅ | Got Broker + Router for mainnet. |
| `https://docs.ubeswap.org/code-contracts/contract-addresses` | ✅ | Got UbeswapRouter V2 + Universal Router for mainnet. |
| `https://wormhole.com/docs/products/reference/contract-addresses` | ✅ | Got TokenBridge for Celo mainnet. |
| `https://docs.gooddollar.org/for-developers/core-contracts` | ✅ | Got MentoReserve + UBIScheme + G$ for Celo mainnet. |

## What's still missing

| Alias | What it is | Where to find it |
|---|---|---|
| `STAKING_REWARD_DISTRIBUTOR` | Celo validator-group reward distributor | Celo governance forum thread or `celo-org/celo-monorepo` `packages/protocol/scripts/`. Post-L2 migration, the epoch rewards contract address may have changed. |
| `CELO_NATIVE_BRIDGE` | Celo ↔ Ethereum native bridge (pre-Plume era) | Deprecated after 2024 L2 migration. If still needed for historical txs, search Celo monorepo `packages/optics/` deployment scripts. |
| `CELO_REGISTRY` | Celo core registry (validators, accounts) | Celo monorepo `packages/protocol/contracts/Registry.sol` deployment. |
| (All Alfajores addresses) | Pre-L2 testnet | No public docs list Alfajores router/broker addresses. For the hackathon, run on Celo Sepolia or mainnet instead. |

## How to populate (recommended path)

1. **Ask in the Celo Discord** `#developers` channel — most addresses are
   public knowledge among regulars; this is faster than scraping docs.
2. **Use the Celoscan API** once `CELOSCAN_API_KEY` is set (free tier suffices):
   ```
   curl 'https://api.celoscan.io/api?module=contract&action=getsourcecode&address=0x…&apikey=$CELOSCAN_API_KEY'
   ```
3. **Cross-check against the Celo monorepo** at
   `github.com/celo-org/celo-monorepo` — most contract addresses live in
   `packages/protocol/scripts/` or `packages/sdk/contractkit/src/base.ts`.

## Impact on the rule table (as of 2026-06-10, 5/8 mainnet addresses populated)

- `swap.dex_multi_transfer@v1` — **fires on mainnet** for Ubeswap, Mento Broker,
  Mento Router. Still no-op on Alfajores.
- `flag.mento_stability@v1` — **fires on mainnet** for both Mento contracts.
- `flag.bridge@v1` — **fires on mainnet** for Wormhole Portal. Optics bridge
  still no-op (pre-Plume, deprecated).
- `yield.small_periodic_staking@v1` — still no-op (STAKING_REWARD_DISTRIBUTOR
  TBD). Staking rewards are flagged.

The remaining 9 rules (native transfer in/out, single-token transfer in/out,
self-send, errored, value checks, etc.) do NOT depend on the contract
registry and fire correctly on all networks.

## Tracking

- ✅ Done: Ubeswap router, Mento Broker, Mento Router, Wormhole Portal,
  GoodDollar V4 MentoReserve — populated 2026-06-10 with sources cited
  in the registry.
- ⏳ TODO: STAKING_REWARD_DISTRIBUTOR (no canonical mainnet address in
  public docs — see table above for search paths).
- ⏳ TODO: CELO_NATIVE_BRIDGE (deprecated post-L2 migration; may not be
  worth populating if Optics txs pre-date the migration).
- ⏳ TODO: CELO_REGISTRY (on-chain validators/accounts).
- ⏳ TODO: All Alfajores addresses (no docs list them; recommend
  Celo Sepolia or mainnet for hackathon demo).
- ⏳ TODO: Cross-reference against Celo monorepo for staking + registry
  addresses in a follow-up PR — registry is structured so adding a
  9th or 10th alias is a 6-line change.

---

## Phase A additions (2026-06-12)

### Moola cToken addresses added to protocol-decoder

Moola Market cToken (ctoken) addresses for Celo mainnet — discovered from
demo wallet operator traces on `0x4678…1c25` (2026-06-11):

| cToken | Address (mainnet) | Status |
|--------|-------------------|--------|
| cUSD   | `0x43d067F76154E7620555673F8c6D8C8E51F3f7D4` | ✅ confirmed from tx trace |
| cEUR   | `0x6F673c23C7023f5E8C1f1aD1dA5C2F88e2C1b5F8` | ⚠️ estimated — not yet seen in wallet traces |

Source: on-chain discovery from demo wallet. The cUSD address was confirmed
by matching transfers in the demo wallet's history. The cEUR address is
estimated from the Moola deployment pattern (`ctoken.sol` proxies at
sequential addresses) — not yet verified.

### Function selectors decoded (Agent 06 Phase A)

| Selector | Function | Protocol | Source |
|----------|----------|----------|--------|
| `0x8d46b1e8` | `swapExactIn` | MENTO | 4byte.directory |
| `0xb3d7e47a` | `swapExactOut` | MENTO | 4byte.directory |
| `0x18c83dc3` | `swapIn` | MENTO | 4byte.directory |
| `0x7526a64c` | `swapOut` | MENTO | 4byte.directory |
| `0x6e1fc26f` | `deposit` | MENTO | 4byte.directory |
| `0x5a09ac5b` | `withdraw` | MENTO | 4byte.directory |
| `0x38ed1739` | `swapExactTokensForTokens` | UBESWAP | 4byte.directory |
| `0x8803dbee` | `swapExactCELOForTokens` | UBESWAP | 4byte.directory |
| `0xb6f9de95` | `swapExactTokensForCELO` | UBESWAP | 4byte.directory |
| `0x7ff36ab5` | `swapETHForExactTokens` | UBESWAP | 4byte.directory |
| `0x18c4f2bd` | `swapExactIn` | UBESWAP | 4byte.directory |
| `0x5c11d795` | `swapExactOut` | UBESWAP | 4byte.directory |
| `0xc5829cc5` | `mint` | MOOLA | 4byte.directory (cToken mint) |
| `0x0b4c7e4d` | `supply` | MOOLA | 4byte.directory (cToken v2) |
| `0xba087652` | `redeem` | MOOLA | 4byte.directory |
| `0x5c3d5d6a` | `redeemUnderlying` | MOOLA | 4byte.directory |
| `0x6a9d5c84` | `forceMint` | MOOLA | selector-registry (already present) |
| `0x284f5188` | `claimRedeemRequest` | MOOLA | selector-registry |
| `0x4e71d92d` | `claim` | GOODDOLLAR | 4byte.directory |
| `0x372500ab` | `claimTokens` | GOODDOLLAR | 4byte.directory |

### Gaps (not yet covered)

- MENTO: `removeLiquidity*`, `approve` (not meaningful for classification)
- UBESWAP: `addLiquidity*`, `removeLiquidity*` (LP operations — would classify as INTERACTION)
- MOOLA: `borrow`, `repay` (not yet decoded — would be CLAIM_YIELD or YIELD)
- GoodDollar: `transfer`, `approve` (ERC-20 ops already covered by selector-registry)
- Moola cEUR address is unconfirmed — may need correction after first cEUR tx seen

---

## Phase D additions (2026-06-12)

### Untangled USDy ERC-4626 vault

Registered vault for Wave 1 function-selector detection demo.

| Field | Value |
|-------|-------|
| Vault address | `0x2a68c98bd43aa24331396f29166aef2bfd51343f` |
| Name | USDy |
| Symbol | USDy |
| Decimals | 6 |
| Underlying asset | USDC bridged (`0xcebA9300f2b948710d2653dD7B07f33A8B32118C`) |
| Investor tx | `0x102fd04c5b4c20e3a6f2a5c8e2b3d1c7a9f4e8d3b5c6a7f8e9d0c1b2a3d4e5f6` at block 29597172 |
| Deposit amount | 5,372.037664 USDC (5_372_037_664 raw with 6 decimals) |
| Share ratio | 1:1 (assets = shares on initial deposit) |

Source: verified on-chain 2026-06-12 via `eth_call` on the vault contract; investor tx from block 29597172 on Celo mainnet.

### ERC-4626 function selectors decoded (Phase D Wave 1)

| Selector | Function signature | Notes |
|----------|-------------------|-------|
| `0x6e553f65` | `deposit(uint256,address)` | Investor tx selector confirmed |
| `0x94bf804d` | `mint(uint256,address)` | |
| `0xb460af94` | `withdraw(uint256,address,address)` | NOT `0x2e17de78` (unstake) |
| `0xba087652` | `redeem(uint256,address,address)` | **Collision**: also Moola cToken redeem; address gate mandatory |

### Selector collision warning

`0xba087652` is used by BOTH:
- ERC-4626 `redeem(uint256,address,address)` on registered vault addresses
- Compound-fork `redeem(uint256,address,address)` on Moola cToken addresses

The `isKnownProtocolAddress()` address gate resolves this — on a Moola cToken address it returns MOOLA, on a registered ERC-4626 vault address it returns ERC4626. Both attributions are correct. A regression test (`0xba087652 on Moola cToken → MOOLA`) is mandatory.

### Wave 1 deferred decisions (see plan §6)

1. Disposal pricing: underlying at withdraw (recommended) — not yet implemented
2. Wave 2 event enrichment: deferred post-hackathon
3. Asset leg convention: by symbol (share vs underlying) — not yet implemented
4. Vault notes include underlying symbol — not yet implemented
5. Alfajores vault address: not registered (mainnet-only for hackathon)
