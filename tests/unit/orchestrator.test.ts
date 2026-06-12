/**
 * Unit tests for the orchestrator pipeline + fixture wiring.
 *
 * Owner: Credio (orchestrator).
 *
 * Coverage:
 *   - runPipeline: end-to-end against the fixture, every stage called once
 *   - runPipeline: omits optional stages when not requested (no NL query, no log)
 *   - runPipeline: includes NL query stage when req.nlQuery is set
 *   - runPipeline: includes onchain log stage when req.emitOnchainLog=true
 *   - runPipeline: catches emitOnchainLog errors so they don't void the report
 *   - runPipeline: propagates stage errors (no silent failures)
 *   - makeFixtureDeps: pass-through for every stage function
 *   - resolveNetwork: env config → orchestrator Network mapping
 */

import { describe, expect, it, vi } from 'vitest';
import {
  runPipeline,
  makeFixtureDeps,
  resolveNetwork,
  type PipelineDeps,
} from '../../src/orchestrator/index.js';
import type { ContractLookup } from '../../src/shared/contracts.js';
import { makeContractLookup } from '../../src/shared/contracts.js';
import { walletFixture } from '../fixtures/wallet-fixture.js';
import type {
  CsvExportInput,
  PipelineRequest,
  QueryInput,
  QueryOutput,
  TxHash,
} from '../../src/shared/types.js';

const NETWORK = 'alfajores' as const;
const LOOKUP: ContractLookup = makeContractLookup('alfajores');

function mkRequest(overrides: Partial<PipelineRequest> = {}): PipelineRequest {
  return {
    address: walletFixture.address,
    jurisdiction: 'NG',
    method: 'FIFO',
    taxYear: 2024,
    ...overrides,
  };
}

// ─── runPipeline ───────────────────────────────────────────────────────────

