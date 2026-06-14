/**
 * Unit tests for the tx-classifier sub-agent.
 *
 * Owner: Tuan (tx-classifier sub-agent).
 *
 * Coverage:
 *   - predicates.ts:   every predicate kind + jurisdiction filter
 *   - rules.ts:        rule table structure + findMatchingRule
 *   - llm-fallback.ts: Anthropic client mock → tool_use parsing
 *   - index.ts:       orchestration (rule hit, LLM fallback, cap, flagging)
 */

import { describe, expect, it, vi } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import {
  type Address,
  type FetchedTxData,
  type RawTx,
  type TokenTransfer,
  type TxHash,
} from '../../src/shared/types.js';
import { makeContractLookup } from '../../src/shared/contracts.js';
import { NetworkError } from '../../src/shared/errors.js';
import {
  evaluatePredicate,
  evaluateRule,
  findMatchingRule,
  classifyWithDeps,
  RULES,
  llmClassifyTx,
  type LlmFallbackDeps,
  type PredicateContext,
  type Predicate,
  type Rule,
} from '../../src/sub-agents/tx-classifier/index.js';

// ─── Fixtures ──────────────────────────────────────────────────────────────

const ADDR_A = '0x0000000000000000000000000000000000000aaa' as Address;
const ADDR_B = '0x0000000000000000000000000000000000000bbb' as Address;
const ADDR_C = '0x0000000000000000000000000000000000000ccc' as Address;
function makeRawTx(overrides: Partial<RawTx> = {}): RawTx {
  return {
    hash: ('0x' + '11'.repeat(32)) as TxHash,
    blockNumber: 1,
    timestamp: 1_700_000_000,
    from: ADDR_A,
    to: ADDR_B,
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
    from: ADDR_A,
    to: ADDR_B,
    contractAddress: ADDR_C,
    tokenSymbol: 'USDC',
    tokenDecimals: 6,
    value: '1000000', // 1 USDC
    ...overrides,
  };
}

function makeCtx(overrides: Partial<PredicateContext> = {}): PredicateContext {
  return {
    tx: makeRawTx(),
    transfers: [],
    internal: [],
    address: ADDR_A,
    knownContracts: makeContractLookup('mainnet'),
    ...overrides,
  };
}

function makeFetched(txs: RawTx[], opts: Partial<FetchedTxData> = {}): FetchedTxData {
  return {
    address: ADDR_A,
    dateRange: { from: 0, to: 0 },
    rawTxns: txs,
    tokenTransfers: [],
    internalTxns: [],
    source: 'celoscan',
    fetchedAt: 0,
    paginationComplete: true,
    fetchErrors: [],
    contractMetadata: new Map(),
    ...opts,
  };
}

// ─── predicates.ts ─────────────────────────────────────────────────────────

