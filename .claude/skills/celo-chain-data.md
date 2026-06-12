---
skill: celo-chain-data
agent: agent-06-celo-tax-portfolio
type: connector-patterns
last_updated: 2026-06-07
sources:
  - Celo documentation (docs.celo.org)
  - Celoscan API documentation
  - CoinGecko API documentation
update_trigger: Update when Celoscan API changes or Celo migrates to full Ethereum equivalence
---

# Skill: Celo Chain Data Patterns

## Purpose

Patterns for fetching and parsing transaction history from Celo using Celoscan API and Celo RPC. Used by Sub-agent 1 (Tx History Fetcher) in Agent 06.

---

## Celoscan API — Key Endpoints

Base URL: `https://api.celoscan.io/api`

**Fetch normal transactions for a wallet**
```
GET ?module=account&action=txlist
    &address={wallet}
    &startblock=0&endblock=99999999
    &page=1&offset=100
    &sort=asc
    &apikey={CELOSCAN_API_KEY}
```

**Fetch ERC-20 token transfers**
```
GET ?module=account&action=tokentx
    &address={wallet}
    &startblock=0&endblock=99999999
    &page=1&offset=100
    &sort=asc
    &apikey={CELOSCAN_API_KEY}
```

**Fetch internal transactions (contract-to-wallet, e.g. yield payouts)**
```
GET ?module=account&action=txlistinternal
    &address={wallet}
    &startblock=0&endblock=99999999
    &page=1&offset=100
    &sort=asc
    &apikey={CELOSCAN_API_KEY}
```

**Pagination**: offset=100 max per request. If result count == 100, fetch next page (increment page=N). Continue until result count < 100.

**Rate limits**: Free tier = 5 calls/sec. For a typical wallet (< 500 txns), 3 API calls suffice. For high-volume wallets, implement exponential backoff.

---

## Celo Native Token Notes

Celo is EVM-compatible but has legacy-specific tokens:

| Token | Contract | Notes |
|-------|---------|-------|
| CELO | Native (was ERC-20 before Ethereum alignment) | Now ETH-equivalent as of Celo's L2 migration |
| cUSD | 0x765DE816845861e75A25fCA122bb6898B8B1282a | Mento stablecoin (USD-pegged) |
| cEUR | 0xD8763CBa276a3738E6DE85b4b3bF5FDed6D6cA73 | Mento stablecoin (EUR-pegged) |
| cREAL | 0xe8537a3d056DA446677B9E9d6c5dB704EaAb4787 | Mento stablecoin (BRL-pegged) |
| USDC (Celo) | 0xcebA9300f2b948710d2653dD7B07f33A8B32118C | Circle bridged USDC on Celo |
| USDT (Celo) | 0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e | Tether on Celo |

---

## Historical Price Data — CoinGecko API

Base URL: `https://api.coingecko.com/api/v3`

**Get historical price for a date**
```
GET /coins/{coin_id}/history?date={dd-mm-yyyy}&localization=false
```

Coin IDs for Celo assets:
- CELO: `celo`
- cUSD: `celo-dollar`
- cEUR: `celo-euro`
- USDC: `usd-coin`
- USDT: `tether`

**Get market chart (range of dates)**
```
GET /coins/{coin_id}/market_chart/range
    ?vs_currency=usd
    &from={unix_timestamp}
    &to={unix_timestamp}
```

**Price lookup strategy:**
1. For each classified transaction, record the Unix timestamp
2. Batch price lookups: group txns by date, fetch daily close price
3. Use daily close as proxy for intraday price (acceptable for tax purposes; note in CSV)
4. Cache prices: avoid re-fetching the same date/asset combination

---

## Celo L2 Migration Note (2024)

Celo migrated from a standalone EVM-compatible chain to an Ethereum L2 (using OP Stack) in Q3 2024. Transaction history pre- and post-migration is accessible via Celoscan. The chain ID changed. For wallets with history spanning both eras:
- Pre-migration txns: Celoscan covers the full history
- Post-migration txns: Celoscan continues to index; no gap in data

ERC-8004 agent wallet standard works on Celo post-migration without modification.

---

## Error Handling

| Error | Action |
|-------|--------|
| Celoscan API returns status=0 | Log error; retry once with backoff; if persistent, skip endpoint |
| CoinGecko 429 (rate limit) | Wait 60 seconds; retry; implement request queue |
| Missing price data for date | Log gap; use nearest available price within 24h; flag in CSV |
| Invalid wallet address | Return error to user immediately; do not proceed |
| Empty transaction history | Return "No transactions found for this wallet on Celo" |

---

## Update Log

| Date | Type | Signal | Source |
|------|------|--------|--------|
| 2026-06-07 | BUILD — Initial connector patterns. Contract addresses for cUSD/cEUR/USDC verified from Celo docs. Celoscan API endpoints standard Etherscan-compatible. CoinGecko free tier sufficient for hackathon. | Internal |
