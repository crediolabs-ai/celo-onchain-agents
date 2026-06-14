/**
 * Shared registry of known yield-protocol addresses.
 *
 * Owner: Tuan (tx-classifier sub-agent).
 *
 * This set drives two rules in the classifier:
 *   1. `yield.known_protocol_in@v1` — classifies a token IN from a listed
 *      address as YIELD (not INCOME). This is the receiver side.
 *   2. `transfer.self_funding_for_yield@v1` — classifies a stablecoin IN as
 *      TRANSFER_IN (not INCOME) when the wallet immediately routes the same
 *      asset to a listed address. This is the sender side.
 *
 * Extend as more yield protocols are discovered from user testing.
 * One line per protocol — no refactors needed in the classifier.
 */

/**
 * Known yield-protocol deposit addresses.
 *
 * v1 addresses (discovered from 0xBE19 2024 on-chain data):
 *   - 0x5b7ba647… : Karmen Mezz Pool — yield RETURN comes FROM this address
 *     (tx[8]: USDC from this address to wallet on 2024-12-14).
 *   - 0x76ae2d4c175ce3080f868cce30c9cf586c8098d8 : Karmen Mezz Pool —
 *     USDC DEPOSIT goes TO this address (tx[5]: USDC from wallet to this
 *     address on 2024-05-13). This is the pool's ERC-20 transfer() target,
 *     separate from the pool's EOA/router address used in raw tx.to.
 *
 * Both addresses drive two rules:
 *   1. yield.known_protocol_in  — from-address match for yield returns.
 *   2. transfer.self_funding_for_yield — deposit-side detection (DEPOSIT
 *      goes to a pool contract, not an EOA; raw tx.to may be a router).
 */
export const YIELD_PROTOCOL_ADDRESSES: ReadonlySet<string> = new Set([
  '0x5b7ba6471681c61b4994dc5072b0d0c0ffad4a2b',
  '0x76ae2d4c175ce3080f868cce30c9cf586c8098d8',
]);

/**
 * Block window for the self-funding for yield detector.
 *
 * On Celo's ~5s block time:
 *   - 10 blocks ≈ 50 seconds — too tight; the 0xBE19 2024-05-13 IN and
 *     DEPOSIT OUT are 700+ blocks apart (~58+ minutes).
 *   - 1000 blocks ≈ 80 minutes — covers the 700-block gap with headroom.
 *   - 10000 blocks ≈ 14 hours — safe upper bound for same-day transactions.
 *
 * v1: 1000 blocks. Revisit if false positives appear on multi-hour delayed txs.
 */
export const SELF_FUNDING_BLOCK_WINDOW = 1000;
