/**
 * Unit tests for the protocol-decoder sub-agent.
 *
 * Owner: Tuan (tx-classifier sub-agent).
 *
 * Coverage:
 *   - decodeProtocolAction: Mento swap, Ubeswap swap, Moola mint,
 *     GoodDollar claim, unknown selector → null
 *   - Confidence bands: exact selector → 0.9, inferred → 0.5
 *   - Transfer-shape heuristic: 2+ transfers → SWAP
 *   - Moola cToken address hit → DEPOSIT/WITHDRAW
 */

import { describe, expect, it } from 'vitest';
import type { Address, RawTx, TokenTransfer } from '../../src/shared/types.js';
import { ProtocolName, ProtocolActionType } from '../../src/sub-agents/tx-classifier/protocol-actions.js';
import { decodeProtocolAction } from '../../src/sub-agents/tx-classifier/protocol-decoder.js';

// ─── Fixtures ────────────────────────────────────────────────────────────────

// Protocol-decoder test suite — owner: Tuan

function makeRawTx(overrides: Partial<RawTx> = {}): RawTx {
  return {
    hash: '0x' + '22'.repeat(32) as `0x${string}`,
    blockNumber: 1,
    timestamp: 1_700_000_000,
    from: '0x' + '11'.repeat(20) as `0x${string}`,
    to: '0x' + '33'.repeat(20) as `0x${string}`,
    value: '0',
    gasUsed: '21000',
    gasPrice: '1000000000',
    input: '0x',
    isError: '0',
    ...overrides,
  };
}

function makeTransfer(overrides: Partial<TokenTransfer> = {}): TokenTransfer {
  return {
    hash: '0x' + '22'.repeat(32) as `0x${string}`,
    blockNumber: 1,
    timestamp: 1_700_000_000,
    from: '0x' + '11'.repeat(20) as `0x${string}`,
    to: '0x' + '33'.repeat(20) as `0x${string}`,
    contractAddress: '0x' + '44'.repeat(20) as `0x${string}`,
    tokenSymbol: 'USDC',
    tokenDecimals: 6,
    value: '1000000',
    ...overrides,
  };
}

// ─── Mento selectors ─────────────────────────────────────────────────────────

