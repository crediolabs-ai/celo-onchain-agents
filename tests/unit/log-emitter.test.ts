/**
 * Unit tests for the on-chain log emitter (`src/infra/log-emitter.ts`).
 *
 * Owner: Credio (infra).
 *
 * Coverage:
 *   - buildLogPayload: format + edge cases (missing year, 0 income, negative clamp)
 *   - asciiToHexData / decodeLogPayload: round-trip
 *   - createLogEmitter: calls wallet.sendTransaction with the right shape;
 *     wraps RPC errors in WalletError
 */

import { describe, it, expect } from 'vitest';
import {
  buildLogPayload,
  asciiToHexData,
  decodeLogPayload,
  createLogEmitter,
  LOG_PAYLOAD_PREFIX,
} from '../../src/infra/log-emitter.js';
import { WalletError } from '../../src/shared/errors.js';
import type { AgentWallet } from '../../src/infra/wallet.js';
import type {
  ClassifiedTx,
  ClassifyOutput,
  CsvExportResult,
  FetchedTxData,
  Jurisdiction,
  PnlOutput,
  PipelineRequest,
  QueryOutput,
} from '../../src/shared/types.js';
import type { Address, Hash, Hex } from 'viem';
import { mkHash } from '../fixtures/mk-hash.js';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const ADDR = '0x0000000000000000000000000000000000000abc' as Address;

function mkPnl(taxableIncome: number): PnlOutput {
  return {
    address: ADDR,
    method: 'FIFO',
    taxYears: [{ year: 2024, realizedGains: 0, income: 0, yield: 0, interestEarned: 0, deductibleGas: 0, taxableIncome }],
    realizedPnlByAsset: {},
    unrealizedPnlByAsset: {},
    incomeTotal: 0,
    yieldTotal: 0,
    interestEarnedTotal: 0,
    priceGaps: [],
    methodJurisdictionCompat: [],
    disposals: [],
  };
}

function mkClassified(n: number): ClassifyOutput {
  const items: ClassifiedTx[] = Array.from({ length: n }, () => ({
    hash: mkHash(),
    type: 'TRANSFER_IN' as const,
    timestamp: 1_716_662_400,
    assetIn: { symbol: 'CELO', amount: '1000', priceUsd: 0.5 },
    classifierSource: 'rule' as const,
  }));
  return { classified: items, flaggedForReview: [], ruleHits: n, protocolDecoderHits: 0, llmFallbacks: 0, interactionBreakdown: {} };
}

function mkInput(jurisdiction: Jurisdiction, taxableIncome: number, txCount: number): {
  input: Parameters<typeof buildLogPayload>[0];
  request: PipelineRequest;
} {
  const request: PipelineRequest = {
    address: ADDR,
    jurisdiction,
    method: 'FIFO',
    taxYear: 2024,
  };
  const fetched: FetchedTxData = {
    address: ADDR,
    dateRange: { from: 1, to: 2 },
    rawTxns: [],
    tokenTransfers: [],
    internalTxns: [],
    source: 'celoscan',
    fetchedAt: 1,
    paginationComplete: true,
    fetchErrors: [],
    contractMetadata: new Map(),
  };
  const csv: CsvExportResult = {
    filename: 'test.csv',
    rowCount: txCount,
    schema: 'nigeria-firs',
    csv: '',
  };
  return {
    input: {
      result: {
        fetched,
        classified: mkClassified(txCount),
        pnl: mkPnl(taxableIncome),
        csv,
      },
      request,
    },
    request,
  };
}

// ─── buildLogPayload ─────────────────────────────────────────────────────────

describe('buildLogPayload', () => {
  it('emits the v1 prefix + jurisdiction + year + USD + txCount + unix timestamp', () => {
    const { input } = mkInput('NG', 1.25, 7);
    const payload = buildLogPayload(input, 1_716_662_400_000); // fixed "now"
    expect(payload).toBe('agent-06:v1:NG:2024:1.25:7:1716662400');
  });

  it('formats USD to 2dp even when input has more precision', () => {
    const { input } = mkInput('KE', 0.1, 1);
    const payload = buildLogPayload(input, 0);
    expect(payload.endsWith(':0.10:1:0')).toBe(true);
  });

  it('clamps negative taxable income to 0 (tax refunds are not agent loggable)', () => {
    const { input } = mkInput('OTHER', -5, 3);
    const payload = buildLogPayload(input, 0);
    expect(payload.endsWith(':0.00:3:0')).toBe(true);
  });

  it('uses 0.00 USD when the year summary is missing', () => {
    const { input } = mkInput('NG', 0, 0);
    // Remove all tax year summaries
    input.result.pnl.taxYears = [];
    const payload = buildLogPayload(input, 0);
    expect(payload.endsWith(':0.00:0:0')).toBe(true);
  });

  it('starts with the indexable prefix', () => {
    const { input } = mkInput('NG', 0, 0);
    expect(buildLogPayload(input, 0).startsWith(LOG_PAYLOAD_PREFIX)).toBe(true);
  });
});

