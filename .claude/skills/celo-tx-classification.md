---
skill: celo-tx-classification
agent: agent-06-celo-tax-portfolio
type: classification-rules
last_updated: 2026-06-07
sources:
  - Celoscan transaction schema
  - Celo protocol documentation (Mento, Ubeswap, Mobius, Curve on Celo)
  - ERC-20 Transfer event spec
---

# Skill: Celo Transaction Classification

## Purpose

Classify each transaction in a Celo wallet's history into one of the defined tax-relevant types. Rule-based first pass handles ~85% of cases; LLM fallback handles ambiguous patterns.

---

## Classification Taxonomy

| Type         | Tax treatment                                      | Description                                                                             |
| ------------ | -------------------------------------------------- | --------------------------------------------------------------------------------------- |
| INCOME       | Taxable ordinary income at market value on receipt | Salary payments, P2P payments received for services                                     |
| SWAP         | Disposal event — CGT on gain/loss                  | Token A → Token B via DEX (Ubeswap, Curve, Mobius)                                      |
| TRANSFER_IN  | Not taxable (no disposal)                          | Receiving tokens from another wallet you own, or gifts received (jurisdiction-specific) |
| TRANSFER_OUT | Not taxable unless deemed disposal                 | Sending tokens to another wallet you own                                                |
| YIELD        | Taxable ordinary income at market value on receipt | Liquidity mining rewards, staking rewards, Moola lending interest                       |
| GAS          | Deductible cost (jurisdiction-specific)            | Native CELO spent on gas                                                                |
| MINT         | Context-dependent (see notes)                      | Wrapped token creation, LP token minting                                                |
| BURN         | Context-dependent (see notes)                      | Wrapped token destruction, LP token burning                                             |
| BRIDGE       | FLAG for manual review                             | Celo ↔ Ethereum/Base/OP bridge transactions                                             |
| UNKNOWN      | FLAG for manual review                             | Cannot be classified by rules or LLM with confidence                                    |

---

## Rule-Based Classification Logic

### Step 1: Identify transaction direction and counterparty type

```
IF tx.from == wallet_address:
    direction = OUTBOUND
ELSE IF tx.to == wallet_address OR any token_transfer.to == wallet_address:
    direction = INBOUND
ELSE:
    direction = INTERNAL (wallet interacts with contract, no net asset movement)
```

### Step 2: Apply classification rules in order (first match wins)

**SWAP rules**
```
IF tx involves known DEX router contract:
    AND token_transfer OUT (from wallet) AND token_transfer IN (to wallet) in same tx:
    → SWAP
    asset_out = outgoing token; amount_out = outgoing amount
    asset_in = incoming token; amount_in = incoming amount
```

Known Celo DEX router addresses:
- Ubeswap Router V2: 0x...  [populate from Celoscan verified contracts]
- Curve on Celo: 0x...
- Mobius Money: 0x...
- Mento (cUSD/CELO): 0x...
- Sushiswap on Celo: 0x...

**YIELD rules**
```
IF tx.from IN known_yield_protocols AND direction = INBOUND:
    AND tx is periodic (≥2 previous txns from same contract to same wallet):
    → YIELD
```

Known yield protocol addresses:
- Moola Market (lending rewards): 0x...
- Ubeswap (LP farming rewards): 0x...
- Celo staking rewards (epoch rewards): epoch_reward_contract
- Gooddollar UBI distribution: 0x...

**INCOME rules** (heuristic — requires LLM confirmation for ambiguous cases)
```
IF direction = INBOUND:
    AND tx.from is NOT a known protocol/DEX
    AND amount > threshold (configurable, e.g. >$10 USD equivalent)
    AND NOT matching YIELD pattern:
    → Candidate for INCOME (pass to LLM for confirmation)
```

LLM prompt for INCOME vs TRANSFER_IN disambiguation:
> "This wallet received [amount] [token] from [address] on [date]. The sending address has [N] previous interactions with this wallet. The amount is [X] USD equivalent. Based on the pattern, is this more likely: (a) a payment for services/salary, (b) a transfer from another owned wallet, (c) a gift, (d) unknown? Reply with the letter and one sentence of reasoning."

**GAS rules**
```
FOR each tx WHERE tx.from == wallet_address:
    gas_cost_celo = tx.gasUsed * tx.gasPrice (in CELO)
    → record as GAS entry with tx_hash, celo_amount, usd_value_at_time
```

**BRIDGE rules**
```
IF tx.to IN known_bridge_contracts:
    → FLAG as BRIDGE, do not classify further, add to manual_review[]
```

Known bridge contracts:
- Celo ↔ Ethereum: Optics v2 bridge
- Celo ↔ Base: native bridge
- Any contract labelled "bridge" on Celoscan

**MINT / BURN rules**
```
IF tx involves LP token minting (add_liquidity pattern):
    AND wallet provides token A + token B
    AND receives LP token:
    → MINT (not a disposal — LP token represents proportional claim)
    NOTE: disposal occurs when LP token is burned (BURN event)

IF tx involves LP token burning (remove_liquidity pattern):
    AND wallet returns LP token
    AND receives token A + token B:
    → BURN
    PNL calculation: proceeds = value of tokens received; cost basis = value when LP tokens were minted
```

---

## Cost Basis Rules

**Default method: FIFO (First In, First Out)**

For each asset:
1. Maintain a FIFO queue of acquisition lots: [{amount, price_usd, timestamp}]
2. On disposal: dequeue from front of queue until disposal amount is covered
3. Gain = disposal_proceeds_usd - sum(cost_basis_usd of matched lots)

**Gas deductibility:**
- Nigeria: FIRS treats gas as a transaction cost; deductible against disposal proceeds
- Kenya: KRA guidance unclear; conservative treatment = not deductible (flag in report)
- Default (other): include gas in cost basis of acquired assets

---

## Ambiguity Handling

If classification confidence < 0.8 (LLM self-reported or rule match fails):
1. Mark as UNKNOWN
2. Include raw tx data in CSV with UNKNOWN flag
3. Add to manual_review_required[] list in report summary
4. Do not include in PNL calculation
5. Surface in query interface: "N transactions could not be classified and are excluded from these calculations."

---

## Update Log

| Date | Type | Signal | Source |
|------|------|--------|--------|
| 2026-06-07 | BUILD — Initial classification rules. DEX contract addresses need populating from Celoscan verified contracts list. Yield protocol list needs verification against current live protocols. | Internal |
