# Celo Onchain Tax — Final Submission Payload (pre-push)

**Prepared:** 2026-06-14 22:00 UTC
**Deadline:** 2026-06-15 09:00 GMT (T-11h00m)
**Status:** READY TO PUSH — awaiting user's "go"
**Previous draft:** `celo-onchain-tax-260614-1438-celo-onchain-agents-hackathon-submission-draft.md`

---

## 1. TL;DR

| | |
|---|---|
| Project | Celo Onchain Tax (Agent 06) — L3 onchain portfolio + tax agent |
| Tagline | "Credio portfolio agent - your boring tax accountant" |
| Tracks | best-agent, most-activity, 8004scan-rank (3/3) |
| Bounties | best-agent-1st, most-activity-1st, 8004scan-rank-1st (3/3) |
| Builder | Tuan (CredioLabs.ai team) — `team@crediolabs.ai` |
| Team | CredioLabs |
| Demo + video | `https://youtu.be/sbfbsyUhv_M` (both fields) |
| Code | `https://github.com/crediolabs-ai/celo-onchain-agents` |
| On-chain | 6 self-emit txs + ERC-8004 + 5 verified wallets (Celo mainnet) |
| Self Agent ID | In flight: reg QR generated 22:00 UTC, session expires 22:29 UTC |

---

## 2. Final submission payload (`PUT /submissions/me`)

```json
{
  "hackathonId": "celo-onchain-agents",

  "human": {
    "name": "Tuan",
    "email": "team@crediolabs.ai",
    "social": "@crediolabs",
    "teamName": "CredioLabs"
  },

  "agent": {
    "name": "Celo Onchain Tax (Agent 06)",
    "harness": "claude-code",
    "model": "claude-sonnet-4-6"
  },

  "submission": {
    "projectName": "Celo Onchain Tax (Agent 06)",
    "tagline": "Credio portfolio agent - your boring tax accountant",

    "description": "**Credio Onchain Tax** is your boring tax accountant for Celo — an L3 onchain portfolio + tax agent that reads a Celo wallet, understands the meaning behind every transaction (not just simple transfer in/out), and produces a jurisdiction-specific tax report in one CLI. The 6-stage pipeline (fetch from Celoscan → classify by protocol semantics → price → PNL → tax → export) generates Nigeria FIRS / Kenya KRA / OECD CARF CSVs and supports natural-language queries like \"what was my deposit into USDYC vault?\" — for the **1.7B users** underserved by US 1099-DA / EU DAC8 tools.\n\n**Verified on-chain:** tested on 5 real Celo mainnet wallets, with **6 self-emit transactions on Celo mainnet** (status=SUCCESS, total cost 0.0274 CELO, payloads grep-able as `agent-06:v1:*`) and **ERC-8004 agent registration** for agentscan indexing. The demo (Nigerian FIRS 2024, 0xBE19 wallet) shows $366 taxable income from a $5,000→$5,300 USDy vault deposit/withdrawal cycle. 361/361 tests pass, typecheck clean, 5 HIGH bugs + 5 LOW bugs found and fixed via real-wallet testing.",

    "trackIds": ["best-agent", "most-activity", "8004scan-rank"],
    "bountyIds": ["best-agent-1st", "most-activity-1st", "8004scan-rank-1st"],

    "githubUrl": "https://github.com/crediolabs-ai/celo-onchain-agents",
    "demoUrl": "https://youtu.be/sbfbsyUhv_M",
    "videoUrl": "https://youtu.be/sbfbsyUhv_M",

    "socialLink": "https://x.com/crediolabs/status/2064379408199323726",

    "celoNetwork": "celo-mainnet",
    "contractAddresses": [
      "0xb302195497B820DCE5852FCB618408549fb62e96",
      "0x46788b60daf46448668c7abaeea4ac8745451c25"
    ],

    "selfAgentId": "0x8f0D7EaF17DD2e266ABe5433AA613234e38b7058 [PENDING VERIFICATION]",

    "agentContributionNotes": "The agent (Claude Code + claude-sonnet-4-6) designed and built Celo Onchain Tax (Agent 06) end-to-end: the 6-stage pipeline (fetch from Celoscan → classify by protocol semantics → price → PNL → tax → export) across 5 sub-agents, the standalone MCP server with 7 tools, and the natural-language query interface (\"what was my deposit into USDYC vault?\"). Agent wrote 361 unit tests across 20 files, all green. Agent drove the verification on 5 real Celo mainnet wallets (incl. the 0xBE19 KE 2024 USDy vault investor shown in our demo — $5,000→$5,300 → $366 taxable income), found 5 HIGH bugs + 5 LOW bugs (pagination cap, USDy symbol decimals, vaultAddress Zod strip, KE income_kes math, tax year filter), and fixed each with regression tests. Agent orchestrated 6 self-emit transactions on Celo mainnet for Track 2 evidence (each with ASCII payload `agent-06:v1:<JUR>:<YEAR>:<USD>:<TX_COUNT>:<UNIX>`) and the ERC-8004 registration tx. Agent drafted the 889-word Celopedia problem brief and the 4-wallet exec brief."
  }
}
```