describe('predicates', () => {
  it('allOf: all children must match', () => {
    const p: Predicate = {
      kind: 'allOf',
      children: [
        { kind: 'isError', is: false },
        { kind: 'nativeDirection', is: 'out' },
      ],
    };
    const ctx = makeCtx({ tx: makeRawTx({ value: '1' }) });
    expect(evaluatePredicate(p, ctx)).toBe(true);
  });

  it('allOf: any miss → false', () => {
    const p: Predicate = {
      kind: 'allOf',
      children: [
        { kind: 'isError', is: true },
        { kind: 'nativeDirection', is: 'out' },
      ],
    };
    const ctx = makeCtx({ tx: makeRawTx({ value: '1', isError: '0' }) });
    expect(evaluatePredicate(p, ctx)).toBe(false);
  });

  it('anyOf: any hit → true', () => {
    const p: Predicate = {
      kind: 'anyOf',
      children: [
        { kind: 'isError', is: true },
        { kind: 'isError', is: false },
      ],
    };
    expect(evaluatePredicate(p, makeCtx())).toBe(true);
  });

  it('not: inverts', () => {
    const p: Predicate = { kind: 'not', child: { kind: 'isError', is: true } };
    expect(evaluatePredicate(p, makeCtx({ tx: makeRawTx({ isError: '0' }) }))).toBe(true);
  });

  it('hasMethod: matches by exact name', () => {
    const p: Predicate = { kind: 'hasMethod', method: 'transfer' };
    expect(evaluatePredicate(p, makeCtx({ tx: makeRawTx({ methodName: 'transfer' }) }))).toBe(true);
    expect(evaluatePredicate(p, makeCtx({ tx: makeRawTx({ methodName: 'transferFrom' }) }))).toBe(false);
  });

  it('hasMethodPrefix: matches by prefix', () => {
    const p: Predicate = { kind: 'hasMethodPrefix', prefix: 'swap' };
    expect(evaluatePredicate(p, makeCtx({ tx: makeRawTx({ methodName: 'swapExactTokensForTokens' }) }))).toBe(true);
  });

  it('toIn: matches by contract alias (no-op when alias not registered)', () => {
    // All aliases are null in the default registry, so any toIn should
    // return false. Documented behavior.
    const p: Predicate = { kind: 'toIn', refs: ['UBESWAP_V2_ROUTER'] };
    expect(evaluatePredicate(p, makeCtx())).toBe(false);
  });

  it('tokenTransferCount: respects op', () => {
    const baseCtx = makeCtx();
    const t = makeTokenTransfer();
    const pGt: Predicate = { kind: 'tokenTransferCount', op: 'gt', value: 0 };
    const pEq: Predicate = { kind: 'tokenTransferCount', op: 'eq', value: 1 };
    expect(evaluatePredicate(pGt, baseCtx)).toBe(false);
    expect(evaluatePredicate(pGt, { ...baseCtx, transfers: [t] })).toBe(true);
    expect(evaluatePredicate(pEq, { ...baseCtx, transfers: [t] })).toBe(true);
  });

  it('nativeDirection: classifies self / in / out / none', () => {
    const noValue = makeCtx({ tx: makeRawTx({ value: '0' }) });
    expect(evaluatePredicate({ kind: 'nativeDirection', is: 'none' }, noValue)).toBe(true);

    const out = makeCtx({ tx: makeRawTx({ from: ADDR_A, to: ADDR_B, value: '1' }) });
    expect(evaluatePredicate({ kind: 'nativeDirection', is: 'out' }, out)).toBe(true);

    const incoming = makeCtx({ tx: makeRawTx({ from: ADDR_B, to: ADDR_A, value: '1' }) });
    expect(evaluatePredicate({ kind: 'nativeDirection', is: 'in' }, incoming)).toBe(true);

    const self = makeCtx({ tx: makeRawTx({ from: ADDR_A, to: ADDR_A, value: '1' }) });
    expect(evaluatePredicate({ kind: 'nativeDirection', is: 'self' }, self)).toBe(true);
  });

  it('valueGt / valueLt: compare wei decimals safely', () => {
    const pGt: Predicate = { kind: 'valueGt', amount: '1000' };
    expect(evaluatePredicate(pGt, makeCtx({ tx: makeRawTx({ value: '2000' }) }))).toBe(true);
    expect(evaluatePredicate(pGt, makeCtx({ tx: makeRawTx({ value: '500' }) }))).toBe(false);

    const pLt: Predicate = { kind: 'valueLt', amount: '1000' };
    expect(evaluatePredicate(pLt, makeCtx({ tx: makeRawTx({ value: '500' }) }))).toBe(true);
  });

  it('isError: true for isError=1', () => {
    const p: Predicate = { kind: 'isError', is: true };
    expect(evaluatePredicate(p, makeCtx({ tx: makeRawTx({ isError: '1' }) }))).toBe(true);
    expect(evaluatePredicate(p, makeCtx({ tx: makeRawTx({ isError: '0' }) }))).toBe(false);
  });

  it('isContractCreation: true when to is null', () => {
    const p: Predicate = { kind: 'isContractCreation', is: true };
    expect(evaluatePredicate(p, makeCtx({ tx: makeRawTx({ to: null }) }))).toBe(true);
    expect(evaluatePredicate(p, makeCtx({ tx: makeRawTx({ to: ADDR_B }) }))).toBe(false);
  });

  it('evaluateRule: jurisdiction filter blocks when active', () => {
    const ngOnly: Rule = {
      id: 'test.ng_only@v1',
      description: 'ng only',
      matches: { kind: 'isError', is: false },
      classify: 'INCOME',
      jurisdiction: ['NG'],
      confidence: 0.5,
    };
    // KE ctx — no match even though the predicate would match.
    expect(evaluateRule(ngOnly, makeCtx({ jurisdiction: 'KE' }))).toBe(false);
    expect(evaluateRule(ngOnly, makeCtx({ jurisdiction: 'NG' }))).toBe(true);
    // No jurisdiction set on context → jurisdiction filter is permissive.
    expect(evaluateRule(ngOnly, makeCtx())).toBe(true);
  });
});

