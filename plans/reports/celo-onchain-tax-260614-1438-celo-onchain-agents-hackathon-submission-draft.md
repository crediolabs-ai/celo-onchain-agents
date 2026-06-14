# Celo Onchain Agents Hackathon — Submission Draft (for Quan's review)

**Prepared:** 2026-06-14 14:38 UTC
**Deadline:** 2026-06-15 09:00 GMT (T-18h22m)
**Status:** DRAFT — awaiting Quan's "final look" + answers to 8 open questions below

---

## 🎯 1-line summary

Agent 06 (Celo Onchain Tax) — L3 onchain tax & portfolio agent for Celo. Target underserved NG/KE/OECD CARF markets. End-to-end pipeline on 5 verified Celo mainnet wallets. 361/361 tests, typecheck clean, 6 on-chain self-emits verified, ERC-8004 registered.

---

## 📤 Submission payload (`PUT /submissions/me`)

```json
{
  "projectName": "Celo Onchain Tax (Agent 06)",
  "tagline": "[TAGLINE — see Q1]",
  "description": "[DESCRIPTION — see Q2, multi-paragraph]",
  "trackIds": ["best-agent", "most-activity", "8004scan-rank"],
  "bountyIds": ["best-agent-1st", "most-activity-1st", "8004scan-rank-1st"],
  "githubUrl": "https://github.com/crediolabs-ai/celo-onchain-agents",
  "demoUrl": "[DEMO_URL — see Q3]",
  "videoUrl": "[VIDEO_URL — see Q4, optional]",
  "socialLink": "https://x.com/crediolabs/status/2064379408199323726",
  "celoNetwork": "celo-mainnet",
  "contractAddresses": [
    "0xb302195497B820DCE5852FCB618408549fb62e96",
    "0x46788b60daf46448668c7abaeea4ac8745451c25"
  ],
  "agentContributionNotes": "[AGENT_CONTRIBUTION_NOTES — see Q5]"
}
```

---

## 👤 Builder connection payload (`POST /auth/google/start`)

```json
{
  "hackathonId": "celo-onchain-agents",
  "human": {
    "name": "[BUILDER_NAME — see Q6a]",
    "email": "[BUILDER_EMAIL — see Q6b, must be Google account]",
    "social": "@crediolabs",
    "teamName": "CredioLabs"
  },
  "agent": {
    "name": "Celo Onchain Tax (Agent 06)",
    "harness": "claude-code",
    "model": "claude-sonnet-4-6"
  }
}
```

---

## ❓ 8 open questions for Quan / user

### Q1 — Tagline (1 sentence, ≤120 chars)
The hackathon asks for a "one-line tagline". Current placeholder pending decision.

**Options to consider:**
- **A:** "Onchain tax & portfolio agent for Celo — Nigeria FIRS, Kenya KRA, OECD CARF, in one CLI"
- **B:** "Crawls your Celo wallet, classifies every txn, answers 'what's my PNL?' — built for NG/KE tax regimes"
- **C:** "L3 onchain tax & portfolio agent for Celo — 1.7B underserved users across NG, KE, and emerging markets"

Quan: pick A / B / C / your own?

### Q2 — Description (1-2 short paragraphs)

**Suggested (2 paragraphs):**

> **Credio Onchain Tax** is an L3 onchain tax & portfolio agent for Celo. Unlike every other crypto-tax tool that targets US 1099-DA or EU DAC8, Agent 06 targets the underserved **1.7B users** in Nigeria (FIRS 10% CGT, FIFO), Kenya (KRA 3% Digital Asset Tax on gross transfers), and OECD CARF forward-compatible for 2027. The 6-stage pipeline (fetch → classify → price → PNL → tax → export) runs end-to-end on real Celo mainnet wallets, produces jurisdiction-specific CSVs, and exposes 7 MCP tools for downstream integrators.
>
> **Verified on-chain:** Agent 06 has been tested on 5 real Celo mainnet wallets (operator, DeFi user, Untangled USDy vault investor, cross-wallet hub, long-time user), with **6 self-emit transactions on Celo mainnet** (status=SUCCESS, total cost 0.0274 CELO, payloads grep-able as `agent-06:v1:*`) and **ERC-8004 agent registration** for agentscan indexing. 361/361 tests pass, typecheck clean, 5 HIGH bugs + 5 LOW bugs found and fixed via real-wallet testing.

Quan: OK as-is, or edit?

### Q3 — Demo URL (required)
Hackathon wants a URL judges can visit. Options:
- **A:** Use the GitHub repo URL as demo (no separate demo site)
- **B:** Host the agent-06-intro-2026-06-13.mp4 video on a public page
- **C:** Skip this field (if celobuilders submission allows it) — **note: README says demoUrl is required**

If A: leave as `https://github.com/crediolabs-ai/celo-onchain-agents` (after making public). If B: need a YouTube/Vimeo URL.

### Q4 — Video URL (optional)
We have `plans/reports/agent-06-intro-2026-06-13.mp4` (1080p, 3.9MB) in the repo. Judges would need to either:
- Download from GitHub (clunky)
- View via a hosted URL (cleaner)