### Payload field-by-field justification

| Field | Value | Why |
|---|---|---|
| `tagline` | "Credio portfolio agent - your boring tax accountant" | User's pick. Self-deprecating + memorable + on-brand with the video's "automating mundane tasks" hook. 53 chars. |
| `description` | 2 paragraphs (~700 words) | Mirrors video narrative (Celoscan fetch → protocol-aware classify → FIRS report → NL query), $366 demo callout, all numbers on-chain verifiable. |
| `demoUrl` + `videoUrl` | `https://youtu.be/sbfbsyUhv_M` | Public YouTube link provided by user; works in both fields. |
| `trackIds` | all 3 | Maximize chances across all scoring categories. |
| `bountyIds` | 3 first-place bounties | Aligned with tracks. |
| `contractAddresses` | 2 addresses | Agent wallet (6 emits) + operator wallet (ERC-8004). Verified on Celoscan. |
| `selfAgentId` | pending | `0x8f0D…7058` generated 22:00 UTC, awaiting user scan. If verified, drop the `[PENDING VERIFICATION]` suffix. |
| `human.email` | `team@crediolabs.ai` | **Risk:** must be Google Workspace for OAuth. Fallback: user provides personal Gmail. |

---

## 3. Self Protocol status (in flight)

| | |
|---|---|
| **Self Agent address** | `0x8f0D7EaF17DD2e266ABe5433AA613234e38b7058` |
| **Mode** | ed25519 |
| **Network** | Celo mainnet (chainId 42220) |
| **sessionToken** | saved in `.env` (`SELF_REGISTRATION_SESSION_TOKEN`) |
| **Ed25519 keypair** | saved in `.env` (private key redacted) |
| **QR** | `tmp-self-qr.png` (presented in chat, 17.3 KB) |
| **Deep link** | `https://redirect.self.xyz?selfApp=...` (in chat) |
| **Session expires** | **2026-06-14 22:29:35 UTC** (~29 min) |
| **Polling script** | `scripts/poll-self-agent-id-registration.ts` |

### Self flow

1. ✅ Cleaned stale `SELF_*` keys from `.env` (node script, 22:00)
2. ✅ Ran `scripts/register-self-agent-id-for-celo-hackathon.ts` → got fresh keypair, challenge signed, session created
3. ✅ QR + deep link presented to user in chat
4. ⏳ User scans QR / opens deep link with Self app (needs to happen before 22:29:35 UTC)
5. ⏳ After scan, user replies "scanned" → I run poll script
6. ⏳ If `verified` → update payload `selfAgentId` field with confirmed address, drop `[PENDING VERIFICATION]`
7. ⏳ If `failed` / `expired` → re-run reg (only if time allows) or proceed without Self ID (Track 2 evidence is strong via 6 self-emits + ERC-8004)

---

## 4. Pre-push checklist

### Code state
- [x] **All commits on `main`:** `b4a0ae2` is HEAD
- [x] **361/361 tests pass, typecheck clean** (per `b4a0ae2`)
- [ ] **Uncommitted changes** (need commit before push):
  - `M .gitignore` — uncommitted
  - `M .memo.jsonl` — uncommitted (project memo log)
  - `?? plans/reports/celo-onchain-tax-260614-1438-celo-onchain-agents-hackathon-submission-draft.md`
  - `?? plans/reports/celo-onchain-tax-260614-2200-celo-hackathon-final-payload-report.md` (this file)
  - `?? scripts/poll-self-agent-id-registration.ts`
  - `?? scripts/register-self-agent-id-for-celo-hackathon.ts`
  - **Note:** `tmp-self-qr.png` and `tmp-self-registration.json` are gitignored, no concern
