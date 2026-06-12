/**
 * Protocol-aware classification tests — Agent 06 surgical pass, 2026-06-11.
 *
 * Owner: Tuan (tx-classifier sub-agent).
 *
 * Covers the `fetchContractMetadata` + `protocol-registry` path that lifts
 * named contracts from `flagged:UNKNOWN` to a category hint. These tests use
 * small in-memory `contractMetadata` Maps (no Celoscan mocking needed) so
 * they run in milliseconds and don't depend on network state.
 *
 * Cases:
 *  1. Mento Broker address in metadata → SWAP (2+ transfers).
 *  2. FiatTokenProxy (USDC) with single transfer → TRANSFER_IN.
 *  3. Unknown address, name matches `/Vault/i`, 1 transfer → INTERACTION.
 *  4. Unknown address, no name match, 0 metadata → UNKNOWN (regression).
 *  5. Sanity: interactionBreakdown counter increments correctly.
 */

import { describe, expect, it } from 'vitest';
import type {
  Address,
  ContractMetadata,
  FetchedTxData,
  RawTx,
  TokenTransfer,
  TxHash,
} from '../../src/shared/types.js';
import { classifyWithDeps } from '../../src/sub-agents/tx-classifier/index.js';
import { matchNameToCategory } from '../../src/shared/protocol-registry.js';

const ADDR = '0x0000000000000000000000000000000000000aaa' as Address;
// Mento Broker (mainnet) is registered in `contracts.ts` so the rule table
// short-circuits on it. For the protocol-aware path we use a Mento-related
// address NOT in the rule registry (e.g. a Mento exchange / pool).
const MENTO_POOL = '0x0000000000000000000000000000000000000e01' as Address;
const FIAT_TOKEN_PROXY = '0xcebA9300f2b948710d2653dD7B07f33A8B32118C'.toLowerCase() as Address;
const UNKNOWN_VAULT = '0x0000000000000000000000000000000000000bbb' as Address;
const UNKNOWN_NO_NAME = '0x0000000000000000000000000000000000000ccc' as Address;

function makeRawTx(overrides: Partial<RawTx> = {}): RawTx {
  return {
    hash: ('0x' + '11'.repeat(32)) as TxHash,
    blockNumber: 1,
    timestamp: 1_700_000_000,
    from: ADDR,
    to: MENTO_POOL,
    value: '0',
    gasUsed: '21000',
    gasPrice: '1000000000',
    input: '0x',
    isError: '0',
    ...overrides,
  };
}

function makeTokenTransfer(overrides: Partial<TokenTransfer> = {}): TokenTransfer {
  return {
    hash: ('0x' + '11'.repeat(32)) as TxHash,
    blockNumber: 1,
    timestamp: 1_700_000_000,
    from: MENTO_POOL,
    to: ADDR,
    contractAddress: '0x0000000000000000000000000000000000000d01' as Address,
    tokenSymbol: 'cUSD',
    tokenDecimals: 18,
    value: '1000000000000000000000',
    ...overrides,
  };
}

function makeFetched(
  txs: RawTx[],
  transfers: TokenTransfer[],
  contractMetadata: Map<Address, ContractMetadata>,
): FetchedTxData {
  return {
    address: ADDR,
    dateRange: { from: 0, to: 0 },
    rawTxns: txs,
    tokenTransfers: transfers,
    internalTxns: [],
    source: 'celoscan',
    fetchedAt: 0,
    paginationComplete: true,
    fetchErrors: [],
    contractMetadata,
  };
}

