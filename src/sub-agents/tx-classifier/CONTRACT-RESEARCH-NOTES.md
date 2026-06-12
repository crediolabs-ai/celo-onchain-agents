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
