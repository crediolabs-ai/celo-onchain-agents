/**
 * Unit tests for the nl-query sub-agent.
 *
 * Owner: Tuan (nl-query sub-agent).
 *
 * Coverage:
 *   - intents.ts:    QueryIntentSchema discriminated union (all 8 arms)
 *   - execute.ts:    each of the 8 intent handlers, with fixture data
 *   - llm-translator: Anthropic client mock → tool_use → Zod validation,
 *                    plus error mapping (rate-limit, no tool_use block)
 *   - index.ts:     answerQueryWithDeps end-to-end with stub LLM,
 *                    plus graceful degradation when LLM fails
 */

import { describe, expect, it, vi } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import {
  type Address,
  type ClassifiedTx,
  type PnlOutput,
  type TxHash,
} from '../../src/shared/types.js';
import { NetworkError } from '../../src/shared/errors.js';
import {
  QueryIntentSchema,
  executeQuery,
  llmTranslateQuestion,
  answerQueryWithDeps,
  type LlmTranslatorDeps,
  type QueryIntent,
} from '../../src/sub-agents/nl-query/index.js';

// ─── Fixtures ──────────────────────────────────────────────────────────────

const ADDR_A = '0x0000000000000000000000000000000000000aaa' as Address;
const HASH = (n: number): TxHash =>
  ('0x' + n.toString(16).padStart(2, '0').repeat(32)) as TxHash;

const TS_2024_MID = 1_717_296_000; // 2024-06-01
const TS_2023_MID = 1_685_616_000; // 2023-06-01

function makeClassified(overrides: Partial<ClassifiedTx> = {}): ClassifiedTx {
  return {
    hash: HASH(1),
    type: 'INCOME',
    timestamp: TS_2024_MID,
    classifierSource: 'rule',
    assetIn: { symbol: 'CELO', amount: '100', priceUsd: 0.6 },
    ...overrides,
  };
}

function makePnl(overrides: Partial<PnlOutput> = {}): PnlOutput {
  return {
    address: ADDR_A,
    method: 'FIFO',
    taxYears: [
      {
        year: 2024,
        realizedGains: 1000,
        income: 500,
        yield: 200,
        interestEarned: 0,
        deductibleGas: 50,
        taxableIncome: 1650,
      },
      {
        year: 2023,
        realizedGains: 800,
        income: 300,
        yield: 100,
        interestEarned: 0,
        deductibleGas: 30,
        taxableIncome: 1170,
      },
    ],
    realizedPnlByAsset: { CELO: 700, USDC: 300, cUSD: 0 },
    unrealizedPnlByAsset: { CELO: 50, USDC: 25, cUSD: 0 },
    incomeTotal: 800,
    yieldTotal: 300,
    interestEarnedTotal: 0,
    priceGaps: [
      { asset: 'GOLD', timestamp: TS_2024_MID },
      { asset: 'OBSCURE', timestamp: TS_2023_MID },
    ],
    methodJurisdictionCompat: [
      { method: 'FIFO', jurisdiction: 'NG', ok: true },
      { method: 'LIFO', jurisdiction: 'NG', ok: false, reason: 'LIFO not permitted under NG FIRS' },
      { method: 'WAC', jurisdiction: 'NG', ok: true },
      { method: 'FIFO', jurisdiction: 'KE', ok: true },
      { method: 'LIFO', jurisdiction: 'KE', ok: false, reason: 'LIFO not permitted under KE KRA' },
      { method: 'WAC', jurisdiction: 'KE', ok: true },
    ],
    disposals: [],
    ...overrides,
  };
}

function makeAnthropicStub(
  impl: (params: any, opts?: any) => Promise<any>,
): Pick<Anthropic, 'messages'> {
  return {
    messages: { create: vi.fn(impl) } as unknown as Anthropic['messages'],
  };
}

function makeToolUse(input: Record<string, unknown>): { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> } {
  return { type: 'tool_use', id: 'tool_1', name: 'emit_intent', input };
}