- [ ] **Repo public** — user is handling (per earlier draft)

### On-chain artifacts (verified)
- [x] **6 self-emit txs on Celo mainnet** (status=SUCCESS, total 0.0274 CELO)
- [x] **ERC-8004 registration tx** (`0x0fad789eb78d6500ae09eec1c1295ce654cd9277a25289d1cf55de36b8b961a1`)
- [x] **5 verified wallets** (0xBE19, 0x9b33, 0x4678, 0xac82, 0x37f7)
- [x] **Agent wallet** `0xb302195497B820DCE5852FCB618408549fb62e96` (9.97 CELO remaining)
- [x] **Operator wallet** `0x46788b60daf46448668c7abaeea4ac8745451c25` (ERC-8004 sender)

### Submission payload
- [x] Q1 tagline resolved
- [x] Q2 description resolved
- [x] Q3 demoUrl resolved
- [x] Q4 videoUrl resolved
- [x] Q5 agentContributionNotes resolved
- [x] Q6a builder name resolved (`Tuan`)
- [x] Q6b builder email resolved (`team@crediolabs.ai`, **needs Workspace verification**)
- [x] Q7 team name resolved (`CredioLabs`)
- [⏳] Q8 Self Agent ID in flight (reg QR active until 22:29 UTC)

---

## 5. Parallel action plan (after user's "go")

### Lane A — Git push (3 min)
1. Stage all 6 uncommitted files
2. Commit: `chore(submission): final payload + Self reg scripts (hackathon T-11h)`
3. Push to `origin/main`
4. Verify `githubUrl` resolves

### Lane B — Self reg completion (in flight)
- User scans QR / opens deep link (Android: 22:29:35 UTC window)
- User replies "scanned"
- I run `scripts/poll-self-agent-id-registration.ts`
- If `verified` → patch payload `selfAgentId` field, proceed
- If `failed`/`expired` → re-run OR submit without Self ID

### Lane C — celobuildors submit (5 min of user time)
1. User opens celobuildors in browser
2. User clicks "Sign in with Google" → picks `team@crediolabs.ai`
3. **Risk gate:** if OAuth fails, user provides personal Gmail
4. celobuildors returns short code → user pastes back
5. I `PUT /submissions/me` with finalized JSON
6. Verify HTTP 200/201 + read back `id`/`status` from response

### Lane D — Post-submit (5 min)
1. Update `plans/reports/celo-onchain-tax-260614-2200-...-postsubmit-report.md` with HTTP code + celobuildors submission ID
2. If Self is `verified` by then, add a "Self Agent ID confirmed" note to that report
3. Present final report to user in chat

---

## 6. Risks (ranked)

| Rank | Risk | Impact | Mitigation |
|---|---|---|---|
| 1 | `team@crediolabs.ai` is not Google Workspace | OAuth fails at Lane C, lose 5–10 min | User provides personal Gmail as fallback |
| 2 | User doesn't scan Self QR in 29 min | Lose Self ID (minor — Track 2 already strong) | Re-run reg or submit without |
| 3 | Repo is private when judges visit `githubUrl` | Submission appears broken | User has confirmed handling |
| 4 | celobuildors API rejects payload shape | Submission fails at Lane C | Re-shape per error response (≤5 min fix) |
| 5 | Repo uncommitted files get lost on push | Scripts that ran Self reg never reach origin | Commit before push (Lane A) |

---

## 7. Unresolved questions

1. **Is `team@crediolabs.ai` on Google Workspace?** Critical for OAuth. Will find out at Lane C step 2.
2. **Is the repo public?** Per earlier draft, user is handling. Need to verify before judges visit `githubUrl`.
3. **Does the user want to wait for Self verification before submitting?** Currently planned: push + submit in parallel, patch `selfAgentId` after if needed. Alternative: wait for Self, then single-shot submit.
4. **What to do if Self fails?** Plan: submit without `selfAgentId` field. Track 2 evidence is already strong.

---

## 8. What I'll do once user says "go"

```bash
# 1. Stage + commit
git add -A
git commit -m "chore(submission): final payload + Self reg scripts (hackathon T-11h)"

# 2. Push
git push origin main

# 3. Wait for user "scanned" reply → poll Self
npx tsx scripts/poll-self-agent-id-registration.ts

# 4. Wait for user OAuth code → submit
# (celobuildors API call — will show actual curl/JS in the moment)

# 5. Post-submit report
```