describe('runPipeline', () => {
  it('executes every stage in order against the fixture', async () => {
    const calls: string[] = [];
    const fixtureDeps = makeFixtureDeps(walletFixture);
    const deps: PipelineDeps = {
      ...fixtureDeps,
      fetchTxs: vi.fn(async (req) => {
        calls.push('fetch');
        return fixtureDeps.fetchTxs(req);
      }),
      classify: vi.fn(async (input) => {
        calls.push('classify');
        return fixtureDeps.classify(input);
      }),
      computePnl: vi.fn(async (input) => {
        calls.push('computePnl');
        return fixtureDeps.computePnl(input);
      }),
      exportCsv: vi.fn(async (input) => {
        calls.push('exportCsv');
        return fixtureDeps.exportCsv(input);
      }),
      answerQuery: vi.fn(async (input) => {
        calls.push('answerQuery');
        return fixtureDeps.answerQuery(input);
      }),
    };

    const result = await runPipeline({
      request: mkRequest(),
      deps,
      network: NETWORK,
      contractLookup: LOOKUP,
    });

    expect(calls).toEqual(['fetch', 'classify', 'computePnl', 'exportCsv']);
    expect(result.fetched).toBe(walletFixture.fetched);
    expect(result.classified).toBe(walletFixture.classified);
    expect(result.pnl).toBe(walletFixture.pnl);
    expect(result.csv).toBe(walletFixture.csv);
    expect(result.queryAnswer).toBeUndefined();
    expect(result.onchainLogTxHash).toBeUndefined();
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('skips the answerQuery stage when req.nlQuery is omitted', async () => {
    const answerQuery = vi.fn();
    const deps: PipelineDeps = {
      ...makeFixtureDeps(walletFixture),
      answerQuery,
    };

    const result = await runPipeline({
      request: mkRequest(),
      deps,
      network: NETWORK,
      contractLookup: LOOKUP,
    });
    expect(answerQuery).not.toHaveBeenCalled();
    expect(result.queryAnswer).toBeUndefined();
  });

  it('skips the answerQuery stage when req.nlQuery is an empty string', async () => {
    const answerQuery = vi.fn();
    const deps: PipelineDeps = {
      ...makeFixtureDeps(walletFixture),
      answerQuery,
    };

    const result = await runPipeline({
      request: mkRequest({ nlQuery: '' }),
      deps,
      network: NETWORK,
      contractLookup: LOOKUP,
    });
    expect(answerQuery).not.toHaveBeenCalled();
    expect(result.queryAnswer).toBeUndefined();
  });

  it('calls answerQuery with req.nlQuery + jurisdiction pre-attached', async () => {
    const answerQuery = vi.fn(
      async (input: QueryInput): Promise<QueryOutput> => ({
        answer: `stub: ${input.question}`,
        supportingNumbers: { gain: 0.05 },
        citedTxHashes: [],
      }),
    );
    const deps: PipelineDeps = {
      ...makeFixtureDeps(walletFixture),
      answerQuery,
    };

    const result = await runPipeline({
      request: mkRequest({ nlQuery: 'What was my 2024 income?', jurisdiction: 'KE' }),
      deps,
      network: NETWORK,
      contractLookup: LOOKUP,
    });

    expect(answerQuery).toHaveBeenCalledOnce();
    const call = answerQuery.mock.calls[0]![0] as QueryInput;
    expect(call.question).toBe('What was my 2024 income?');
    expect(call.jurisdiction).toBe('KE');
    expect(call.classified).toBe(walletFixture.classified.classified);
    expect(call.pnl).toBe(walletFixture.pnl);
    expect(result.queryAnswer?.answer).toMatch(/stub:/);
  });

  it('skips emitOnchainLog when req.emitOnchainLog is not set', async () => {
    const emitOnchainLog = vi.fn(async () => '0x' + 'ab'.repeat(32) as TxHash);
    const deps: PipelineDeps = {
      ...makeFixtureDeps(walletFixture),
      emitOnchainLog,
    };

    const result = await runPipeline({
      request: mkRequest(),
      deps,
      network: NETWORK,
      contractLookup: LOOKUP,
    });
    expect(emitOnchainLog).not.toHaveBeenCalled();
    expect(result.onchainLogTxHash).toBeUndefined();
  });

  it('calls emitOnchainLog and captures the returned tx hash when set', async () => {
    const logHash = ('0x' + 'cc'.repeat(32)) as TxHash;
    const emitOnchainLog = vi.fn(async () => logHash);
    const deps: PipelineDeps = {
      ...makeFixtureDeps(walletFixture),
      emitOnchainLog,
    };

    const result = await runPipeline({
      request: mkRequest({ emitOnchainLog: true }),
      deps,
      network: NETWORK,
      contractLookup: LOOKUP,
    });
    expect(emitOnchainLog).toHaveBeenCalledOnce();
    expect(result.onchainLogTxHash).toBe(logHash);
  });

  it('catches emitOnchainLog errors and still returns the tax report', async () => {
    const deps: PipelineDeps = {
      ...makeFixtureDeps(walletFixture),
      emitOnchainLog: vi.fn(async () => {
        throw new Error('RPC down');
      }),
    };

    const result = await runPipeline({
      request: mkRequest({ emitOnchainLog: true }),
      deps,
      network: NETWORK,
      contractLookup: LOOKUP,
    });
    // Report is intact; log failure is non-fatal.
    expect(result.pnl).toBe(walletFixture.pnl);
    expect(result.csv).toBe(walletFixture.csv);
    expect(result.onchainLogTxHash).toBeUndefined();
  });

  it('propagates fetchTxs errors (the one hard failure)', async () => {
    const deps: PipelineDeps = {
      ...makeFixtureDeps(walletFixture),
      fetchTxs: vi.fn(async () => {
        throw new Error('Celoscan 503');
      }),
    };

    await expect(
      runPipeline({
        request: mkRequest(),
        deps,
        network: NETWORK,
        contractLookup: LOOKUP,
      }),
    ).rejects.toThrow(/Celoscan 503/);
  });

  it('propagates classify errors after a successful fetch', async () => {
    const deps: PipelineDeps = {
      ...makeFixtureDeps(walletFixture),
      classify: vi.fn(async () => {
        throw new Error('LLM unreachable');
      }),
    };

    await expect(
      runPipeline({
        request: mkRequest(),
        deps,
        network: NETWORK,
        contractLookup: LOOKUP,
      }),
    ).rejects.toThrow(/LLM unreachable/);
  });
});

// ─── makeFixtureDeps ───────────────────────────────────────────────────────

describe('makeFixtureDeps', () => {
  it('returns the fixture.fetched from fetchTxs', async () => {
    const deps = makeFixtureDeps(walletFixture);
    const out = await deps.fetchTxs(mkRequest());
    expect(out).toBe(walletFixture.fetched);
  });

  it('returns the fixture.classified from classify', async () => {
    const deps = makeFixtureDeps(walletFixture);
    const out = await deps.classify({
      fetched: walletFixture.fetched,
      network: NETWORK,
      contractLookup: LOOKUP,
    });
    expect(out).toBe(walletFixture.classified);
  });

  it('returns the fixture.pnl from computePnl', async () => {
    const deps = makeFixtureDeps(walletFixture);
    const out = await deps.computePnl({
      classified: walletFixture.classified.classified,
      address: walletFixture.address,
      method: 'FIFO',
      taxYear: 2024,
      jurisdiction: 'NG',
    });
    expect(out).toBe(walletFixture.pnl);
  });

  it('returns the fixture.csv from exportCsv', async () => {
    const deps = makeFixtureDeps(walletFixture);
    const input: CsvExportInput = {
      classified: walletFixture.classified.classified,
      pnl: walletFixture.pnl,
      jurisdiction: 'NG',
      taxYear: 2024,
    };
    const out = await deps.exportCsv(input);
    expect(out).toBe(walletFixture.csv);
  });

  it('returns a deterministic stub from answerQuery', async () => {
    const deps = makeFixtureDeps(walletFixture);
    const out = await deps.answerQuery({
      question: 'Anything?',
      classified: walletFixture.classified.classified,
      pnl: walletFixture.pnl,
      jurisdiction: 'NG',
    });
    expect(out.answer).toMatch(/fixture-mode/);
    expect(out.answer).toContain('Anything?');
    expect(out.supportingNumbers).toEqual({});
    expect(out.citedTxHashes).toEqual([]);
  });

  it('omits emitOnchainLog entirely (no log in fixture mode)', () => {
    const deps = makeFixtureDeps(walletFixture);
    expect(deps.emitOnchainLog).toBeUndefined();
  });
});

// ─── resolveNetwork ────────────────────────────────────────────────────────

describe('resolveNetwork', () => {
  it('maps mainnet config → mainnet', () => {
    expect(resolveNetwork('mainnet')).toBe('mainnet');
  });

  it('passes alfajores config through unchanged', () => {
    // Identity for now; will translate the Celo Sepolia chainId once
    // the pilot green-lights the network swap.
    expect(resolveNetwork('alfajores')).toBe('alfajores');
  });
});