// ─── intents.ts — Zod schema validation ───────────────────────────────────

describe('QueryIntentSchema', () => {
  it('accepts each of the 8 valid intent arms', () => {
    const valid: QueryIntent[] = [
      { kind: 'year_summary', taxYear: 2024 },
      { kind: 'tx_type_breakdown', type: 'SWAP', aggregation: 'sum', taxYear: 2024 },
      { kind: 'asset_pnl', asset: 'CELO', metric: 'realized' },
      { kind: 'jurisdiction_compat', method: 'LIFO', jurisdiction: 'NG' },
      { kind: 'top_assets', n: 3, by: 'realizedPnl' },
      { kind: 'list_transactions', source: 'flagged', limit: 50 },
      { kind: 'price_gaps', taxYear: 2024 },
      { kind: 'unknown' },
    ];
    for (const intent of valid) {
      expect(() => QueryIntentSchema.parse(intent)).not.toThrow();
    }
  });

  it('rejects unknown kind', () => {
    expect(() =>
      QueryIntentSchema.parse({ kind: 'delete_everything', target: 'wallet' }),
    ).toThrow();
  });

  it('rejects year_summary without taxYear', () => {
    expect(() => QueryIntentSchema.parse({ kind: 'year_summary' })).toThrow();
  });

  it('rejects year_summary with out-of-range taxYear', () => {
    expect(() => QueryIntentSchema.parse({ kind: 'year_summary', taxYear: 1999 })).toThrow();
    expect(() => QueryIntentSchema.parse({ kind: 'year_summary', taxYear: 2200 })).toThrow();
  });

  it('rejects tx_type_breakdown with invalid type', () => {
    expect(() =>
      QueryIntentSchema.parse({ kind: 'tx_type_breakdown', type: 'NOT_A_TYPE' }),
    ).toThrow();
  });

  it('rejects asset_pnl with empty asset', () => {
    expect(() =>
      QueryIntentSchema.parse({ kind: 'asset_pnl', asset: '', metric: 'realized' }),
    ).toThrow();
  });

  it('rejects top_assets with out-of-range n', () => {
    expect(() => QueryIntentSchema.parse({ kind: 'top_assets', n: 0, by: 'income' })).toThrow();
    expect(() => QueryIntentSchema.parse({ kind: 'top_assets', n: 100, by: 'income' })).toThrow();
  });

  it('rejects list_transactions with out-of-range limit', () => {
    expect(() =>
      QueryIntentSchema.parse({ kind: 'list_transactions', limit: 0 }),
    ).toThrow();
    expect(() =>
      QueryIntentSchema.parse({ kind: 'list_transactions', limit: 1000 }),
    ).toThrow();
  });

  it('rejects unknown fields (additionalProperties=false equivalent)', () => {
    expect(() =>
      QueryIntentSchema.parse({ kind: 'year_summary', taxYear: 2024, evil: true }),
    ).toThrow();
  });
});

// ─── execute.ts — deterministic handlers ───────────────────────────────────

