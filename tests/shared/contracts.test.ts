import { describe, it, expect } from 'vitest';
import {
  makeContractLookup,
  NAMED_CONTRACTS,
  ClassifiedTxSchema,
  CELO_NATIVE,
  CUSD_MENTO,
  CEUR_MENTO,
  CREAL_MENTO,
  USDC_BRIDGED,
  USDT_BRIDGED,
} from '../../src/index.js';

describe('contract registry', () => {
  it('exposes all named aliases', () => {
    const lookup = makeContractLookup('alfajores');
    const aliases = lookup.aliases();
    expect(aliases.length).toBe(NAMED_CONTRACTS.length);
    expect(aliases).toContain('UBESWAP_V2_ROUTER');
    expect(aliases).toContain('MENTO_BROKER');
  });

  it('returns undefined for aliases without populated addresses (TODO state)', () => {
    const lookup = makeContractLookup('alfajores');
    // All addresses are TODO in the skeleton; we expect undefined for every alias.
    expect(lookup.resolve('UBESWAP_V2_ROUTER')).toBeUndefined();
  });

  it('reports has() correctly when address is null', () => {
    const lookup = makeContractLookup('mainnet');
    expect(lookup.has('CELO_NATIVE_BRIDGE')).toBe(false);
  });

  it('resolves mainnet address for UBESWAP_V2_ROUTER (populated 2026-06-10)', () => {
    const lookup = makeContractLookup('mainnet');
    expect(lookup.resolve('UBESWAP_V2_ROUTER')).toBe(
      '0xE3D8bd6Aed4F159bc8000a9cD47CffDb95F96121',
    );
    expect(lookup.has('UBESWAP_V2_ROUTER')).toBe(true);
  });

  it('resolves mainnet address for MENTO_BROKER', () => {
    const lookup = makeContractLookup('mainnet');
    expect(lookup.resolve('MENTO_BROKER')).toBe(
      '0x777A8255cA72412f0d706dc03C9D1987306B4CaD',
    );
  });

  it('resolves mainnet address for MENTO_ROUTER', () => {
    const lookup = makeContractLookup('mainnet');
    expect(lookup.resolve('MENTO_ROUTER')).toBe(
      '0x4861840C2EfB2b98312B0aE34d86fD73E8f9B6f6',
    );
  });

  it('resolves mainnet address for PORTAL_BRIDGE', () => {
    const lookup = makeContractLookup('mainnet');
    expect(lookup.resolve('PORTAL_BRIDGE')).toBe(
      '0x796Dff6D74F3E27060B71255Fe517BFb23C93eed',
    );
  });

  it('resolves mainnet address for GOOD_DOLLAR_RESERVE', () => {
    const lookup = makeContractLookup('mainnet');
    expect(lookup.resolve('GOOD_DOLLAR_RESERVE')).toBe(
      '0x94A3240f484A04F5e3d524f528d02694c109463b',
    );
  });

  it('keeps STAKING_REWARD_DISTRIBUTOR unresolved (TODO)', () => {
    const lookup = makeContractLookup('mainnet');
    expect(lookup.resolve('STAKING_REWARD_DISTRIBUTOR')).toBeUndefined();
  });

  it('keeps Alfajores aliases unresolved (docs only list mainnet)', () => {
    const lookup = makeContractLookup('alfajores');
    expect(lookup.resolve('UBESWAP_V2_ROUTER')).toBeUndefined();
    expect(lookup.resolve('MENTO_BROKER')).toBeUndefined();
  });
});

describe('native Celo token addresses', () => {
  it('exposes the canonical mainnet addresses', () => {
    expect(CELO_NATIVE.toLowerCase()).toBe('0x471ece3750da237f93b8e339c536989b8978a438');
    expect(CUSD_MENTO.toLowerCase()).toBe('0x765de816845861e75a25fca122bb6898b8b1282a');
    expect(CEUR_MENTO.toLowerCase()).toBe('0xd8763cba276a3738e6de85b4b3bf5fded6d6ca73');
    expect(CREAL_MENTO.toLowerCase()).toBe('0xe8537a3d056da446677b9e9d6c5db704eaab4787');
    expect(USDC_BRIDGED.toLowerCase()).toBe('0xceba9300f2b948710d2653dd7b07f33a8b32118c');
    expect(USDT_BRIDGED.toLowerCase()).toBe('0x48065fbbe25f71c9282ddf5e1cd6d6a887483d5e');
  });

  it('ContractLookup.isNativeToken recognizes all six mainnet tokens', () => {
    const lookup = makeContractLookup('mainnet');
    expect(lookup.isNativeToken(CELO_NATIVE)).toBe(true);
    expect(lookup.isNativeToken(CUSD_MENTO)).toBe(true);
    expect(lookup.isNativeToken(CEUR_MENTO)).toBe(true);
    expect(lookup.isNativeToken(CREAL_MENTO)).toBe(true);
    expect(lookup.isNativeToken(USDC_BRIDGED)).toBe(true);
    expect(lookup.isNativeToken(USDT_BRIDGED)).toBe(true);
    // Case-insensitive.
    expect(lookup.isNativeToken(USDC_BRIDGED.toLowerCase())).toBe(true);
    expect(lookup.isNativeToken(USDC_BRIDGED.toUpperCase())).toBe(true);
  });

  it('ContractLookup.isNativeToken rejects arbitrary addresses', () => {
    const lookup = makeContractLookup('mainnet');
    expect(lookup.isNativeToken('0x0000000000000000000000000000000000000abc')).toBe(false);
    expect(lookup.isNativeToken('')).toBe(false);
  });
});

describe('ClassifiedTxSchema', () => {
  it('accepts a minimal valid classification', () => {
    const result = ClassifiedTxSchema.safeParse({
      hash: '0x' + 'a'.repeat(64),
      type: 'TRANSFER_OUT',
      timestamp: 1700000000,
      classifierSource: 'rule',
    });
    expect(result.success).toBe(true);
  });

  it('accepts LLM-classified with confidence', () => {
    const result = ClassifiedTxSchema.safeParse({
      hash: '0x' + 'b'.repeat(64),
      type: 'YIELD',
      timestamp: 1700000000,
      classifierSource: 'llm',
      confidence: 0.87,
      aggregatedFromHashes: ['0x' + 'c'.repeat(64), '0x' + 'd'.repeat(64)],
    });
    expect(result.success).toBe(true);
  });

  it('rejects confidence outside 0..1', () => {
    const result = ClassifiedTxSchema.safeParse({
      hash: '0x' + 'a'.repeat(64),
      type: 'INCOME',
      timestamp: 1700000000,
      classifierSource: 'llm',
      confidence: 1.5,
    });
    expect(result.success).toBe(false);
  });

  it('rejects bad hash format', () => {
    const result = ClassifiedTxSchema.safeParse({
      hash: 'not-a-hash',
      type: 'INCOME',
      timestamp: 1700000000,
      classifierSource: 'rule',
    });
    expect(result.success).toBe(false);
  });
});
