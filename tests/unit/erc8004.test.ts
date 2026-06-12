/**
 * Unit tests for the ERC-8004 identity module (`src/infra/erc8004.ts`).
 *
 * Owner: Credio (infra).
 *
 * Coverage:
 *   - buildAgentMetadata: shape + stable fields + ISO timestamp
 *   - getRegistrationTxUrl: per-network URL with the known tx hash
 *   - registerAgent: returns the known tx + logs the celoscan URL
 *   - isRegisteredAddress: empty-address guard
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  buildAgentMetadata,
  getRegistrationTxUrl,
  registerAgent,
  isRegisteredAddress,
  KNOWN_REGISTRATION_TX,
} from '../../src/infra/erc8004.js';
import type { AgentWallet } from '../../src/infra/wallet.js';
import type { Address } from 'viem';

const ADDR = '0x0000000000000000000000000000000000000abc' as Address;

function stubWallet(): AgentWallet {
  return {
    address: ADDR,
    chain: {} as never,
    publicClient: {} as never,
    walletClient: {} as never,
    getBalance: async () => 0n,
    hasGas: async () => ({ ok: true, balanceWei: 0n, requiredWei: 0n, shortfallWei: 0n }),
    signMessage: async () => '0x' as never,
    sendTransaction: async () => '0x' as never,
    writeContract: async () => '0x' as never,
    waitForReceipt: async () => ({} as never),
  };
}

// ─── buildAgentMetadata ─────────────────────────────────────────────────────

describe('buildAgentMetadata', () => {
  it('returns the canonical agent id and program', () => {
    const meta = buildAgentMetadata(new Date('2026-06-10T00:00:00Z'));
    expect(meta.agent).toBe('agent-06');
    expect(meta.program).toBe('Celo Onchain Agents Hackathon 2026');
  });

  it('lists all 3 supported jurisdictions (NG, KE, OTHER)', () => {
    const meta = buildAgentMetadata();
    expect(meta.supportedJurisdictions).toEqual(['NG', 'KE', 'OTHER']);
  });

  it('declares the 8 capabilities the pipeline actually implements', () => {
    const meta = buildAgentMetadata();
    expect(meta.capabilities).toEqual([
      'tx-classification',
      'fifo-pnl',
      'lifo-pnl',
      'wac-pnl',
      'csv-export-firs',
      'csv-export-kra',
      'csv-export-carf',
      'natural-language-query',
    ]);
  });

  it('emits an ISO-8601 generatedAt timestamp', () => {
    const meta = buildAgentMetadata(new Date('2026-06-10T12:34:56.789Z'));
    expect(meta.generatedAt).toBe('2026-06-10T12:34:56.789Z');
  });

  it('name + description are non-empty (Celopedia requires both)', () => {
    const meta = buildAgentMetadata();
    expect(meta.name.length).toBeGreaterThan(0);
    expect(meta.description.length).toBeGreaterThan(20);
  });
});

// ─── getRegistrationTxUrl ────────────────────────────────────────────────────

describe('getRegistrationTxUrl', () => {
  it('builds the mainnet Celoscan URL with the known tx hash', () => {
    expect(getRegistrationTxUrl('mainnet')).toBe(
      `https://celoscan.io/tx/${KNOWN_REGISTRATION_TX}`,
    );
  });

  it('builds the Alfajores Celoscan URL with the known tx hash', () => {
    expect(getRegistrationTxUrl('alfajores')).toBe(
      `https://alfajores.celoscan.io/tx/${KNOWN_REGISTRATION_TX}`,
    );
  });
});

// ─── registerAgent (stub) ────────────────────────────────────────────────────

describe('registerAgent (stub)', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
  });
  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it('returns the known registration tx without broadcasting', async () => {
    const hash = await registerAgent(stubWallet(), 'mainnet');
    expect(hash).toBe(KNOWN_REGISTRATION_TX);
  });

  it('logs the celoscan URL so the caller can surface it', async () => {
    await registerAgent(stubWallet(), 'mainnet');
    expect(consoleSpy).toHaveBeenCalledOnce();
    const msg = consoleSpy.mock.calls[0]?.[0] as string;
    expect(msg).toContain('https://celoscan.io/tx/');
    expect(msg).toContain(KNOWN_REGISTRATION_TX);
  });

  it('uses the Alfajores URL when called with alfajores', async () => {
    await registerAgent(stubWallet(), 'alfajores');
    const msg = consoleSpy.mock.calls[0]?.[0] as string;
    expect(msg).toContain('https://alfajores.celoscan.io/tx/');
  });
});

// ─── isRegisteredAddress ────────────────────────────────────────────────────

describe('isRegisteredAddress', () => {
  it('returns false for the zero address', () => {
    expect(
      isRegisteredAddress('0x0000000000000000000000000000000000000000'),
    ).toBe(false);
  });

  it('returns false for undefined', () => {
    expect(isRegisteredAddress(undefined)).toBe(false);
  });

  it('returns true for any non-zero address', () => {
    expect(isRegisteredAddress(ADDR)).toBe(true);
  });
});