describe('executeQuery', () => {
  const classified: ClassifiedTx[] = [
    makeClassified({ hash: HASH(1), type: 'INCOME', timestamp: TS_2024_MID }),
    makeClassified({ hash: HASH(2), type: 'SWAP', timestamp: TS_2024_MID }),
    makeClassified({ hash: HASH(3), type: 'SWAP', timestamp: TS_2023_MID }),
    makeClassified({
      hash: HASH(4),
      type: 'INCOME',
      timestamp: TS_2023_MID,
      assetIn: { symbol: 'USDC', amount: '200', priceUsd: 1 },
    }),
  ];
  const pnl = makePnl();

  describe('year_summary', () => {
    it('returns the summary numbers and cites tx hashes from that year', () => {
      const result = executeQuery({ kind: 'year_summary', taxYear: 2024 }, classified, pnl);
      expect(result.intent).toBe('year_summary');
      expect(result.numbers.taxableIncome).toBe(1650);
      expect(result.numbers.realizedGains).toBe(1000);
      expect(result.numbers.income).toBe(500);
      expect(result.citedTxHashes).toEqual([HASH(1), HASH(2)]);
      expect(result.answer).toContain('2024');
      expect(result.answer).toContain('$1650.00');
    });

    it('reports available years when asked about a missing year', () => {
      const result = executeQuery({ kind: 'year_summary', taxYear: 2099 }, classified, pnl);
      expect(result.numbers.found).toBe(0);
      expect(result.answer).toContain('No data');
      expect(result.answer).toContain('2023');
      expect(result.answer).toContain('2024');
    });
  });

  describe('tx_type_breakdown', () => {
    it('sum aggregation counts USD value of matching transactions', () => {
      const result = executeQuery(
        { kind: 'tx_type_breakdown', type: 'INCOME', aggregation: 'sum' },
        classified,
        pnl,
      );
      // INCOME tx #1: 100 CELO * $0.6 = $60
      // INCOME tx #4: 200 USDC * $1 = $200
      expect(result.numbers.count).toBe(2);
      expect(result.numbers.totalUsd).toBe(260);
    });

    it('count aggregation just counts', () => {
      const result = executeQuery(
        { kind: 'tx_type_breakdown', type: 'SWAP', aggregation: 'count' },
        classified,
        pnl,
      );
      expect(result.numbers.count).toBe(2);
      expect(result.numbers.totalUsd).toBeUndefined();
    });

    it('list aggregation produces readable transaction list', () => {
      const result = executeQuery(
        { kind: 'tx_type_breakdown', type: 'SWAP', aggregation: 'list' },
        classified,
        pnl,
      );
      expect(result.answer).toContain('SWAP');
      expect(result.answer).toContain('0x');
    });

    it('filters by taxYear when provided', () => {
      const result = executeQuery(
        { kind: 'tx_type_breakdown', type: 'SWAP', aggregation: 'count', taxYear: 2024 },
        classified,
        pnl,
      );
      expect(result.numbers.count).toBe(1);
    });
  });

  describe('asset_pnl', () => {
    it('returns realized PNL for an asset', () => {
      const result = executeQuery(
        { kind: 'asset_pnl', asset: 'CELO', metric: 'realized' },
        [],
        pnl,
      );
      expect(result.numbers.realized).toBe(700);
      expect(result.answer).toContain('CELO');
      expect(result.answer).toContain('$700.00');
    });

    it('returns unrealized PNL for an asset', () => {
      const result = executeQuery(
        { kind: 'asset_pnl', asset: 'USDC', metric: 'unrealized' },
        [],
        pnl,
      );
      expect(result.numbers.unrealized).toBe(25);
    });

    it('uppercases the asset symbol for lookup', () => {
      const result = executeQuery(
        { kind: 'asset_pnl', asset: 'celo', metric: 'realized' },
        [],
        pnl,
      );
      expect(result.numbers.realized).toBe(700);
    });

    it('returns 0 for unknown assets', () => {
      const result = executeQuery(
        { kind: 'asset_pnl', asset: 'NOPE', metric: 'realized' },
        [],
        pnl,
      );
      expect(result.numbers.realized).toBe(0);
    });

    it('returns all metrics for metric=all', () => {
      const result = executeQuery(
        { kind: 'asset_pnl', asset: 'CELO', metric: 'all' },
        [],
        pnl,
      );
      expect(result.numbers.realized).toBe(700);
      expect(result.numbers.unrealized).toBe(50);
    });
  });

  describe('jurisdiction_compat', () => {
    it('reports legal combinations as legal', () => {
      const result = executeQuery(
        { kind: 'jurisdiction_compat', method: 'FIFO', jurisdiction: 'NG' },
        [],
        pnl,
      );
      expect(result.numbers.ok).toBe(1);
      expect(result.answer).toContain('legal');
    });

    it('reports illegal combinations with reason', () => {
      const result = executeQuery(
        { kind: 'jurisdiction_compat', method: 'LIFO', jurisdiction: 'NG' },
        [],
        pnl,
      );
      expect(result.numbers.ok).toBe(0);
      expect(result.answer).toContain('NOT permitted');
      expect(result.answer).toContain('NG FIRS');
    });
  });

  describe('top_assets', () => {
    it('ranks assets by realized PNL and returns top N', () => {
      const result = executeQuery(
        { kind: 'top_assets', n: 2, by: 'realizedPnl' },
        [],
        pnl,
      );
      expect(result.answer).toContain('CELO');
      expect(result.answer).toContain('USDC');
      expect(result.answer).toContain('$700.00');
      expect(result.answer).not.toContain('cUSD'); // cUSD is 0, so excluded
    });

    it('respects n=1', () => {
      const result = executeQuery({ kind: 'top_assets', n: 1, by: 'realizedPnl' }, [], pnl);
      expect(Object.keys(result.numbers)).toHaveLength(1);
      expect(result.answer).toContain('1.');
    });
  });

  describe('list_transactions', () => {
    it('lists by type with no source filter', () => {
      const result = executeQuery(
        { kind: 'list_transactions', type: 'INCOME', source: 'any', limit: 10 },
        classified,
        pnl,
      );
      expect(result.numbers.matched).toBe(2);
      expect(result.answer).toContain('INCOME');
    });

    it('filters by classifierSource=flagged', () => {
      const withFlagged: ClassifiedTx[] = [
        ...classified,
        makeClassified({ hash: HASH(5), type: 'SWAP', classifierSource: 'flagged' }),
      ];
      const result = executeQuery(
        { kind: 'list_transactions', source: 'flagged', limit: 10 },
        withFlagged,
        pnl,
      );
      expect(result.numbers.matched).toBe(1);
      expect(result.citedTxHashes).toEqual([HASH(5)]);
    });

    it('respects limit', () => {
      const result = executeQuery(
        { kind: 'list_transactions', source: 'any', limit: 1 },
        classified,
        pnl,
      );
      expect(result.numbers.returned).toBe(1);
      expect(result.citedTxHashes).toHaveLength(1);
    });
  });

  describe('price_gaps', () => {
    it('lists distinct assets with missing prices', () => {
      const result = executeQuery({ kind: 'price_gaps' }, classified, pnl);
      expect(result.numbers.gapCount).toBe(2);
      expect(result.numbers.assetCount).toBe(2);
      expect(result.answer).toContain('GOLD');
      expect(result.answer).toContain('OBSCURE');
    });

    it('filters by taxYear', () => {
      const result = executeQuery({ kind: 'price_gaps', taxYear: 2024 }, classified, pnl);
      expect(result.numbers.gapCount).toBe(1);
      expect(result.answer).toContain('GOLD');
      expect(result.answer).not.toContain('OBSCURE');
    });
  });

  describe('unknown', () => {
    it('returns a helpful fallback message', () => {
      const result = executeQuery({ kind: 'unknown' }, classified, pnl);
      expect(result.answer).toContain("couldn't map");
      expect(result.citedTxHashes).toEqual([]);
    });
  });
});

