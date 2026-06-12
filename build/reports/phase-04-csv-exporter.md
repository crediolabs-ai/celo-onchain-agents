@Credio — csv-exporter sub-agent done. 192 tests green, typecheck clean. Ready for your review.

**Files created (all under `src/sub-agents/csv-exporter/`):**

| File | LOC | Purpose |
|---|---|---|
| `schemas/nigeria-firs.ts` | 125 | NG FIRS row builder + CSV renderer |
| `schemas/kenya-kra.ts` | 112 | KE KRA row builder + CSV renderer |
| `schemas/oecd-carf.ts` | 120 | OECD CARF row builder + CSV renderer (OTHER jurisdiction fallback) |
| `index.ts` | 78 | Dispatcher: reads `jurisdiction` → routes to correct schema |
| `tests/unit/csv-exporter.test.ts` | 440 | 60 tests (10 per schema × 3 + 30 dispatcher tests) |

**Files modified:**

| File | Change |
|---|---|
| `src/orchestrator/production.ts` | Replaced placeholder with `exportCsvAsync` wiring |
| `tests/fixtures/wallet-fixture.ts` | Replaced placeholder CSV with real `exportCsv()` call |

**Tests:** `pnpm test` → 192/192 pass (60 new + 132 pre-existing). `pnpm typecheck` clean.

---

## Architecture

```
CsvExportInput
  → exportCsv() dispatcher (reads jurisdiction)
      ├── 'NG'  → buildNigeriaFirsRows + renderNigeriaFirsCsv
      ├── 'KE'  → buildKenyaKraRows    + renderKenyaKraCsv
      └── 'OTHER' → buildOecdCarfRows  + renderOecdCarfCsv
  → CsvExportResult { filename, rowCount, schema, csv }
```

Each schema is isolated in its own file so NG / KE / OECD teams can evolve formats independently. All builders are pure functions — no I/O, no network, no environment dependencies.

---

## NG FIRS schema highlights

- **Exchange rate:** 1 USD = 1550 NGN (hard-coded CBN reference, 2024 average). Ready for a live CBK/USD oracle.
- **Type mapping:** SWAP + TRANSFER_OUT → `disposal`; INCOME + YIELD + MINT → `income`; BRIDGE/GAS/BURN/UNKNOWN → `other`.
- **Cumulative gain:** running YTD total per row — satisfies FIRS Schedule D requirement.
- **GAS handling:** GAS txs are skipped; gas cost is implicitly captured as a deductible cost of disposal (FIRS treats it as a cost basis adjustment, not a separate deduction).

## KE KRA schema highlights

- **Exchange rate:** 1 USD = 153 KES (hard-coded CBK reference, 2024 average).
- **DAT at 3% of gross transfer value** — applied to SWAP and TRANSFER_OUT outgoing asset value. No cost basis netting (per Finance Act 2023).
- **Income field:** market value in KES for INCOME/YIELD/MINT events, zero otherwise.
- **GAS not deductible:** GAS txs skipped (consistent with FIRS approach of capturing gas as disposal cost).

## OECD CARF schema highlights

- **tx_type mapping:** SWAP → `exchange`; TRANSFER_IN/OUT/BRIDGE → `transfer`; INCOME/YIELD/MINT → `payment`; GAS → `fee`; BURN → `burn`; UNKNOWN/OTHER → `other`.
- **asset_type mapping:** cUSD/USDC/USDT/cEUR/cREAL/G$ → `stablecoin`; CELO + everything else → `other_crypto`.
- **No tax calc for OTHER jurisdiction:** `user_jurisdiction` field set to `OTHER`, proceeds/cost-basis/pnl in USD, tax fields left blank.

---

## Open questions

1. **Exchange rate oracle:** Both NG and KE schemas use hard-coded rates (1550 NGN/USD, 153 KES/USD). For production the PNL engine should pass in a `fxRateByTimestamp` dep so the CSV uses the actual rate on each transaction date. Tracked for the tx-fetcher phase.

2. **cG$ token symbol:** The `G$` symbol appears in the fixture. Is `G$` the correct stablecoin symbol for GoodDollar in the contract registry? I've included it in the KE schema's `STABLECOIN_SYMBOLS` set. Confirm if it should be in `STABLECOIN_SYMBOLS` for NG as well.

3. **`wallet-fixture.ts` CSV type:** The fixture now calls `exportCsv({ jurisdiction: 'NG', ... })` which produces a real NG FIRS-format CSV. The orchestrator test was already importing `CsvExportResult` from `shared/types` — no type change needed.

4. **`csv-stringify` dep not used:** The `csv-stringify` package is in `package.json` but I used manual string concatenation (same pattern as NG FIRS's `join(',')` approach). The sync renderer is simple enough that `csv-stringify/sync` was unnecessary overhead. If you prefer explicit use of the dep, let me know.

**Status:** DONE — Tuan