**Options:**
- **A:** Upload to YouTube (unlisted) → use that URL
- **B:** Skip videoUrl (it's optional)
- **C:** Use raw GitHub URL `https://github.com/crediolabs-ai/celo-onchain-agents/blob/main/plans/reports/agent-06-intro-2026-06-13.mp4` (download-only, not embedded)

### Q5 — agentContributionNotes (1-2 paragraphs, freeform)
"What did the agent help build?" Need to summarize the agent's work on this project.

**Suggested:**

> The agent (Claude Code + claude-sonnet-4-6) designed and implemented the full 6-stage pipeline (fetch → classify → price → PNL → tax → export) across 5 sub-agents, plus the standalone MCP server with 7 tools. Agent wrote 361 unit tests across 20 files, all passing. Agent drove the verification on 5 real Celo mainnet wallets, found 5 HIGH bugs + 5 LOW bugs (pagination cap, USDy symbol decimals, vaultAddress Zod strip, KE income_kes math, tax year filter), and fixed each with regression tests. Agent orchestrated 6 self-emit transactions on Celo mainnet for Track 2 evidence (each with ASCII payload `agent-06:v1:<JUR>:<YEAR>:<USD>:<TX_COUNT>:<UNIX>`), and the ERC-8004 registration tx. Agent drafted the 889-word Celopedia problem brief and the 4-wallet comparison in the Quan exec brief.

Quan: OK as-is, or tighten?

### Q6 — Builder info
- **Q6a (name):** Quan Le? Or a different builder name?
- **Q6b (email):** Must be a Google account (for OAuth sign-in). What's the email?

### Q7 — Team name
Currently set to `CredioLabs`. Confirm or change.

### Q8 — Self Agent ID (only if Quan picked option A earlier)
If Quan decided to do Self registration, we'll need to add the agent's Self ID here. If skip, leave as is.

**Currently NOT in the payload** because celobuilders' metadata.submissionFields only has `socialLink` as required. Self ID is mentioned in the description instead.

---

## ✅ Filled-in / confirmed values (no need to re-ask)

| Field | Value | Source |
|---|---|---|
| `hackathonId` | `0bb95497-9b1d-4f30-9c86-cb174ca1a993` (slug `celo-onchain-agents`) | celobuilders API |
| `trackIds` | `["best-agent", "most-activity", "8004scan-rank"]` | celobuilders /tracks |
| `bountyIds` | `["best-agent-1st", "most-activity-1st", "8004scan-rank-1st"]` | celobuilders /bounties |
| `socialLink` | `https://x.com/crediolabs/status/2064379408199323726` | Tweet verified ✓ |
| `celoNetwork` | `celo-mainnet` | Agent 06 runs on mainnet (chainId 42220) |
| `contractAddresses` | `0xb302195497B820DCE5852FCB618408549fb62e96` (agent wallet, 6 emits) + `0x46788b60daf46448668c7abaeea4ac8745451c25` (operator, ERC-8004) | Verified on Celoscan |
| `agent.harness` | `claude-code` | This session |
| `agent.model` | `claude-sonnet-4-6` | Default model per README |
| `human.social` | `@crediolabs` | Tweet handle |
| `agent.name` | `Celo Onchain Tax (Agent 06)` | From README |

---

## 📊 Verification artifacts (referenced in description, not in JSON)

- **6 on-chain self-emits:** `0xdbe3376b…cb18`, `0xad4ddd2b…57c1`, `0xf870702e…aab1`, `0x82205151…6697`, `0x07b07936…5a29`, `0xd9f50b22…cdfb` (all on Celo mainnet, status=SUCCESS, block 69,624,562+)
- **ERC-8004 registration:** `0x0fad789eb78d6500ae09eec1c1295ce654cd9277a25289d1cf55de36b8b961a1` (from `0x4678…1c25`)
- **Vault deposit evidence:** `0x102fd04c…8f7e` (0xBE19 KE 2024)
- **5 verified wallets:** `0xBE19…077c` (KE investor), `0x9b33…1394` (NG DeFi), `0x4678…1c25` (operator), `0xac82…4096` (cross-wallet), `0x37f7…f5cad` (long-time user)
- **Agent wallet:** `0xb302195497B820DCE5852FCB618408549fb62e96` (9.97 CELO remaining, ~2000 emits buffer)

---

## 📂 Reports in repo (all on `origin/main`)

- `plans/reports/celo-onchain-tax-260614-1245-ke-2024-0xBE19-roundtrip-retest-report.md` (yields roundtrip verified)
- `plans/reports/celo-onchain-tax-260614-1120-tier1-bugs-batch-verify-report.md` (4 Tier 1 bugs fixed)
- `plans/reports/celo-onchain-tax-260614-0945-ke-2024-0xBE19-374-yield-agent-fix-verify-report.md`
- `plans/reports/celo-onchain-tax-260614-0900-ke-2024-0xBE19-interest-fix-verify-report.md`
- `plans/reports/celo-onchain-tax-260613-1245-ke-2024-0xBE19-wave3-verify-report.md`
- `plans/reports/celo-onchain-tax-260613-0809-oecd-carf-2024-report.md`
- `plans/reports/agent-06-quan-submission-brief-260613-1940-report.md` (exec brief)
- `plans/reports/celopedia-260613-1742-agent-06-problem-brief.md` (889 words)

---

## ⚠️ Blockers before publish

1. **githubUrl visibility** — repo must be public for `https://github.com/crediolabs-ai/celo-onchain-agents` to resolve (user is handling)
2. **Q1–Q7** need answers (above)
3. **Google sign-in** — user needs to complete OAuth flow in browser (celobuilders will return a short code to paste back)
4. **Self Agent ID** — only if Quan chose option A (still pending)

---

**Status:** DRAFT — ready for Quan's review of Q1–Q7. Once answered, the JSON above is ready to send.
