# Agent 06 — Demo Video

Remotion-generated demo video for the Celo Onchain Agents Hackathon submission. 60s @ 24fps, 720p, dark Celo-branded theme. Uses actual agent output as data source.

## File output

- `out/agent-06-demo.mp4` — final 720p render (~57.5s after transitions)
- `out/agent-06-demo-smoke.mp4` — 0.3x scale smoke test (verification only)

## Structure

```
src/
├── index.ts                 # Remotion entry
├── Root.tsx                 # Composition registration
├── Agent06Demo.tsx          # Orchestrates 6 scenes via TransitionSeries
├── theme.ts                 # Celo brand colors, fonts, sizes
├── data.ts                  # Hardcoded agent output (from real mainnet run)
└── scenes/
    ├── IntroScene.tsx       # Title + tagline (5s)
    ├── ProblemScene.tsx     # The gap: 15M MiniPay users, FIRS/KRA, no Celo tool (8s)
    ├── CommandScene.tsx     # Animated pnpm dev --address ... (10s)
    ├── StatsScene.tsx       # 4 stat cards with spring counters (15s)
    ├── ResultScene.tsx      # CSV preview + jurisdictions (12s)
    └── OutroScene.tsx       # Try it. Right now. + GitHub/ERC-8004 (10s)
```

## Scripts

```bash
# Studio — interactive dev (preview scenes, tweak)
npm start

# Full render (720p, 24fps, 60s)
npm run build

# Hi-res render (1.5x scale)
npm run build:hi

# Low-res smoke test (0.5x scale, faster for iteration)
npm run build:low
```

## Data source

`src/data.ts` is hardcoded from the real mainnet run on 2026-06-11:
- Address: `0x46788b60daf46448668c7abaeea4ac8745451c25` (ERC-8004 deployer)
- 194 native CELO txs fetched in 1.3s
- 33 classified by rules, 0 LLM fallbacks, 161 flagged for review
- 194 CSV rows in nigeria-firs schema
- 0 fetch errors

To re-run the agent on a different wallet, edit `data.ts` and re-render.

## Deployment notes

- This is a self-contained project (own `node_modules`, `package.json`).
- Not a workspace package (avoids React 18 ↔ 19 conflict with main project).
- Install with `npm install` (NOT `pnpm install` — pnpm would resolve against parent workspace).
- Render time: ~15-25 min on low-spec host at 720p. Use `npm run build:low` for faster iteration.

## Related

- [Main project README](../README.md)
- [Demo wallet memory](../memory/demo-wallet-erc8004-deployer.md)
- [V1→V2 migration report](../plans/mainnet-test/reports/v1-to-v2-migration.md)