const MENTO_BROKER  = '0x777A8255cA72412f0d706dc03C9D1987306B4CaD';
const MENTO_ROUTER  = '0x4861840C2EfB2b98312B0aE34d86fD73E8f9B6f6';
const UBESWAP_ROUTER = '0xE3D8bd6Aed4F159bc8000a9cD47CffDb95F96121';

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('decodeProtocolAction', () => {

  // ── Mento ────────────────────────────────────────────────────────────────

  it('decodes Mento swapExactIn selector as MENTO+SWAP with confidence 0.9', () => {
    const tx = makeRawTx({
      to: MENTO_BROKER,
      input: '0x8d46b1e8' + '00'.repeat(64), // swapExactIn
    });
    const result = decodeProtocolAction(tx, []);
    expect(result).toMatchObject({
      protocol: ProtocolName.MENTO,
      action: ProtocolActionType.SWAP,
      confidence: 0.9,
    });
  });

  it('decodes Mento swapIn selector as MENTO+SWAP with confidence 0.9', () => {
    const tx = makeRawTx({
      to: MENTO_ROUTER,
      input: '0x18c83dc3' + '00'.repeat(64), // swapIn
    });
    const result = decodeProtocolAction(tx, []);
    expect(result).toMatchObject({
      protocol: ProtocolName.MENTO,
      action: ProtocolActionType.SWAP,
      confidence: 0.9,
    });
  });

  it('decodes Mento deposit selector as MENTO+DEPOSIT with confidence 0.9', () => {
    const tx = makeRawTx({
      to: MENTO_ROUTER,
      input: '0x6e1fc26f' + '00'.repeat(64), // deposit
    });
    const result = decodeProtocolAction(tx, []);
    expect(result).toMatchObject({
      protocol: ProtocolName.MENTO,
      action: ProtocolActionType.DEPOSIT,
      confidence: 0.9,
    });
  });

  it('decodes Mento withdraw selector as MENTO+WITHDRAW with confidence 0.9', () => {
    const tx = makeRawTx({
      to: MENTO_ROUTER,
      input: '0x5a09ac5b' + '00'.repeat(64), // withdraw
    });
    const result = decodeProtocolAction(tx, []);
    expect(result).toMatchObject({
      protocol: ProtocolName.MENTO,
      action: ProtocolActionType.WITHDRAW,
      confidence: 0.9,
    });
  });

  // ── Ubeswap ─────────────────────────────────────────────────────────────

  it('decodes Ubeswap swapExactTokensForTokens as UBESWAP+SWAP with confidence 0.9', () => {
    const tx = makeRawTx({
      to: UBESWAP_ROUTER,
      input: '0x38ed1739' + '00'.repeat(64), // swapExactTokensForTokens
    });
    const result = decodeProtocolAction(tx, []);
    expect(result).toMatchObject({
      protocol: ProtocolName.UBESWAP,
      action: ProtocolActionType.SWAP,
      confidence: 0.9,
    });
  });

  it('decodes Ubeswap swapExactCELOForTokens as UBESWAP+SWAP', () => {
    const tx = makeRawTx({
      to: UBESWAP_ROUTER,
      input: '0x8803dbee' + '00'.repeat(64), // swapExactCELOForTokens
    });
    const result = decodeProtocolAction(tx, []);
    expect(result).toMatchObject({
      protocol: ProtocolName.UBESWAP,
      action: ProtocolActionType.SWAP,
      confidence: 0.9,
    });
  });

  it('decodes Ubeswap swapExactIn as UBESWAP+SWAP', () => {
    const tx = makeRawTx({
      to: UBESWAP_ROUTER,
      input: '0x18c4f2bd' + '00'.repeat(64), // swapExactIn
    });
    const result = decodeProtocolAction(tx, []);
    expect(result).toMatchObject({
      protocol: ProtocolName.UBESWAP,
      action: ProtocolActionType.SWAP,
      confidence: 0.9,
    });
  });

  // ── Unknown / edge cases ─────────────────────────────────────────────────

  it('returns null for unknown function selector with no transfers', () => {
    const tx = makeRawTx({
      to: MENTO_BROKER,
      input: '0xdeadbeef' + '00'.repeat(64),
    });
    expect(decodeProtocolAction(tx, [])).toBeNull();
  });

  it('returns null when tx.to is null', () => {
    const tx = makeRawTx({ to: null });
    expect(decodeProtocolAction(tx, [])).toBeNull();
  });

  it('returns null for empty calldata on a non-router address', () => {
    const tx = makeRawTx({
      to: ('0x' + 'ff'.repeat(20)) as Address,
      input: '0x',
    });
    expect(decodeProtocolAction(tx, [])).toBeNull();
  });

  it('selector match to wrong address returns null (false-positive guard)', () => {
    const tx = makeRawTx({
      to: ('0x' + 'ff'.repeat(20)) as Address,
      input: '0x8d46b1e8' + '00'.repeat(64), // Mento selector, wrong address
    });
    // Generic selectors like 0x8d46b1e8 (Mento swap) appear in many
    // unrelated contracts (claim() on a USDT-related contract is a
    // common false positive). Address match is now MANDATORY — a
    // selector hit on an unknown `to` must not be classified as
    // protocol-specific. Returns null so the tx falls through to
    // other classifier paths.
    const result = decodeProtocolAction(tx, []);
    expect(result).toBeNull();
  });

  // ── Transfer-shape heuristic ────────────────────────────────────────────

  it('2+ transfers to Ubeswap router with unknown selector infers SWAP at 0.5', () => {
    const tx = makeRawTx({
      to: UBESWAP_ROUTER,
      input: '0x',
    });
    const transfers = [
      makeTransfer({ hash: tx.hash, tokenSymbol: 'CELO', value: '1000000' }),
      makeTransfer({ hash: tx.hash, tokenSymbol: 'USDC', value: '1000000' }),
    ];
    const result = decodeProtocolAction(tx, transfers);
    expect(result).toMatchObject({
      protocol: ProtocolName.UBESWAP,
      action: ProtocolActionType.SWAP,
      confidence: 0.5,
    });
  });

  it('2+ transfers to Mento Broker with empty calldata infers SWAP at 0.5', () => {
    const tx = makeRawTx({
      to: MENTO_BROKER,
      input: '0x',
    });
    const transfers = [
      makeTransfer({ hash: tx.hash, tokenSymbol: 'cUSD', value: '5000000' }),
      makeTransfer({ hash: tx.hash, tokenSymbol: 'USDC', value: '5000000' }),
    ];
    const result = decodeProtocolAction(tx, transfers);
    expect(result).toMatchObject({
      protocol: ProtocolName.MENTO,
      action: ProtocolActionType.SWAP,
      confidence: 0.5,
    });
  });

  it('single transfer does NOT trigger transfer-shape heuristic', () => {
    const tx = makeRawTx({
      to: UBESWAP_ROUTER,
      input: '0x',
    });
    const transfers = [
      makeTransfer({ hash: tx.hash, tokenSymbol: 'CELO', value: '1000000' }),
    ];
    expect(decodeProtocolAction(tx, transfers)).toBeNull();
  });

  // ── Confidence bands ────────────────────────────────────────────────────

  it('exact selector match to known address returns confidence 0.9', () => {
    const tx = makeRawTx({
      to: MENTO_BROKER,
      input: '0x8d46b1e8' + '00'.repeat(64), // swapExactIn
    });
    expect(decodeProtocolAction(tx, [])?.confidence).toBe(0.9);
  });

  it('selector match to wrong address returns null (false-positive guard)', () => {
    const tx = makeRawTx({
      to: ('0x' + 'ff'.repeat(20)) as Address, // wrong address
      input: '0x8d46b1e8' + '00'.repeat(64), // swapExactIn (Mento selector)
    });
    // Generic selector on a non-Mento contract must NOT be classified as
    // Mento. Returns null so the tx falls through to a different path.
    expect(decodeProtocolAction(tx, [])).toBeNull();
  });

  it('inferred from multi-transfer shape returns confidence 0.5', () => {
    const tx = makeRawTx({
      to: MENTO_BROKER,
      input: '0x', // no calldata
    });
    const transfers = [
      makeTransfer({ hash: tx.hash, tokenSymbol: 'cUSD' }),
      makeTransfer({ hash: tx.hash, tokenSymbol: 'USDC' }),
    ];
    expect(decodeProtocolAction(tx, transfers)?.confidence).toBe(0.5);
  });

  // ── Moola cToken ────────────────────────────────────────────────────────

  it('Moola cToken address + transfers infers DEPOSIT', () => {
    const MOOLA_CTOKEN = '0x43d067F76154E7620555673F8c6D8C8E51F3f7D4';
    const tx = makeRawTx({
      to: MOOLA_CTOKEN,
      input: '0x',
    });
    const transfers = [
      makeTransfer({
        hash: tx.hash,
        to: MOOLA_CTOKEN as `0x${string}`,
        tokenSymbol: 'cUSD',
      }),
    ];
    const result = decodeProtocolAction(tx, transfers);
    expect(result).toMatchObject({
      protocol: ProtocolName.MOOLA,
      action: ProtocolActionType.DEPOSIT,
      confidence: 0.5,
    });
  });

  it('Moola cToken address + transfers infers WITHDRAW when tokens flow FROM cToken', () => {
    const MOOLA_CTOKEN = '0x43d067F76154E7620555673F8c6D8C8E51F3f7D4';
    const tx = makeRawTx({
      to: MOOLA_CTOKEN,
      input: '0x',
    });
    const transfers = [
      makeTransfer({
        hash: tx.hash,
        from: MOOLA_CTOKEN as `0x${string}`,
        tokenSymbol: 'cUSD',
      }),
    ];
    const result = decodeProtocolAction(tx, transfers);
    expect(result).toMatchObject({
      protocol: ProtocolName.MOOLA,
      action: ProtocolActionType.WITHDRAW,
      confidence: 0.5,
    });
  });

  it('Moola cToken address + no transfers returns null', () => {
    const MOOLA_CTOKEN = '0x43d067F76154E7620555673F8c6D8C8E51F3f7D4';
    const tx = makeRawTx({
      to: MOOLA_CTOKEN,
      input: '0x',
    });
    expect(decodeProtocolAction(tx, [])).toBeNull();
  });
});