// ─── llm-translator.ts — Anthropic stub ────────────────────────────────────

describe('llmTranslateQuestion', () => {
  it('parses a valid tool_use response into a QueryIntent', async () => {
    const stub = makeAnthropicStub(async () => ({
      stop_reason: 'end_turn',
      content: [makeToolUse({ kind: 'year_summary', taxYear: 2024 })],
    }));
    const deps: LlmTranslatorDeps = { client: stub };
    const intent = await llmTranslateQuestion('What was my 2024 income?', deps);
    expect(intent).toEqual({ kind: 'year_summary', taxYear: 2024 });
  });

  it('rejects malformed tool_use input via Zod', async () => {
    const stub = makeAnthropicStub(async () => ({
      stop_reason: 'end_turn',
      content: [makeToolUse({ kind: 'year_summary', taxYear: 'twenty-twenty' })],
    }));
    const deps: LlmTranslatorDeps = { client: stub };
    await expect(llmTranslateQuestion('boom', deps)).rejects.toBeInstanceOf(Error);
  });

  it('throws NetworkError when response has no tool_use block', async () => {
    const stub = makeAnthropicStub(async () => ({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'I cannot help with that.' }],
    }));
    const deps: LlmTranslatorDeps = { client: stub };
    await expect(llmTranslateQuestion('hello', deps)).rejects.toBeInstanceOf(NetworkError);
  });

  it('respects abort signal (passes through to client)', async () => {
    let receivedSignal: AbortSignal | undefined;
    const stub = makeAnthropicStub(async (_params, opts) => {
      receivedSignal = opts?.signal;
      return { stop_reason: 'end_turn', content: [] };
    });
    const ctrl = new AbortController();
    const deps: LlmTranslatorDeps = { client: stub, signal: ctrl.signal };
    await expect(llmTranslateQuestion('whatever', deps)).rejects.toBeInstanceOf(NetworkError);
    expect(receivedSignal).toBe(ctrl.signal);
  });
});

