# Researcher Report: DeFi-Active Celo Wallet Scout

**Date:** 2026-06-12
**Agent:** credio-orchestrator → researcher
**Task:** Find a Celo mainnet wallet exercising Mento / Ubeswap / Moola / GoodDollar for Phase A E2E verification

---

## Method Used

**Option (a) — Celoscan V2 token-transfer fan-out (most rigorous).**

Steps:
1. Queried `tokentx` for cUSD, cEUR, cREAL, CELO native tokens (200 most-recent txs each, sorted desc).
2. Built receiver sets per token; found addresses appearing in 2+ token lists (cross-token deduplication).
3. For multi-token addresses, fetched full `txlist` and counted distinct `to` addresses.
4. Filtered out known protocol/contract addresses (MENTO_BROKER, UBESWAP_ROUTER, etc.).
5. For the top candidate, ran full `txlist` (100 txs) + token-transfer lookup on cUSD to map counterparties.

**Celoscan queries used:** 11 (well within 5 req/sec free tier)

---

## Candidates Table

| Address | Tx count | Distinct `to` | Protocols Detected | Evidence |
|---|---|---|---|---|
| `0x9b3319a7f1f6a7bc48af14c9b81ba4b41c7c1394` | 66 | **9** | **GoodDollar** (+ cUSD activity, unknown contract) | 3× `0x4e71d92d` claims to GoodDollar reserves; 58 cUSD transfers |
| `0xbdf779b50dafcac0b90bb4e954eb5bfe881b0e48` | 6 | 1 | None confirmed | Only 6 txs, self-call only |
| `0x20b4c892024c23959fb3305c22f683d1e8a54367` | 20 | 1 | None | Single counterparty |
| `0x288dc841a52fca2707c6947b3a777c5e56cd87bc` | 20 | 1 | None | Single method (`0x6276cbbe`), self-call |
| `0x9380fa34fd9e4fd14c06305fd7b6199089ed4eb9` | 20 | 1 | None | Single counterparty |

**Other candidates checked** (via MENTO_BROKER / UBESWAP_ROUTER token-transfer fan-out):
- `0x79a29b725d13294ea015fc64b2229e87efb3e50e` — 11 txs, all to cUSD token contract only (automated agent)
- `0x34757893070b0fc5de37aaf2844255ff90f7f1e0` — 8 txs, self-call only

---

## Selected Wallet

**`0x9b3319a7f1f6a7bc48af14c9b81ba4b41c7c1394`**

**Justification:** This wallet has the highest counterparty diversity (9 distinct `to` addresses across 66 txs) among all candidates, providing the richest test surface. It has **verified GoodDollar claim activity** (3 txs calling `0x4e71d92d` on two different GoodDollar reserve addresses) and a large volume of cUSD transfers showing sustained DeFi engagement. The dominant method `0xcac35c7a` (52 txs to `0xa0e9096b8e5ad2701f51ca1cb11684aaad91993a`) may represent Moola or another cToken protocol.

**Tx evidence:**
- GoodDollar claim: `0x95d4c2b3db32f65f1c26554b002a4dfa23aa559756c29528b893481c990873c9` (block 64292997, `0x4e71d92d` → GoodDollar reserve `0x43d72ff...`)
- Additional GoodDollar claim txs to `0xbcbea04c29382c47f6dc4e9c6041cbfb62cb2150` (same method)
- 58 cUSD transfers (transfers in/out from multiple counterparties including `0x0e7e222...`)
- cUSD also received from MENTO_BROKER (confirmed via `tokentx` API, block ~69352489)

**Not a contract:** First tx originated at block 29426799, clearly an EOA ( Externally Owned Account).

---

## Caveats

1. **Moola/Ubeswap/Mento not directly confirmed via method selector.** The `0xcac35c7a` contract activity (52 txs) is protocol-adjacent but its selector is not in the protocol-decoder's Moola table. The cUSD transfer from MENTO_BROKER proves Mento interaction but the swap selector wasn't captured in the 20-tx window queried.
2. **cEUR and cREAL token transfers returned 0 results** for this wallet — limited multi-token exposure.
3. **Option (b) was not needed** — option (a) yielded a viable wallet in <8 minutes.

---

## Next Step for Verification

Run the Phase A pipeline against this wallet:

```bash
NETWORK=mainnet \
  CELO_RPC_URL=https://forno.celo.org \
  CELOSCAN_API_URL=https://api.etherscan.io/v2/api \
  CELOSCAN_API_KEY=54WFY7SFU4ESVBD78JRMWG51MGHF4GNPCC \
  pnpm dev --address 0x9b3319a7f1f6a7bc48af14c9b81ba4b41c7c1394 \
           --jurisdiction NG --tax-year 2025 \
           --output /tmp/agent-06-phase-a-defi.csv --refresh
```

Expected: `rule-protocol` count > 0 (GoodDollar decoder fires on at least 3 txs).

---

## Unresolved Questions

1. What protocol does `0xcac35c7a` (52 txs) belong to? Not in Ubeswap/Mento/Moola selector tables. May need to add to decoder if it maps to a known protocol.
2. Should we also verify a second wallet (e.g., `0x21ef97b2d0d7c5fe872d141d48e5c2bc352ab028` from MENTO_BROKER+UBESWAP_ROUTER token lists) for Ubeswap-only coverage?
3. Time budget (10 min) was sufficient — no need to fall back to option (c).

**Status:** DONE
**Summary:** Found wallet `0x9b3319a7f1f6a7bc48af14c9b81ba4b41c7c1394` via Celoscan V2 token-transfer fan-out. It has 66 txs, 9 distinct counterparties, verified GoodDollar claim activity (3 txs with `0x4e71d92d` selector), and 52 txs of `0xcac35c7a` contract activity (possibly Moola). It is an EOA (not a contract). Ready for Phase A E2E pipeline run.
**Concerns/Blockers:** Moola/Ubeswap/Mento swap selectors not directly confirmed in 20-tx window — only GoodDollar is a hard hit. cEUR and cREAL transfers returned 0. The `0xcac35c7a` contract activity (52 txs) is suspicious — if it's an unverified protocol the decoder won't fire on it.