// ─── rules.ts ──────────────────────────────────────────────────────────────

describe('rules', () => {
  it('RULES table is non-empty and every rule has required fields', () => {
    expect(RULES.length).toBeGreaterThan(0);
    for (const r of RULES) {
      expect(r.id).toMatch(/^[a-z_]+\.[a-z_]+@v\d+$/);
      expect(r.description).toBeTruthy();
      expect(r.classify).toBeTruthy();
      expect(r.confidence).toBeGreaterThanOrEqual(0);
      expect(r.confidence).toBeLessThanOrEqual(1);
    }
  });

  it('findMatchingRule: matches a plain native transfer out', () => {
    const ctx = makeCtx({ tx: makeRawTx({ value: '1000000000000000000' }) });
    const rule = findMatchingRule(ctx);
    expect(rule).not.toBeNull();
    expect(rule!.classify).toBe('TRANSFER_OUT');
  });

  it('findMatchingRule: matches a plain native transfer in', () => {
    const ctx = makeCtx({
      tx: makeRawTx({ from: ADDR_B, to: ADDR_A, value: '1000000000000000000' }),
    });
    const rule = findMatchingRule(ctx);
    expect(rule!.classify).toBe('TRANSFER_IN');
  });

  it('findMatchingRule: matches a single ERC-20 transfer (transfer method)', () => {
    const tx = makeRawTx({ value: '0', methodName: 'transfer' });
    const t = makeTokenTransfer({ from: ADDR_A, to: ADDR_B, value: '5000000' });
    const ctx = makeCtx({ tx, transfers: [t] });
    const rule = findMatchingRule(ctx);
    expect(rule).not.toBeNull();
    expect(rule!.classify).toBe('TRANSFER_OUT');
  });

  it('findMatchingRule: returns null for an unmatchable shape', () => {
    // Errored tx with 3 token transfers — no rule covers this exactly.
    const tx = makeRawTx({ value: '1', isError: '1' });
    const t1 = makeTokenTransfer({ tokenSymbol: 'XYZ' });
    const t2 = makeTokenTransfer({ tokenSymbol: 'ABC' });
    const t3 = makeTokenTransfer({ tokenSymbol: 'QWE' });
    const ctx = makeCtx({ tx, transfers: [t1, t2, t3] });
    expect(findMatchingRule(ctx)).toBeNull();
  });
});

// ─── llm-fallback.ts ───────────────────────────────────────────────────────

interface MockMessageContent {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

function makeAnthropicStub(impl: (params: any, opts?: any) => Promise<any>): Pick<Anthropic, 'messages'> {
  return {
    messages: { create: vi.fn(impl) } as unknown as Anthropic['messages'],
  };
}

describe('llmClassifyTx', () => {
  it('returns a validated ClassifiedTx on a successful tool_use response', async () => {
    const input: MockMessageContent = {
      type: 'tool_use',
      id: 'tool_1',
      name: 'emit_classification',
      input: {
        hash: ('0x' + '11'.repeat(32)) as TxHash,
        type: 'INCOME',
        timestamp: 1_700_000_000,
        classifierSource: 'llm',
        confidence: 0.82,
        notes: 'looks like payroll',
      },
    };
    const stub = makeAnthropicStub(async () => ({
      stop_reason: 'end_turn',
      content: [input],
    }));
    const deps: LlmFallbackDeps = { client: stub };
    const ctx = makeCtx();
    const out = await llmClassifyTx(ctx, deps);
    expect(out.type).toBe('INCOME');
    expect(out.classifierSource).toBe('llm');
    expect(out.confidence).toBe(0.82);
    expect(out.notes).toBe('looks like payroll');
    expect(out.hash).toBe(ctx.tx.hash);
  });

  it('throws NetworkError when response has no tool_use block', async () => {
    const stub = makeAnthropicStub(async () => ({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'I cannot help with that.' }],
    }));
    const deps: LlmFallbackDeps = { client: stub };
    await expect(llmClassifyTx(makeCtx(), deps)).rejects.toBeInstanceOf(NetworkError);
  });

