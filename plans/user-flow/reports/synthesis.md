# User-flow verification — synthesis

**Date:** 2026-06-11
**Lead:** Credio
**Reviewer:** Tuan (session `825fd89a-8be9-4b76-b46e-4f2e42d4170b`)
**Source report:** [`verification-report.md`](verification-report.md)

## TL;DR

Tuan's verdict: **APPROVE-WITH-FIXES** — 3 actionable bugs (2 critical, 1 major) + 1 nit, all verified by lead. Plus 6 items confirmed-correct via live exec.

## Verified findings

| # | Sev | Finding | Evidence | Files affected |
|---|-----|---------|----------|----------------|
| 1 | 🔴 | Script checks `wallets/agent.json`; real file is `agent-06.json` | `ls wallets/` → only `agent-06.json` exists | `user-flow-script.sh:75` |
| 2 | 🔴 | `pnpm wallet:generate` is just `console.log` — doesn't write file or `.env` | `scripts/generate-wallet.ts:16` | `user-flow.md:25`, `README.md:30-33`, `user-flow-script.sh:75,79` |
| 3 | 🟡 | Stage 7 iterates 7 flags (missing `--output`) but claims "all 8" | script line 142 lists 7; `src/cli/index.ts:48-55` defines 8 | `user-flow-script.sh:142-153` |
| 4 | 🟢 | `DEMO_ADDR=0x...A6` labeled "# fixture wallet"; real fixture is `0x...abc` | `tests/fixtures/wallet-fixture.ts` head | `user-flow-script.sh:14` |

## Confirmed correct (live-verified by Tuan)

- `pnpm demo --mode=rules|pnl|ask` emits `Sub-agent 1/3|2/3|3/3` markers (`src/cli/demo.ts:244,283,350`)
- Env var names: `CELOSCAN_API_KEY`, `AGENT_WALLET_PRIVATE_KEY`, `ANTHROPIC_API_KEY` (cross-checked `.env.example` + `src/shared/config.ts:39-40`)
- CSV header check `grep -qi "transaction\|date\|amount"` matches `tx_date,type,asset,amount,...` in `nigeria-firs.ts:168-178`
- `formatResult` outputs `## NL answer` (stage 6 marker correct, `src/cli/index.ts:137`)
- Lint pre-existing error at `coingecko.ts:143` — script's "pass" annotation accurate

## Root cause for finding #2

`src/shared/config.ts:39-40,88-92,107-108` reads `AGENT_WALLET_*` from env, NOT from `wallets/agent-06.json`. So:
- `wallets/agent-06.json` = committed **record** (public data, private key in `.env` only via `.gitignore`)
- `.env` = **source of truth** for the running app
- `pnpm wallet:generate` = ergonomic helper that **prints to stdout** for the user to copy into `.env`

The README + user-flow doc imply the file is written automatically. It isn't. This is a **doc/code mismatch**, not a runtime bug — the app works because `.env` is hand-edited (see Tuan's memory `wallet-generate-no-file.md`).

## Recommended actions (3 options, in order of effort)

| Option | Effort | What changes | Trade-off |
|--------|--------|--------------|-----------|
| **A. Fix docs only** | ~5 min | Update `user-flow-script.sh` (rename + flag loop) + `user-flow.md` (correct wallet step) + `README.md:30-33` (correct quickstart) | Aligns docs with reality. Doesn't fix the ergonomic problem. |
| **B. Fix everything** | ~30 min | A + add `fs.writeFile` to `scripts/generate-wallet.ts` + append `AGENT_WALLET_*` to `.env` idempotently | Aligns code with docs. Requires re-test of the generator. Risky if user has uncommitted `.env` changes. |
| **C. Defer** | 0 min | Submit as-is. Tuan's findings stay in the report. | Saves time. Submission is unaffected (no judge runs `pnpm wallet:generate`). But leaves a known doc rot. |

**User chose: B** (2026-06-11).

### Implementation log (option B)

| Step | File | Change | Verified |
|------|------|--------|----------|
| 1 | `scripts/generate-wallet.ts` | Added `fs.writeFile` for `wallets/agent-06.json` (no private key) + idempotent `.env` update for `AGENT_WALLET_PRIVATE_KEY` and `AGENT_WALLET_ADDRESS` | Generator runs, output is well-formed, address matches between file and `.env`, typecheck clean |
| 2 | `plans/user-flow/user-flow-script.sh` | 3 fixes: `agent.json` → `agent-06.json` (line 75), added `--output` to flag loop (line 142), fixed `DEMO_ADDR` comment (line 14) | (Tuan re-verification not run; static-only) |
| 3 | `plans/user-flow/user-flow.md` | Step 3: filename `agent.json` → `agent-06.json`; claim now matches reality | (no test needed — doc edit) |
| 4 | `README.md:30-33` | Added clarifying comment "writes wallets/agent-06.json + updates .env" | (no test needed — doc edit) |

### Generator test transcript

- Backed up `.env` and `wallets/agent-06.json` to `/tmp/`.
- Ran `pnpm wallet:generate`. New address `0x7d2c...` written to both files. Private key in `.env` only; `wallets/agent-06.json` is public-safe (no `privateKey` field).
- Ran `pnpm typecheck` — clean.
- Restored backups. `diff` confirms original `0x0F5d...` identity (registered ERC-8004 agent) intact.

## Open questions

1. Is the wallet generation flow a real user-facing concern, or is it a developer one-time setup that we can leave manual? (My read: developer, one-time. README's step 3 is for the integrator, not the end-user.)
2. Should I update the README's quickstart to reflect the manual-copy reality, or leave the README aspirational?

## Next steps

- Awaiting user pick (A / B / C).
- After fix, re-run the affected script stages manually to confirm green.
- Consider saving a follow-up memory if A is picked ("user-flow-known-issues" with the 4 fixed items + their root causes).

**Status:** DONE_WITH_CONCERNS
**Summary:** Verification caught 3 real bugs in lead's design artifacts. All 3 are doc/code mismatches, not runtime bugs. App is still demo-ready. Awaiting user scope pick.
