# celo-onchain-agents

> Agent 06 — L3 Onchain Tax & Portfolio Agent for Celo.
> Built for the **Celo Onchain Agents Hackathon** (deadline 2026-06-15 09:00 GMT).

This is an LLM-augmented on-chain agent that ingests a Celo wallet's full
transaction history, classifies every transaction (income, swap, transfer,
yield, gas, etc.), computes realized + unrealized PNL using FIFO cost basis,
and exports a tax-ready CSV aligned with Nigeria FIRS and Kenya KRA schemas.

## Stack

- **Language**: TypeScript (strict, ESM, NodeNext)
- **Chain client**: [viem](https://viem.sh) — first-class Celo + Alfajores support
- **Validation**: zod at the env + input boundary
- **HTTP**: native `fetch` with retry / rate-limit backoff
- **LLM**: Anthropic SDK (claude-sonnet-4-6 / claude-haiku-4-5)
- **Tests**: vitest

## Quickstart

```bash
# 1. Install
pnpm install   # or npm install

# 2. Configure
cp .env.example .env
# Fill in ANTHROPIC_API_KEY (required for classifier LLM + query interface)
# Fill in CELOSCAN_API_KEY if you have one; free tier works
# AGENT_WALLET_* already populated from wallet generation

# 3. Generate or refresh the agent wallet (writes wallets/agent-06.json + updates .env)
pnpm wallet:generate

# 4. Run a pipeline
pnpm dev --address 0xYourWallet... --jurisdiction NG --tax-year 2025
```

## Repository layout

See `crediolabs-knowledge/.../agent-06-celo-tax-portfolio/build/scaffold-plan.md`
for the full file ownership and interface contract.

```
src/
├── shared/                    # ★ interface contract, env loading, HTTP
├── orchestrator/               # pipeline runner (Credio)
├── sub-agents/
│   ├── tx-fetcher/             # Celoscan (Credio)
│   ├── tx-classifier/          # rules + LLM fallback (Tuan)
│   ├── pnl-calculator/         # FIFO/LIFO/WAC (Credio)
│   ├── csv-exporter/           # NG FIRS + KE KRA (Credio)
│   └── query-interface/        # NL query → answer (Tuan)
├── infra/                      # agent EOA, ERC-8004, log emitter (Credio)
└── cli/                        # commander entrypoint (Credio)
```

## Tracks

We're playing all three:

1. **Best Agent on Celo** — primary, $2.5K / $1K / $500
2. **Most Onchain Activity** — each report = 1 log event onchain
3. **Highest 8004scan rank** — agent registered at [agentscan.info](https://agentscan.info)

## License

UNLICENSED — internal CredioLabs hackathon build.