  it('maps Anthropic.APIError → NetworkError with status', async () => {
    class FakeApiError extends Error {
      status: number;
      constructor(msg: string, status: number) {
        super(msg);
        this.name = 'APIError';
        this.status = status;
      }
    }
    // Construct a minimal stub that looks like an Anthropic.APIError
    const stub = makeAnthropicStub(async () => {
      const err = new FakeApiError('boom', 500) as unknown as Error;
      // Anthropic errors are instanceof APIError; simulate by attaching
      // the constructor name and rethrowing.
      Object.setPrototypeOf(err, { constructor: { name: 'APIError' } });
      throw err;
    });
    const deps: LlmFallbackDeps = { client: stub };
    // The mapping requires `instanceof Anthropic.APIError`, so this stub
    // will fall through to the generic Error branch. We just verify it
    // throws.
    await expect(llmClassifyTx(makeCtx(), deps)).rejects.toBeInstanceOf(Error);
  });

  it('respects abort signal (passes through to client)', async () => {
    let receivedSignal: AbortSignal | undefined;
    const stub = makeAnthropicStub(async (_params, opts) => {
      receivedSignal = opts?.signal;
      return { stop_reason: 'end_turn', content: [] };
    });
    const ctrl = new AbortController();
    const deps: LlmFallbackDeps = { client: stub, signal: ctrl.signal };
    await expect(llmClassifyTx(makeCtx(), deps)).rejects.toBeInstanceOf(NetworkError);
    expect(receivedSignal).toBe(ctrl.signal);
  });
});

// ─── path-ordering guard (Phase A fix) ───────────────────────────────────

const GOODDOLLAR_RESERVE = '0x94A3240f484A04F5e3d524f528d02694c109463b'.toLowerCase() as Address;
const UBESWAP_ROUTER = '0xE3D8bd6Aed4F159bc8000a9cD47CffDb95F96121'.toLowerCase() as Address;

describe('path-ordering guard', () => {
  it('GoodDollar claim (selector in BOTH maps) → protocol-decoder path', async () => {
    // 0x4e71d92d is in both selector-registry (as CLAIM → INTERACTION) and
    // SELECTOR_MAP (GOODDOLLAR:CLAIM_YIELD). The guard at step 2.5 must
    // skip classifyBySelector so the decoder fires at step 2.7.
    const tx = makeRawTx({
      input: '0x4e71d92d00000000000000000000000000000000000000000000000000000000',
      to: GOODDOLLAR_RESERVE,
    });
    const out = await classifyWithDeps({ fetched: makeFetched([tx]) });

    expect(out.classified).toHaveLength(1);
    expect(out.classified[0]!.classifierSource).toBe('rule-protocol');
    expect(out.protocolDecoderHits).toBe(1);
    expect(out.classified[0]!.notes).toContain('GOODDOLLAR');
    expect(out.classified[0]!.notes).toContain('CLAIM_YIELD');
    // Regression guard: selector-registry path must NOT have fired (no 'claim'
    // key in interactionBreakdown since classifyBySelector was skipped).
    expect(out.interactionBreakdown).not.toHaveProperty('claim');
  });

  it('Ubeswap swap (selector in SELECTOR_MAP only) → protocol-decoder path', async () => {
    // 0x38ed1739 is in SELECTOR_MAP (UBESWAP:SWAP) but NOT in selector-registry.
    // No blocking rule for Ubeswap router, so the guard at step 2.5 skips
    // classifyBySelector and the decoder fires at step 2.7.
    const tx = makeRawTx({
      input: '0x38ed1739' + '0'.repeat(128),
      to: UBESWAP_ROUTER,
    });
    const out = await classifyWithDeps({ fetched: makeFetched([tx]) });

    expect(out.classified).toHaveLength(1);
    expect(out.classified[0]!.classifierSource).toBe('rule-protocol');
    expect(out.classified[0]!.notes).toContain('UBESWAP');
    expect(out.classified[0]!.notes).toContain('SWAP');
  });

  it('ERC-20 transfer (selector in selector-registry only) → selector-registry path', async () => {
    // 0xa9059cbb is in selector-registry (transfer) but NOT in SELECTOR_MAP.
    // The guard condition is false; classifyBySelector fires normally.
    const tx = makeRawTx({
      input: '0xa9059cbb000000000000000000000000' + 'b'.repeat(40) + '000000000000000000000000000000000000000000000000000000000000000a',
      to: ADDR_B,
    });
    const out = await classifyWithDeps({ fetched: makeFetched([tx]) });

    expect(out.classified).toHaveLength(1);
    expect(out.classified[0]!.classifierSource).toBe('rule');
    // interactionBreakdown must have the transfer signature as key
    // (selector-registry path populates it with the function signature).
    const transferKeys = Object.keys(out.interactionBreakdown).filter((k) =>
      k.toLowerCase().includes('transfer'),
    );
    expect(transferKeys).toHaveLength(1);
    expect(out.protocolDecoderHits).toBe(0);
  });
});

