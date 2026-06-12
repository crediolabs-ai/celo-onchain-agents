# Agent 06 — User Flow

**Owner:** Credio (lead)
**Date:** 2026-06-11
**Purpose:** Specify the end-to-end user journey (today's CLI + vision's MiniPay), express it as a runnable script, and surface gaps before Celopedia submission.

---

## Personas

| Persona | Context | Today | Vision (2027) |
|---------|---------|-------|---------------|
| **MiniPay user** (NG/KE) | Holds cUSD/cEUR in MiniPay. Needs tax compliance | Cannot use (no UI) | In-wallet "Tax" tab |
| **Developer / integrator** | Wants to test the agent on a wallet | CLI works | Same CLI; UI calls it via API |
| **Hackathon judge** | Evaluates real utility + onchain activity | Reads README, runs `pnpm demo` | Same — plus a recorded demo |

---

## Today's flow (CLI, dev-facing)

The full journey a developer walks to get from `git clone` to "I have a tax CSV":

1. **Install + verify deps** — `pnpm install`, `pnpm typecheck`, `pnpm test` (267 green).
2. **Configure env** — `cp .env.example .env`, fill `ANTHROPIC_API_KEY` + `CELOSCAN_API_KEY`.
3. **Generate agent wallet** — `pnpm wallet:generate` (writes `wallets/agent-06.json` + updates `.env` with `AGENT_WALLET_PRIVATE_KEY` / `AGENT_WALLET_ADDRESS`).
4. **Smoke-test the fixture demo** — `pnpm demo --mode=all` exercises 3 sub-agents (classifier, PNL, NL-query) against `tests/fixtures/wallet-fixture.ts`. No RPC, no API key required.
5. **Run the real pipeline on a target wallet** — `pnpm dev --address 0x... --jurisdiction NG --tax-year 2025`. Fetches from Celoscan, classifies, computes PNL, writes CSV, prints markdown summary.
6. **Ask a natural-language question** — append `--nl-query "What's my realized PNL YTD?"` to the same command. LLM translates to intent, runs the relevant sub-routine, returns cited answer.
7. **Optionally emit onchain log** — append `--emit-onchain-log`. Agent sends a 0-value self-tx with ASCII payload `agent-06:v1:JUR:YEAR:USD:TX_COUNT:UNIX`. Counts toward Track 2 (Most Onchain Activity).
8. **Refresh cache** — append `--refresh` to bypass the tx-fetcher file cache.

Total commands a developer types: **~6** (one shell session).

---

## Vision flow (MiniPay, 2027 — not building now, specifying for context)

1. Open MiniPay → tap **Tax** tab.
2. Tap **Generate 2025 tax report**.
3. MiniPay background task calls the agent API with `address = me`, `jurisdiction = detected from locale`, `taxYear = 2025`.
4. App shows progress: "Fetching transactions…", "Classifying…", "Computing PNL…".
5. Result card: **"You owe ₦X in capital gains tax + 3% DAT on ₦Y transfers."** With breakdown chart.
6. Tap **Ask anything** → chat: *"Why is my gas so high?"* → agent answers with cited tx hashes.
7. Tap **Download FIRS CSV** → emailed to registered address, also in-app under **Documents**.
8. Auto-monthly: notification *"Your June report is ready"*.

---

## Mapping: vision → today

| Vision step | Today's CLI equivalent |
|-------------|------------------------|
| Tap "Generate report" | `pnpm dev --address 0x... --jurisdiction NG --tax-year 2025` |
| Progress indicators | (none — CLI prints markdown summary when done) |
| Result card | Markdown summary printed to stdout (year summary block) |
| "Ask anything" | `--nl-query "..."` on same command |
| Download FIRS CSV | `--output ./report.csv` |
| Auto-monthly | (none — cron + push deferred) |

---

## What's NOT in the flow (deliberate gaps)

- **No user account / auth** — CLI takes a wallet address; the user is whoever holds the private key. MiniPay auth will come from the wallet itself.
- **No price-gating** — Agent 06 is free during hackathon. Pro tier ($5/mo) + API tier (pay-per-call) post-hackathon per README.
- **No real-time updates** — Pipeline is one-shot. Streaming is out of scope.
- **No multi-currency fiat** — USD only in PNL output. NGN/KES conversion at year-end is post-hackathon.
- **No multi-year report** — One `--tax-year` per run. Loop in shell if needed.
- **No dispute / amendment flow** — CSV is final. No way to mark a tx as "reviewed, accept classification".

---

## Verification script

See `user-flow-script.sh` — bash that walks the CLI flow stage-by-stage, prints pass/fail per stage, and exits non-zero if any stage fails. Designed to be:
- **Idempotent** — safe to re-run
- **Independent** — each stage is runnable standalone
- **Fast** — prefers `pnpm demo` (no network) over `pnpm dev` (RPC)
- **Honest** — distinguishes "I haven't run this" from "this failed"
