---
skill: nigeria-kenya-crypto-tax
agent: agent-06-celo-tax-portfolio
type: regulatory-domain
last_updated: 2026-06-07
sources:
  - Nigeria FIRS — Guidelines on the Tax Treatment of Digital Assets (2023)
  - Kenya KRA — Tax Laws (Amendment) Act 2023 (Digital Asset Tax)
  - Kenya Finance Act 2022 (income tax treatment of crypto)
  - OECD CARF — Crypto-Asset Reporting Framework (2022, adoption wave 2027)
update_trigger: Update when FIRS or KRA publish revised guidance; update when CARF adoption confirmed for either jurisdiction
---

# Skill: Nigeria and Kenya Crypto Tax Treatment

## Purpose

Encode the specific tax rules for Nigeria and Kenya that the agent applies when generating tax-ready CSV exports and answering jurisdiction-specific queries.

---

## Nigeria — FIRS Digital Asset Tax Treatment

### Applicable rules (as of 2026-06-07)

**Source**: FIRS Information Circular No. 2021/02 and subsequent guidance on digital assets

**Capital Gains Tax (CGT)**
- Rate: **10%** flat rate on gains (Capital Gains Tax Act)
- Trigger: disposal of a digital asset — swap, sale, or transfer for consideration
- Cost basis method: FIFO required by FIRS guidance
- Threshold: No de minimis threshold — all gains reportable
- Losses: Capital losses can offset capital gains in the same tax year; cannot be carried forward
- Gas fees: Treated as transaction costs; deductible against disposal proceeds
- Currency: Report in NGN; use Central Bank of Nigeria (CBN) official rate on the date of transaction

**Income Tax**
- Rate: Personal income tax rates (7.5% to 24% depending on income band) for individuals; 30% for companies
- Trigger: receipt of digital assets as payment for services, employment income, mining, staking, yield
- Valuation: market value in NGN at date of receipt
- PAYE: Employers paying salaries in stablecoins (USDC, cUSD) are technically subject to PAYE obligations; in practice enforcement is limited but risk is real

**Taxable events:**
| Event | Treatment |
|-------|-----------|
| Receiving USDC as salary | Income — ordinary income tax at marginal rate |
| Swapping CELO → cUSD | Disposal — CGT on gain (proceeds minus cost basis) |
| Receiving LP yield rewards | Income — ordinary income at market value on receipt |
| Sending crypto to another wallet you own | Not taxable |
| Receiving crypto as a gift | Income to recipient at market value (if >NGN 100k) |
| Gas fees paid in CELO | Deductible cost against CGT gains |

**Reporting**
- Annual self-assessment return
- Digital asset transactions reported on Schedule D (or equivalent)
- No withholding at source for crypto-to-crypto transactions (self-report)
- FIRS enforcement tightening in 2026: exchanges and VASPs required to report user transactions above ₦5M threshold

**CSV fields required for FIRS reporting:**
- Transaction date
- Type (income/disposal/other)
- Asset name and amount
- NGN value at transaction date (use CBN rate)
- Cost basis in NGN
- Gain or loss in NGN
- Cumulative gain/loss YTD

---

## Kenya — KRA Crypto Tax Treatment

### Applicable rules (as of 2026-06-07)

**Source**: Tax Laws (Amendment) Act 2023; Finance Act 2022 (income tax amendments)

**Digital Asset Tax (DAT)**
- Rate: **3%** of gross transfer value (not gain — gross proceeds)
- Trigger: any transfer of a digital asset
- Applies to: transfers of crypto, NFTs, tokens
- No cost basis deduction — tax is on the full value transferred
- Withholding: Digital marketplaces required to withhold; peer-to-peer and DeFi = self-report
- Effective from: 1 January 2024 (post-Finance Act 2022 commencement)

**Income Tax on Crypto**
- Mining, staking, yield: treated as ordinary income under s.5 of the Income Tax Act
- Rate: Individual — 10% to 35% graduated; Corporation — 30%
- DeFi lending interest received: ordinary income
- Airdrops: ordinary income at market value on receipt

**Capital Gains (note: separate from DAT)**
- Kenya does not have a traditional CGT on crypto disposals — the DAT replaces it
- The 3% DAT applies to the gross transfer value; there is no netting of gains and losses
- This means a loss-making swap still incurs 3% DAT on the outgoing asset value

**Taxable events:**
| Event | Treatment |
|-------|-----------|
| Receiving USDC as salary | Ordinary income — PAYE at marginal rate |
| Swapping CELO → cUSD | DAT — 3% of gross CELO value at swap |
| Receiving LP yield rewards | Ordinary income at market value |
| Sending crypto to another wallet you own | DAT technically applies — interpretation unclear; conservative = apply 3% |
| Gas fees paid | Not deductible under current KRA guidance |

**Reporting**
- Annual income tax return (KRA iTax)
- DAT self-assessment: due by 20th of month following the month of transfer
- KRA enforcement increasing: VASPs required to register and report under Finance Act 2023
- Monthly DAT returns for active traders

**CSV fields required for KRA reporting:**
- Transaction date
- Type (income/transfer/yield)
- Asset name and amount
- KES value at transaction date (use CBK rate)
- Gross transfer value (for DAT)
- 3% DAT due
- Income amount (for income tax)

---

## OECD CARF — Forward Compatibility

The OECD Crypto-Asset Reporting Framework requires participating jurisdictions to collect and exchange information on crypto-asset transactions from 2027. Nigeria and Kenya are not confirmed early adopters but are likely to align given IMF pressure on both countries.

CSV export includes CARF-compatible fields where they overlap with FIRS/KRA requirements:
- Reporting period
- Asset type (CELO, cUSD, USDC = stablecoin; CELO = other crypto-asset)
- Transaction type (per CARF taxonomy: transfer, exchange, payment)
- Gross proceeds and cost basis in reporting currency
- User jurisdiction

---

## Multi-Jurisdiction Handling

The agent defaults to the jurisdiction set at session start. If jurisdiction = OTHER:
- Export uses USD as reporting currency
- Tax treatment fields left blank
- User prompted: "Specify your jurisdiction for tax-specific calculations"

Supported jurisdictions:
- NG (Nigeria) — FIRS rules
- KE (Kenya) — KRA rules
- OTHER — generic CSV, no tax calculations

---

## Update Log

| Date | Type | Signal | Source |
|------|------|--------|--------|
| 2026-06-07 | BUILD — Initial Nigeria FIRS + Kenya KRA rules encoded. CARF forward-compatibility fields included. Both jurisdictions tightening enforcement in 2026 — this is the primary demand driver for the EM angle. Single-source — requires second regulatory source before using in production compliance context. | Internal |