// ─── index.ts — end-to-end with stub LLM ───────────────────────────────────

describe('answerQueryWithDeps', () => {
  const classified = [
    makeClassified({ hash: HASH(1), type: 'INCOME', timestamp: TS_2024_MID }),
  ];
  const pnl = makePnl();
  const input = { question: 'whatever', classified, pnl, jurisdiction: 'NG' as const };

  it('answers a year_summary question end-to-end', async () => {
    const stub = makeAnthropicStub(async () => ({
      stop_reason: 'end_turn',
      content: [makeToolUse({ kind: 'year_summary', taxYear: 2024 })],
    }));
    const out = await answerQueryWithDeps(input, { llm: { client: stub } });
    expect(out.answer).toContain('2024');
    expect(out.answer).toContain('$1650.00');
    expect(out.supportingNumbers.taxableIncome).toBe(1650);
    expect(out.citedTxHashes).toContain(HASH(1));
  });

  it('answers a list_transactions question end-to-end', async () => {
    const stub = makeAnthropicStub(async () => ({
      stop_reason: 'end_turn',
      content: [makeToolUse({ kind: 'list_transactions', source: 'any', limit: 5 })],
    }));
    const out = await answerQueryWithDeps(input, { llm: { client: stub } });
    expect(out.answer).toContain('INCOME');
    expect(out.citedTxHashes).toContain(HASH(1));
  });

  it('degrades gracefully when the LLM is unreachable', async () => {
    const stub = makeAnthropicStub(async () => {
      throw new Error('connection refused');
    });
    const out = await answerQueryWithDeps(input, { llm: { client: stub } });
    expect(out.answer).toContain('could not reach');
    expect(out.supportingNumbers).toEqual({});
    expect(out.citedTxHashes).toEqual([]);
  });

  it('degrades gracefully when the LLM returns malformed intent', async () => {
    const stub = makeAnthropicStub(async () => ({
      stop_reason: 'end_turn',
      content: [makeToolUse({ kind: 'year_summary', taxYear: 'soon' })],
    }));
    const out = await answerQueryWithDeps(input, { llm: { client: stub } });
    expect(out.answer).toContain('could not reach');
  });

  it('returns the unknown fallback when the LLM picks unknown', async () => {
    const stub = makeAnthropicStub(async () => ({
      stop_reason: 'end_turn',
      content: [makeToolUse({ kind: 'unknown' })],
    }));
    const out = await answerQueryWithDeps(input, { llm: { client: stub } });
    expect(out.answer).toContain("couldn't map");
  });
});