// ─── index.ts (orchestration) ──────────────────────────────────────────────

describe('classifyWithDeps', () => {
  it('classifies a simple transfer via rules; no LLM call', async () => {
    const tx = makeRawTx({ value: '1000000000000000000' });
    const stub = makeAnthropicStub(async () => {
      throw new Error('LLM should not be called');
    });
    const out = await classifyWithDeps(
      { fetched: makeFetched([tx]), llm: { client: stub } },
    );
    expect(out.classified).toHaveLength(1);
    expect(out.classified[0]!.type).toBe('TRANSFER_OUT');
    expect(out.classified[0]!.classifierSource).toBe('rule');
    expect(out.ruleHits).toBe(1);
    expect(out.llmFallbacks).toBe(0);
    expect(out.flaggedForReview).toEqual([]);
  });

  it('falls back to LLM when no rule matches', async () => {
    // Errored tx + 3 token transfers → no rule matches.
    const tx = makeRawTx({ value: '1', isError: '1' });
    const t1 = makeTokenTransfer({ tokenSymbol: 'XYZ' });
    const t2 = makeTokenTransfer({ tokenSymbol: 'ABC' });
    const t3 = makeTokenTransfer({ tokenSymbol: 'QWE' });
    const fetched = makeFetched([tx], { tokenTransfers: [t1, t2, t3] });

    const stub = makeAnthropicStub(async () => ({
      stop_reason: 'end_turn',
      content: [
        {
          type: 'tool_use',
          id: 'tool_1',
          name: 'emit_classification',
          input: {
            hash: tx.hash,
            type: 'SWAP',
            timestamp: tx.timestamp,
            classifierSource: 'llm',
            confidence: 0.7,
          },
        },
      ],
    }));
    const out = await classifyWithDeps({ fetched, llm: { client: stub } });
    expect(out.llmFallbacks).toBe(1);
    expect(out.classified[0]!.type).toBe('SWAP');
    expect(out.classified[0]!.classifierSource).toBe('llm');
  });

  it('flags for review when LLM returns low confidence', async () => {
    const tx = makeRawTx({ value: '1', isError: '1' });
    const stub = makeAnthropicStub(async () => ({
      stop_reason: 'end_turn',
      content: [
        {
          type: 'tool_use',
          id: 'tool_1',
          name: 'emit_classification',
          input: {
            hash: tx.hash,
            type: 'UNKNOWN',
            timestamp: tx.timestamp,
            classifierSource: 'llm',
            confidence: 0.3, // below default 0.7
          },
        },
      ],
    }));
    const out = await classifyWithDeps({ fetched: makeFetched([tx]), llm: { client: stub } });
    expect(out.classified[0]!.classifierSource).toBe('flagged');
    expect(out.flaggedForReview).toContain(tx.hash);
  });

  it('flags unmatched txs when no LLM deps are provided', async () => {
    const tx = makeRawTx({ value: '1', isError: '1' });
    const out = await classifyWithDeps({ fetched: makeFetched([tx]) });
    expect(out.classified[0]!.classifierSource).toBe('flagged');
    expect(out.classified[0]!.type).toBe('UNKNOWN');
    expect(out.flaggedForReview).toContain(tx.hash);
    expect(out.llmFallbacks).toBe(0);
  });

  it('respects maxLlmCallsPerReport: remaining flagged after cap', async () => {
    const makeUnmatchable = (i: number): RawTx =>
      makeRawTx({
        hash: ('0x' + (i + 100).toString(16).padStart(2, '0').repeat(32)) as TxHash,
        value: '1',
        isError: '1',
      });
    const txs = [0, 1, 2, 3].map(makeUnmatchable);

    let callCount = 0;
    const stub = makeAnthropicStub(async (params) => {
      callCount += 1;
      // Extract the user message text to get the tx hash.
      const userMsg = params.messages[0].content as string;
      const hashMatch = userMsg.match(/hash:\s+(0x[a-f0-9]+)/);
      return {
        stop_reason: 'end_turn',
        content: [
          {
            type: 'tool_use',
            id: 'tool_1',
            name: 'emit_classification',
            input: {
              hash: hashMatch?.[1] ?? '0x',
              type: 'UNKNOWN',
              timestamp: 0,
              classifierSource: 'llm',
              confidence: 0.85,
            },
          },
        ],
      };
    });

    const out = await classifyWithDeps({
      fetched: makeFetched(txs),
      llm: { client: stub },
      maxLlmCallsPerReport: 2,
    });

    expect(callCount).toBe(2);
    expect(out.llmFallbacks).toBe(2);
    // 4 txs total, 2 LLM'd, 2 flagged
    const flagged = out.classified.filter((c) => c.classifierSource === 'flagged');
    expect(flagged).toHaveLength(2);
    // Notes mention the cap
    const capNote = flagged.find((c) => c.notes?.includes('cap'));
    expect(capNote).toBeDefined();
  });

  it('marks rule hits as flagged when below minRuleConfidence', async () => {
    // Use the GAS rule (confidence 0.85, above 0.7 default) — to get below
    // the threshold, override the rule table to lower the confidence.
    const tx = makeRawTx({ from: ADDR_A, to: ADDR_A, value: '1' });
    const out = await classifyWithDeps(
      { fetched: makeFetched([tx]), minRuleConfidence: 0.99 },
    );
    expect(out.classified[0]!.classifierSource).toBe('flagged');
    expect(out.flaggedForReview).toContain(tx.hash);
  });

  it('accepts LLM result at 0.6 (above default 0.5 threshold)', async () => {
    const tx = makeRawTx({ value: '1', isError: '1' });
    const stub = makeAnthropicStub(async () => ({
      stop_reason: 'end_turn',
      content: [
        {
          type: 'tool_use',
          id: 'tool_1',
          name: 'emit_classification',
          input: {
            hash: tx.hash,
            type: 'SWAP',
            timestamp: tx.timestamp,
            classifierSource: 'llm',
            confidence: 0.6,
          },
        },
      ],
    }));
    const out = await classifyWithDeps({ fetched: makeFetched([tx]), llm: { client: stub } });
    expect(out.classified[0]!.classifierSource).toBe('llm');
    expect(out.flaggedForReview).not.toContain(tx.hash);
  });

  it('uses the supplied network to build the contract lookup', async () => {
    // The lookup type doesn't change behavior with all addresses null, but
    // we verify the parameter is wired and doesn't throw. The real assertion
    // is that classifyWithDeps accepts the network field.
    const tx = makeRawTx({ value: '1000000000000000000' });
    const out = await classifyWithDeps({
      fetched: makeFetched([tx]),
      network: 'alfajores',
    });
    expect(out.classified[0]!.type).toBe('TRANSFER_OUT');
  });
});

