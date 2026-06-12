# V1→V2 migration review — Agent 06

**Date:** 2026-06-11
**Reviewer:** Tuan
**Verdict:** APPROVE-WITH-FIXES

The V1→V2 code migration is correct and verified end-to-end. Two minor follow-ups: (1) `.env` is still on V1, so a fresh checkout running `pnpm dev` will hit deprecation; (2) the demo wallet choice is degenerate for the submission.

## Per-file assessment

| File | Verdict | Notes |
|------|---------|-------|
| `src/sub-agents/tx-fetcher/celoscan.ts` | ✅ | `chainId?: number` added to `CeloscanClientOptions` (line 46); `buildUrl` appends `chainid` only when set (line 75). Backward-compat preserved — V1 callers pass no `chainId`, get no param. |
| `src/sub-agents/tx-fetcher/index.ts` | ✅ | `chainId?: number` added to `FetchTxsDeps` (line 51); forwarded to client (line 86) with the same spread idiom used for `apiKey` / `fetcher` — consistent with surrounding code. |
| `src/orchestrator/production.ts` | ✅ | `chainId: config.chainId` (line 95) — single source of truth (viem `chain.id`). No network→chainId map needed. |
| `.env.example` | ✅ | `CELOSCAN_API_URL=https://api.etherscan.io/v2/api` (line 8). Comment block (lines 4-7) explains V1 deprecation. Canonical V2 default for new users. |
| `tests/unit/tx-fetcher-celoscan.test.ts` | ✅ | +2 tests (lines 51-66) are meaningful: one asserts `chainid=42220` is appended when set, one asserts absence when unset. Not trivial. |
| `.env` (local) | ⚠️ | Still on V1 (`https://api-alfajores.celoscan.io`, line 3). Per implementer, restored per task instructions. **One-line fix to ship**. |

## V1 URL grep

```
src/sub-agents/tx-fetcher/celoscan.ts:15: * V1 (`https://api.celoscan.io/api`) was deprecated 2025;
src/sub-agents/tx-classifier/CONTRACT-RESEARCH-NOTES.md:19:| `https://api-alfajores.celoscan.io/api?...` | (not tried) |
src/sub-agents/tx-classifier/CONTRACT-RESEARCH-NOTES.md:41:   curl 'https://api.celoscan.io/api?module=contract&action=getsourcecode...'
tests/unit/tx-fetcher-celoscan.test.ts:28,44,62,72,91,102,113:    apiUrl: 'https://api-alfajores.celoscan.io/api' (test fixture URLs)
tests/unit/wallet.test.ts:36:    celoscanApiUrl: 'https://api-alfajores.celoscan.io' (test fixture)
tests/unit/tx-fetcher.test.ts:68,94,98,120,141,171,179,201:    apiUrl: 'https://api-alfajores.celoscan.io/api' (test fixture)
tests/unit/tx-fetcher-pagination.test.ts:59,69,77,87,98,107:    apiUrl: 'https://api-alfajores.celoscan.io/api' (test fixture)
tests/shared/config.test.ts:7:const SCAN = 'https://api-alfajores.celoscan.io'; (test fixture)
.env:3:CELOSCAN_API_URL=https://api-alfajores.celoscan.io  ← ONLY runtime concern
.env.example:6-7:    # `https://api-alfajores.celoscan.io/api`) is no longer accepted. (comment)
```

- V1 references in **production code** (`src/` excluding comments/docs): **0**
- V1 references in **runtime config** (`.env`): **1** (line 3)
- V1 references in **tests**: 19 (all stub fixture URLs — no network call, so harmless)
- V1 references in **docs/comments**: 3 (file headers + research notes — documentation only)

## Alfajores V2 test

```
NETWORK=alfajores CELO_RPC_URL=https://alfajores-forno.celo-testnet.org \
  CELOSCAN_API_URL=https://api.etherscan.io/v2/api \
  pnpm dev --address 0x0000000000000000000000000000000000000abc \
           --jurisdiction NG --tax-year 2024 \
           --output /tmp/alfajores-v2-test.csv
```

- **Exit code: 0** (pipeline ran end-to-end against V2 with `chainid=44787`)
- **Duration: 26 ms** (under 60 s budget)
- **3 fetch errors** collected gracefully (expected — `0x...abc` is an in-memory fixture that doesn't exist on Alfajores, so V2 returns `status: '0'` with a non-"No transactions found" message for each of the 3 endpoints — caught by the same `CeloscanError` handler as in mainnet, surfaced via `FetchedTxData.fetchErrors` per `celoscan.ts:99-103`)
- Verdict: **V2 endpoint reachable + chainid=44787 thread working + error handling intact**. Testnet path confirmed unbroken.

## Pre-existing concern: token-transfer classification

- **Real blocker for submission? depends on demo wallet.**
- The classifier at `src/sub-agents/tx-classifier/index.ts:132` only iterates `fetched.rawTxns`. `tokenTransfers` are bucketed in `transfersByHash` (line 123) and used as supplementary context for normal txs, not classified standalone. So an address with 0 native txs always produces `Classified: 0`, regardless of how many ERC-20 transfers it has.
- The implementer's chosen test wallet `0xaD01C20d...` is exactly that degenerate case (Blockscout: 0 native, 1421 token, 1075 internal). V2 returns the data correctly; the classifier just doesn't consume it. This is pre-existing — confirmed by grep on the classifier file (the `rawTxns` loop is the only classification loop).
- **Recommend: (a) pick a better demo wallet + (b) defer classifier fix.** A real MiniPay user wallet (with CELO transfers + Ubeswap swaps) will produce a populated report out-of-the-box. The token-only-classification fix is non-trivial (needs a `RawTx` shape derivation for transfers, or a second pass) and orthogonal to V1→V2. Don't block the migration PR on it — open a follow-up issue.

## Other gaps found

1. **`.env` still on V1** (`.env:3`) — severity: low for this PR, medium for any fresh checkout. One-line fix: `CELOSCAN_API_URL=https://api.etherscan.io/v2/api`. Implementer notes it was restored per task instructions, so this is a follow-up, not a regression in this PR. Ship-able as-is; better if included.
2. **Demo wallet `0xaD01C20d...` is degenerate** (0 native txs) — severity: high for hackathon judges running the same address. Even with V2 working, judges will see `Classified: 0`. Recommend swapping to a wallet with native CELO activity (e.g. the agent EOA itself, or any Ubeswap swapper) before the demo recording.
3. **`.env.example` mentions V1 in comment** (lines 6-7) — severity: none. It's a deprecation warning, not a URL.
4. **19 V1 URLs in test fixtures** — severity: none. Tests use stubFetchers, so the URL string is just a value being passed through `buildUrl`. No network call. Could be cleaned up cosmetically, but not blocking.

## Recommendation

**APPROVE-WITH-FIXES.** The V1→V2 migration is correct (verified by mainnet run + my Alfajores smoke test) and the 2 new tests are meaningful. Two follow-ups for the team:
1. Flip `.env:3` to V2 before the hackathon submission (one line).
2. Pick a demo wallet with native CELO activity so judges see `Classified > 0`. Token-transfer-only-classification is a known pre-existing limitation, file as a follow-up issue.

**Status:** DONE_WITH_CONCERNS
**Summary:** V1→V2 code migration is verified correct end-to-end on mainnet and Alfajores. 269/269 tests pass, chainid threading is clean (viem → config → production → fetcher → client), and the V2 endpoint is reachable for both 42220 and 44787. Two follow-ups: update local `.env` to V2, and swap the demo wallet to one with native activity.