describe('classifier protocol-aware path', () => {
  it('1. Mento Broker (named stable) + 2 transfers → SWAP', async () => {
    const meta = new Map<Address, ContractMetadata>([
      [
        MENTO_POOL,
        { name: 'Mento Broker v2', isProxy: false, impl: null, verifiedAt: '2024-01-01' },
      ],
    ]);
    const tx = makeRawTx({ to: MENTO_POOL });
    const t1 = makeTokenTransfer({ tokenSymbol: 'CELO', value: '1000000000000000000' });
    const t2 = makeTokenTransfer({
      tokenSymbol: 'cUSD',
      from: MENTO_POOL,
      to: ADDR,
      value: '2000000000000000000000',
    });
    const out = await classifyWithDeps({
      fetched: makeFetched([tx], [t1, t2], meta),
    });
    expect(out.classified).toHaveLength(1);
    expect(out.classified[0]!.type).toBe('SWAP');
    expect(out.classified[0]!.classifierSource).toBe('rule');
    expect(out.classified[0]!.notes).toContain('Mento');
    expect(out.flaggedForReview).toEqual([]);
    expect(out.interactionBreakdown['Mento Broker v2']).toBe(1);
  });

  it('2. FiatTokenProxy (USDC) wrapping tx + 2 transfers → STABLE-INTERACTION', async () => {
    // 2+ transfers: the single-transfer `transfer.simple_token_in` rule is
    // bypassed. The `swap.dex_multi_transfer` rule only fires for known DEX
    // aliases (UBESWAP/MENTO), not for FiatTokenProxy. The protocol-aware
    // path then recognizes USDC's proxy and classifies by STABLE category.
    const meta = new Map<Address, ContractMetadata>([
      [
        FIAT_TOKEN_PROXY,
        { name: 'FiatTokenProxy', isProxy: true, impl: null, verifiedAt: '2024-01-01' },
      ],
    ]);
    const tx = makeRawTx({ to: FIAT_TOKEN_PROXY });
    const t1 = makeTokenTransfer({
      to: FIAT_TOKEN_PROXY,
      from: ADDR,
      contractAddress: FIAT_TOKEN_PROXY,
      tokenSymbol: 'USDC',
      value: '1000000',
    });
    const t2 = makeTokenTransfer({
      to: ADDR,
      from: FIAT_TOKEN_PROXY,
      contractAddress: '0x0000000000000000000000000000000000000d99' as Address,
      tokenSymbol: 'USDC',
      value: '1000000',
    });
    const out = await classifyWithDeps({
      fetched: makeFetched([tx], [t1, t2], meta),
    });
    // STABLE category with 2 transfers → SWAP per categoryToTxType.
    expect(out.classified[0]!.type).toBe('SWAP');
    expect(out.classified[0]!.notes).toContain('FiatTokenProxy');
    expect(out.interactionBreakdown['FiatTokenProxy']).toBe(1);
  });

  it('3. Unknown address, name matches /Vault/i + 2 transfers → INTERACTION', async () => {
    // 2+ transfers means `transfer.simple_token_in` (single-token rule) and
    // `swap.dex_multi_transfer` (only fires for known DEX aliases) both
    // miss. Protocol-aware path should classify by contract name.
    const meta = new Map<Address, ContractMetadata>([
      [
        UNKNOWN_VAULT,
        { name: 'YearnVaultV3', isProxy: false, impl: null, verifiedAt: '2024-06-01' },
      ],
    ]);
    const tx = makeRawTx({ to: UNKNOWN_VAULT });
    const t1 = makeTokenTransfer({
      to: ADDR,
      from: UNKNOWN_VAULT,
      contractAddress: UNKNOWN_VAULT,
      tokenSymbol: 'yvCELO',
      value: '1000000000000000000',
    });
    const t2 = makeTokenTransfer({
      from: ADDR,
      to: UNKNOWN_VAULT,
      contractAddress: '0x0000000000000000000000000000000000000d02' as Address,
      tokenSymbol: 'CELO',
      value: '1000000000000000000',
    });
    const out = await classifyWithDeps({
      fetched: makeFetched([tx], [t1, t2], meta),
    });
    expect(out.classified[0]!.type).toBe('INTERACTION');
    expect(out.classified[0]!.notes).toContain('YearnVaultV3');
    expect(out.interactionBreakdown['YearnVaultV3']).toBe(1);
    expect(out.flaggedForReview).toEqual([]);
  });

  it('4. Unknown address, no metadata, no rule match → UNKNOWN (regression)', async () => {
    const tx = makeRawTx({ to: UNKNOWN_NO_NAME, value: '1', isError: '1' });
    // Empty metadata, no LLM deps, no rule matches → flag.
    const out = await classifyWithDeps({
      fetched: makeFetched([tx], [], new Map()),
    });
    expect(out.classified[0]!.type).toBe('UNKNOWN');
    expect(out.classified[0]!.classifierSource).toBe('flagged');
    expect(out.flaggedForReview).toContain(tx.hash);
    // Empty breakdown.
    expect(out.interactionBreakdown).toEqual({});
  });

  it('5. interactionBreakdown counter increments across multiple txs', async () => {
    const meta = new Map<Address, ContractMetadata>([
      [
        MENTO_POOL,
        { name: 'Mento Broker v2', isProxy: false, impl: null, verifiedAt: '' },
      ],
      [
        UNKNOWN_VAULT,
        { name: 'CeloRandomProtocol', isProxy: false, impl: null, verifiedAt: '' },
      ],
    ]);
    const tx1 = makeRawTx({ hash: ('0x' + 'aa'.repeat(32)) as TxHash, to: MENTO_POOL });
    const tx2 = makeRawTx({ hash: ('0x' + 'bb'.repeat(32)) as TxHash, to: MENTO_POOL });
    const tx3 = makeRawTx({ hash: ('0x' + 'cc'.repeat(32)) as TxHash, to: UNKNOWN_VAULT });
    const t1 = makeTokenTransfer({
      hash: tx1.hash,
      to: ADDR,
      from: MENTO_POOL,
      contractAddress: '0x0000000000000000000000000000000000000c01' as Address,
      tokenSymbol: 'cUSD',
      value: '1000',
    });
    const t2 = makeTokenTransfer({
      hash: tx1.hash,
      from: ADDR,
      to: MENTO_POOL,
      contractAddress: '0x0000000000000000000000000000000000000c02' as Address,
      tokenSymbol: 'CELO',
      value: '1000',
    });
    const t3 = makeTokenTransfer({
      hash: tx2.hash,
      to: ADDR,
      from: MENTO_POOL,
      contractAddress: '0x0000000000000000000000000000000000000c01' as Address,
      tokenSymbol: 'cUSD',
      value: '1000',
    });
    const t4 = makeTokenTransfer({
      hash: tx2.hash,
      from: ADDR,
      to: MENTO_POOL,
      contractAddress: '0x0000000000000000000000000000000000000c02' as Address,
      tokenSymbol: 'CELO',
      value: '1000',
    });
    const t5 = makeTokenTransfer({
      hash: tx3.hash,
      to: ADDR,
      from: UNKNOWN_VAULT,
      contractAddress: UNKNOWN_VAULT,
      tokenSymbol: 'stCELO',
      value: '1000',
    });
    const t6 = makeTokenTransfer({
      hash: tx3.hash,
      from: ADDR,
      to: UNKNOWN_VAULT,
      contractAddress: '0x0000000000000000000000000000000000000c03' as Address,
      tokenSymbol: 'CELO',
      value: '1000',
    });

    const out = await classifyWithDeps({
      fetched: makeFetched([tx1, tx2, tx3], [t1, t2, t3, t4, t5, t6], meta),
    });
    // 2 SWAPs (Mento), 1 INTERACTION (named contract without category match).
    expect(out.classified[0]!.type).toBe('SWAP');
    expect(out.classified[1]!.type).toBe('SWAP');
    expect(out.classified[2]!.type).toBe('INTERACTION');
    expect(out.interactionBreakdown).toEqual({
      'Mento Broker v2': 2,
      CeloRandomProtocol: 1,
    });
    // No flagging.
    expect(out.flaggedForReview).toEqual([]);
  });
});

describe('matchNameToCategory (protocol-registry)', () => {
  it('matches Mento names', () => {
    expect(matchNameToCategory('Mento Broker v2')).toBe('STABLE');
    expect(matchNameToCategory('Mento ExchangeProvider')).toBe('STABLE');
  });
  it('matches Vault regex', () => {
    expect(matchNameToCategory('YearnVaultV3')).toBe('VAULT');
    expect(matchNameToCategory('ERC4626Vault')).toBe('VAULT');
  });
  it('returns null for unrecognized names', () => {
    expect(matchNameToCategory('RandomContract')).toBeNull();
    expect(matchNameToCategory('')).toBeNull();
  });
  it('matches Lending and Bridge', () => {
    expect(matchNameToCategory('Moola Market')).toBe('LENDING');
    expect(matchNameToCategory('WormholePortalBridge')).toBe('BRIDGE');
  });
});