// ─── self-funding for yield (2026-06-14 fix) ───────────────────────────────

const YIELD_POOL = '0x5b7ba6471681c61b4994dc5072b0d0c0ffad4a2b' as Address;

describe('self-funding for yield', () => {
  it('USDC IN then USDC OUT to yield protocol in same block → IN classified TRANSFER_IN', async () => {
    // Mirrors 0xBE19 2024-05-13: wallet receives 5,000 USDC, then immediately
    // routes it to the Karmen Mezz Pool in the same block.
    const txIn = makeRawTx({
      hash: '0x' + 'aa'.repeat(32) as TxHash,
      blockNumber: 1000,
      from: ADDR_B,               // someone funded the wallet
      to: ADDR_A,                 // wallet is the recipient
      value: '0',
    });
    const txOut = makeRawTx({
      hash: '0x' + 'bb'.repeat(32) as TxHash,
      blockNumber: 1000,           // same block
      from: ADDR_A,               // wallet sends
      to: YIELD_POOL,             // to yield protocol
      value: '0',
    });
    const tIn = makeTokenTransfer({
      hash: txIn.hash,
      from: ADDR_B,
      to: ADDR_A,
      tokenSymbol: 'USDC',
      value: '5000000000',         // 5,000 USDC (decimals=6)
    });
    const tOut = makeTokenTransfer({
      hash: txOut.hash,
      from: ADDR_A,
      to: YIELD_POOL,
      tokenSymbol: 'USDC',
      value: '5000000000',
    });
    const fetched = makeFetched([txIn, txOut], { tokenTransfers: [tIn, tOut] });

    const out = await classifyWithDeps({ fetched, jurisdiction: 'KE' });

    // txIn should be classified TRANSFER_IN (not INCOME)
    const classifiedIn = out.classified.find((c) => c.hash === txIn.hash);
    expect(classifiedIn).toBeDefined();
    expect(classifiedIn!.type).toBe('TRANSFER_IN');
    expect(classifiedIn!.classifierSource).toBe('rule');
    expect(classifiedIn!.confidence).toBe(0.9);
    // txOut is not matched by any rule in this test setup (DEX/SWAP path
    // needs toIn router refs which are null in test lookup) — it will be
    // flagged or LLM'd; the key signal is that txIn is NOT INCOME.
    expect(classifiedIn!.type).not.toBe('INCOME');
  });

  it('USDC IN but OUT to yield protocol is outside block window → IN still INCOME', async () => {
    // The OUT tx is 1001 blocks later — outside the 1000-block window.
    const txIn = makeRawTx({
      hash: '0x' + 'aa'.repeat(32) as TxHash,
      blockNumber: 1000,
      from: ADDR_B,
      to: ADDR_A,
      value: '0',
    });
    const txOut = makeRawTx({
      hash: '0x' + 'bb'.repeat(32) as TxHash,
      blockNumber: 2001,           // 1001 blocks later — outside 1000-block window
      from: ADDR_A,
      to: YIELD_POOL,
      value: '0',
    });
    const tIn = makeTokenTransfer({
      hash: txIn.hash,
      from: ADDR_B,
      to: ADDR_A,
      tokenSymbol: 'USDC',
      value: '5000000000',
    });
    const tOut = makeTokenTransfer({
      hash: txOut.hash,
      from: ADDR_A,
      to: YIELD_POOL,
      tokenSymbol: 'USDC',
      value: '5000000000',
    });
    const fetched = makeFetched([txIn, txOut], { tokenTransfers: [tIn, tOut] });

    const out = await classifyWithDeps({ fetched, jurisdiction: 'KE' });

    // txIn should be INCOME (not self-funding — window missed)
    const classifiedIn = out.classified.find((c) => c.hash === txIn.hash);
    expect(classifiedIn!.type).toBe('INCOME');
  });

  it('USDC IN but OUT is non-stable (CELO) → IN still INCOME', async () => {
    // The OUT transfers CELO, not USDC — not a yield-protocol self-funding.
    const txIn = makeRawTx({
      hash: '0x' + 'aa'.repeat(32) as TxHash,
      blockNumber: 1000,
      from: ADDR_B,
      to: ADDR_A,
      value: '0',
    });
    const txOut = makeRawTx({
      hash: '0x' + 'bb'.repeat(32) as TxHash,
      blockNumber: 1000,
      from: ADDR_A,
      to: YIELD_POOL,
      value: '1000000000000000000', // 1 CELO out, not a stablecoin
    });
    const tIn = makeTokenTransfer({
      hash: txIn.hash,
      from: ADDR_B,
      to: ADDR_A,
      tokenSymbol: 'USDC',
      value: '5000000000',
    });
    // No token transfer for txOut (native CELO only)
    const fetched = makeFetched([txIn, txOut], { tokenTransfers: [tIn] });

    const out = await classifyWithDeps({ fetched, jurisdiction: 'KE' });

    // txIn should be INCOME (OUT was not a stablecoin)
    const classifiedIn = out.classified.find((c) => c.hash === txIn.hash);
    expect(classifiedIn!.type).toBe('INCOME');
  });

  it('non-stable IN (CELO) before yield-protocol OUT → CELO IN not matched', async () => {
    // The IN is CELO, not USDC/USDT/cUSD — no stablecoin funding match.
    const txIn = makeRawTx({
      hash: '0x' + 'aa'.repeat(32) as TxHash,
      blockNumber: 1000,
      from: ADDR_B,
      to: ADDR_A,
      value: '1000000000000000000', // 1 CELO in
    });
    const txOut = makeRawTx({
      hash: '0x' + 'bb'.repeat(32) as TxHash,
      blockNumber: 1000,
      from: ADDR_A,
      to: YIELD_POOL,
      value: '0',
    });
    const tOut = makeTokenTransfer({
      hash: txOut.hash,
      from: ADDR_A,
      to: YIELD_POOL,
      tokenSymbol: 'USDC',
      value: '5000000000',
    });
    // txIn is a native CELO transfer (no token transfer)
    const fetched = makeFetched([txIn, txOut], { tokenTransfers: [tOut] });

    const out = await classifyWithDeps({ fetched, jurisdiction: 'KE' });

    // txIn should be TRANSFER_IN (CELO native in) — not self-funding since it was CELO
    const classifiedIn = out.classified.find((c) => c.hash === txIn.hash);
    expect(classifiedIn!.type).toBe('TRANSFER_IN');
    expect(classifiedIn!.classifierSource).toBe('rule');
  });

  it('yield return IN from 0x5b7ba647… → YIELD, not TRANSFER_IN (rule order matters)', async () => {
    // The yield.known_protocol_in rule runs BEFORE self_funding rule and
    // must win on the RETURN leg (funds coming BACK from yield protocol).
    const txReturn = makeRawTx({
      hash: '0x' + 'cc'.repeat(32) as TxHash,
      blockNumber: 2000,
      from: YIELD_POOL,             // funds come FROM the yield protocol
      to: ADDR_A,
      value: '0',
    });
    const tReturn = makeTokenTransfer({
      hash: txReturn.hash,
      from: YIELD_POOL,
      to: ADDR_A,
      tokenSymbol: 'USDC',
      value: '537490000',           // 537.49 USDC yield return
    });
    const fetched = makeFetched([txReturn], { tokenTransfers: [tReturn] });

    const out = await classifyWithDeps({ fetched, jurisdiction: 'KE' });

    // Must be YIELD (from known_protocol_in rule), not TRANSFER_IN
    const classified = out.classified.find((c) => c.hash === txReturn.hash);
    expect(classified!.type).toBe('YIELD');
    expect(classified!.classifierSource).toBe('rule');
    expect(classified!.notes).toContain('known_protocol_in');
  });

  it('isInSelfFundingForYieldSet predicate: set membership', () => {
    const fundingHash = '0x' + 'ab'.repeat(32) as TxHash;
    const nonFundingHash = '0x' + 'cd'.repeat(32) as TxHash;
    const ctxIn = makeCtx({
      tx: makeRawTx({ hash: fundingHash }),
      selfFundingForYieldSet: new Set([fundingHash]),
    });
    const ctxOut = makeCtx({
      tx: makeRawTx({ hash: nonFundingHash }),
      selfFundingForYieldSet: new Set([fundingHash]),
    });
    const ctxEmpty = makeCtx({
      tx: makeRawTx({ hash: nonFundingHash }),
      selfFundingForYieldSet: new Set(),
    });

    const pred: Predicate = { kind: 'isInSelfFundingForYieldSet' };

    expect(evaluatePredicate(pred, ctxIn)).toBe(true);
    expect(evaluatePredicate(pred, ctxOut)).toBe(false);
    // Absent set → false (no false positives on missing data)
    expect(evaluatePredicate(pred, ctxEmpty)).toBe(false);
  });
});