// ─── asciiToHexData + decodeLogPayload ───────────────────────────────────────

describe('asciiToHexData / decodeLogPayload', () => {
  it('round-trips a payload through hex and back', () => {
    const { input } = mkInput('NG', 0.5, 2);
    const original = buildLogPayload(input, 1_700_000_000_000);
    const hex = asciiToHexData(original);
    const decoded = decodeLogPayload(hex);
    expect(decoded).toBe(original);
  });

  it('decoded payload does not include the 0x prefix', () => {
    const { input } = mkInput('NG', 0, 0);
    const hex = asciiToHexData(buildLogPayload(input, 0));
    const decoded = decodeLogPayload(hex);
    expect(decoded).not.toBeNull();
    expect(decoded!.startsWith('0x')).toBe(false);
  });

  it('returns null for undefined / empty / non-prefixed data', () => {
    expect(decodeLogPayload(undefined)).toBeNull();
    expect(decodeLogPayload('0x' as Hex)).toBeNull();
    expect(decodeLogPayload(asciiToHexData('hello world'))).toBeNull();
  });

  it('returns null for malformed hex (odd length)', () => {
    expect(decodeLogPayload('0xabc' as Hex)).toBeNull();
  });
});

// ─── createLogEmitter ────────────────────────────────────────────────────────

interface CallRecord {
  to: Address;
  value: bigint;
  data: Hex | undefined;
}

function makeStubWallet(addr: Address = ADDR, onSend?: (rec: CallRecord) => Hash): AgentWallet {
  const calls: CallRecord[] = [];
  return {
    address: addr,
    chain: {} as never,
    publicClient: {} as never,
    walletClient: {} as never,
    getBalance: async () => 0n,
    hasGas: async () => ({ ok: true, balanceWei: 0n, requiredWei: 0n, shortfallWei: 0n }),
    signMessage: async () => '0x' as Hex,
    sendTransaction: async (tx): Promise<Hash> => {
      const rec: CallRecord = { to: tx.to, value: tx.value ?? 0n, data: tx.data };
      calls.push(rec);
      return onSend ? onSend(rec) : ('0x' + '11'.repeat(32)) as Hash;
    },
    writeContract: async () => '0x' as never,
    waitForReceipt: async () => ({} as never),
    // Test-only: expose calls for assertions
    ...({ _calls: calls } as object),
  } as AgentWallet;
}

describe('createLogEmitter', () => {
  it('sends a 0-value self-tx with the encoded payload as data', async () => {
    const wallet = makeStubWallet();
    const { input } = mkInput('NG', 1.25, 7);
    const emit = createLogEmitter(wallet);
    const hash = await emit(input);
    expect(hash).toMatch(/^0x[0-9a-fA-F]{64}$/);
    const calls = (wallet as unknown as { _calls: CallRecord[] })._calls;
    expect(calls).toHaveLength(1);
    expect(calls[0]!.to).toBe(wallet.address); // self-send
    expect(calls[0]!.value).toBe(0n);
    expect(calls[0]!.data).toMatch(/^0x/);
    // Round-trip: the data decodes to the expected payload
    expect(decodeLogPayload(calls[0]!.data)).toBe(buildLogPayload(input));
  });

  it('wraps RPC errors in WalletError', async () => {
    const wallet = makeStubWallet(undefined, () => {
      throw new Error('RPC down');
    });
    const { input } = mkInput('NG', 0, 0);
    const emit = createLogEmitter(wallet);
    await expect(emit(input)).rejects.toBeInstanceOf(WalletError);
  });

  it('WalletError message includes the payload for debuggability', async () => {
    const wallet = makeStubWallet(undefined, () => {
      throw new Error('boom');
    });
    const { input } = mkInput('KE', 0.5, 1);
    const emit = createLogEmitter(wallet);
    try {
      await emit(input);
    } catch (err) {
      expect(err).toBeInstanceOf(WalletError);
      expect((err as WalletError).message).toContain('agent-06:v1:KE:2024:0.50:1');
    }
  });
});

// Touch QueryOutput to keep the unused-type-import linter quiet — it's part
// of PipelineResult's shape but log-emitter doesn't reach into it directly.
void (null as unknown as QueryOutput);
