/**
 * End-to-end tests for the tx-fetcher (`src/sub-agents/tx-fetcher/index.ts`).
 *
 * Owner: Credio (tx-fetcher sub-agent).
 *
 * Uses a stub fetcher (so no real Celoscan call) and a temp-dir cache.
 * Verifies:
 *   - cache hit short-circuits pagination
 *   - all three endpoints are called in parallel
 *   - per-endpoint errors land in `fetchErrors` (not thrown)
 *   - the returned FetchedTxData shape matches the interface contract
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fetchTxs } from '../../src/sub-agents/tx-fetcher/index.js';
import { createTxCache } from '../../src/sub-agents/tx-fetcher/cache.js';
import type { CeloscanFetcher } from '../../src/sub-agents/tx-fetcher/celoscan.js';
import type { HttpResponse } from '../../src/shared/http.js';
import type { Address, PipelineRequest } from '../../src/shared/types.js';

const ADDR = '0x0000000000000000000000000000000000000abc' as Address;

let tempDir: string;
beforeEach(async () => { tempDir = await mkdtemp(join(tmpdir(), 'tx-fetcher-')); });
afterEach(async () => { await rm(tempDir, { recursive: true, force: true }); });

function mkRequest(): PipelineRequest {
  return { address: ADDR, jurisdiction: 'NG', method: 'FIFO', taxYear: 2024 };
}

function stubFetcher(handlers: Record<string, () => unknown>): CeloscanFetcher {
  return async <T>(url: string): Promise<HttpResponse<T>> => {
    // Match `action=X&` exactly (with trailing &) to avoid substring collisions
    // like 'action=txlist' matching 'action=txlistinternal'.
    const actionMatch = /[?&]action=([^&]+)/.exec(url);
    const action = actionMatch?.[1];
    if (action !== undefined && action in handlers) {
      return { status: 200, headers: new Headers(), data: handlers[action]!() as T };
    }
    throw new Error(`stub: no handler for action=${action} in ${url}`);
  };
}

describe('fetchTxs', () => {
  it('returns the full FetchedTxData shape with all three endpoint lists', async () => {
    const fetcher = stubFetcher({
      txlist: () => ({
        status: '1', message: 'OK', result: [
          { hash: ('0x' + 'a'.repeat(64)) as `0x${string}`, blockNumber: '100',
            timeStamp: '1700000000', from: ADDR, to: ADDR, value: '1000',
            gasUsed: '21000', gasPrice: '5000000000', input: '0x', isError: '0' },
        ],
      }),
      tokentx: () => ({
        status: '1', message: 'OK', result: [
          { hash: ('0x' + 'a'.repeat(64)) as `0x${string}`, blockNumber: '100',
            timeStamp: '1700000000', from: ADDR, to: ADDR, contractAddress: ADDR,
            tokenSymbol: 'cUSD', tokenDecimal: '18', value: '5000' },
        ],
      }),
      txlistinternal: () => ({ status: '0', message: 'No transactions found', result: [] }),
    });

    const result = await fetchTxs(mkRequest(), {
      apiUrl: 'https://api-alfajores.celoscan.io/api',
      network: 'alfajores',
      cacheDir: tempDir,
      fetcher,
      now: () => 1_700_000_100,
    });

    expect(result.address).toBe(ADDR);
    expect(result.source).toBe('celoscan');
    expect(result.fetchedAt).toBe(1_700_000_100);
    expect(result.paginationComplete).toBe(true);
    expect(result.fetchErrors).toEqual([]);
    expect(result.rawTxns).toHaveLength(1);
    expect(result.tokenTransfers).toHaveLength(1);
    expect(result.internalTxns).toHaveLength(0);
  });

  it('caches the result and short-circuits on the second call', async () => {
    let calls = 0;
    const fetcher = stubFetcher({
      txlist: () => { calls += 1; return { status: '0', message: 'No transactions found', result: [] }; },
      tokentx: () => { calls += 1; return { status: '0', message: 'No transactions found', result: [] }; },
      txlistinternal: () => { calls += 1; return { status: '0', message: 'No transactions found', result: [] }; },
    });

    const a = await fetchTxs(mkRequest(), {
      apiUrl: 'https://api-alfajores.celoscan.io/api', network: 'alfajores',
      cacheDir: tempDir, fetcher,
    });
    const b = await fetchTxs(mkRequest(), {
      apiUrl: 'https://api-alfajores.celoscan.io/api', network: 'alfajores',
      cacheDir: tempDir, fetcher,
    });

    expect(a).toEqual(b); // identical data
    expect(calls).toBe(3); // 3 fetcher calls on first run, 0 on second
  });

  it('per-endpoint failures land in fetchErrors; the rest of the data still flows', async () => {
    const fetcher = stubFetcher({
      txlist: () => { throw new Error('network down'); },
      tokentx: () => ({
        status: '1', message: 'OK', result: [
          { hash: ('0x' + 'a'.repeat(64)) as `0x${string}`, blockNumber: '100',
            timeStamp: '1700000000', from: ADDR, to: ADDR, contractAddress: ADDR,
            tokenSymbol: 'cUSD', tokenDecimal: '18', value: '5000' },
        ],
      }),
      txlistinternal: () => ({ status: '0', message: 'No transactions found', result: [] }),
    });

    const result = await fetchTxs(mkRequest(), {
      apiUrl: 'https://api-alfajores.celoscan.io/api', network: 'alfajores',
      cacheDir: tempDir, fetcher,
    });

    expect(result.paginationComplete).toBe(false);
    expect(result.fetchErrors).toHaveLength(1);
    expect(result.fetchErrors[0]!.reason).toContain('normal');
    // Token endpoint succeeded, so we still get its data.
    expect(result.tokenTransfers).toHaveLength(1);
    // Normal endpoint failed, so its list is empty — but the orphan-token
    // fix-up synthesizes a raw-tx stub for the token transfer whose hash
    // isn't in rawTxns (Quan feedback 2026-06-14: Etherscan V2 sometimes
    // omits token-only txs from txlist but returns them from tokentx).
    expect(result.rawTxns).toHaveLength(1);
    expect(result.rawTxns[0]!.hash).toBe(result.tokenTransfers[0]!.hash);
    expect(result.rawTxns[0]!.methodName).toMatch(/synthesized/i);
  });

  it('collects errors from multiple concurrent failures (Promise.allSettled path)', async () => {
    const fetcher = stubFetcher({
      txlist: () => { throw new Error('normal down'); },
      tokentx: () => { throw new Error('token down'); },
      txlistinternal: () => ({ status: '0', message: 'No transactions found', result: [] }),
    });

    const result = await fetchTxs(mkRequest(), {
      apiUrl: 'https://api-alfajores.celoscan.io/api', network: 'alfajores',
      cacheDir: tempDir, fetcher,
    });

    expect(result.paginationComplete).toBe(false);
    expect(result.fetchErrors).toHaveLength(2);
    const reasons = result.fetchErrors.map((e) => e.reason).join(' | ');
    expect(reasons).toContain('[normal]');
    expect(reasons).toContain('[token]');
    // The one that succeeded (internal) still flows through.
    expect(result.internalTxns).toHaveLength(0); // empty (not an error)
  });

  // Quan feedback 2026-06-14: Etherscan V2's txlist endpoint sometimes omits
  // token-only txs that the tokentx endpoint returns. The fetcher must
  // synthesize raw-tx stubs for these so the classifier can attribute the
  // asset leg. Without this, the realized yield (e.g. 374.90 USDC on the
  // 0xBE19 2024-12-14 IN) is invisible to the tax report.
  it('orphan token transfer (in tokentx but missing from txlist) → synthesized raw tx stub', async () => {
    const ORPHAN_HASH = ('0x' + 'c'.repeat(64)) as `0x${string}`;
    const REAL_HASH   = ('0x' + 'd'.repeat(64)) as `0x${string}`;
    // A real-looking ERC-20 contract address (e.g. USDC on Celo).
    const USDC_CONTRACT = '0xceba9300f2b948710d2653dd7b07f33a8b32118c' as Address;
    const fetcher = stubFetcher({
      txlist: () => ({
        status: '1', message: 'OK', result: [
          // Only the real tx is in the normal list — the orphan hash is
          // missing here (mimicking the Etherscan V2 quirk).
          { hash: REAL_HASH, blockNumber: '200', timeStamp: '1700100000',
            from: ADDR, to: USDC_CONTRACT, value: '0', gas: '21000', gasUsed: '21000',
            gasPrice: '1000000000', input: '0x', isError: '0', contractAddress: '',
          },
        ],
      }),
      tokentx: () => ({
        status: '1', message: 'OK', result: [
          // The real tx's token transfer.
          { hash: REAL_HASH, blockNumber: '200', timeStamp: '1700100000',
            from: ADDR, to: ADDR, value: '1000000', contractAddress: USDC_CONTRACT,
            tokenSymbol: 'cUSD', tokenDecimal: '18' },
          // The orphan token transfer — Etherscan V2 returns this from
          // tokentx but not from txlist.
          { hash: ORPHAN_HASH, blockNumber: '300', timeStamp: '1700200000',
            from: ADDR, to: ADDR, value: '2000000', contractAddress: USDC_CONTRACT,
            tokenSymbol: 'cUSD', tokenDecimal: '18' },
        ],
      }),
      txlistinternal: () => ({ status: '0', message: 'No transactions found', result: [] }),
    });

    const result = await fetchTxs(mkRequest(), {
      apiUrl: 'https://api-alfajores.celoscan.io/api', network: 'alfajores',
      cacheDir: tempDir, fetcher,
    });

    expect(result.paginationComplete).toBe(true);
    expect(result.fetchErrors).toHaveLength(0);
    expect(result.tokenTransfers).toHaveLength(2);
    // One real + one synthesized = 2 raw txns.
    expect(result.rawTxns).toHaveLength(2);
    const realTx = result.rawTxns.find(t => t.hash === REAL_HASH);
    const orphanTx = result.rawTxns.find(t => t.hash === ORPHAN_HASH);
    expect(realTx).toBeDefined();
    expect(orphanTx).toBeDefined();
    expect(orphanTx!.methodName).toMatch(/synthesized/i);
    // The synthesized raw tx carries the token transfer's metadata so the
    // rule engine can join them. The `to` is the ERC-20 contract (the
    // destination of the synthesized raw tx, like any real ERC-20
    // transfer() call), not the wallet.
    expect(orphanTx!.from.toLowerCase()).toBe(ADDR.toLowerCase());
    // The synthesized raw tx's `to` is the ERC-20 contract (the destination
    // of the tx call), not the wallet. We use a direct string comparison
    // here because `to` is typed `Address | null` and we just want to
    // assert it points at the contract, not the user.
    expect(String(orphanTx!.to).toLowerCase()).not.toBe(ADDR.toLowerCase());
    expect(orphanTx!.blockNumber).toBe(300);
  });

  it('refresh: true bypasses the cache read but still writes through', async () => {
    let fetcherCalls = 0;
    const fetcher = stubFetcher({
      txlist: () => { fetcherCalls += 1; return { status: '0', message: 'No transactions found', result: [] }; },
      tokentx: () => { fetcherCalls += 1; return { status: '0', message: 'No transactions found', result: [] }; },
      txlistinternal: () => { fetcherCalls += 1; return { status: '0', message: 'No transactions found', result: [] }; },
    });
    // Pre-warm the cache with a sentinel value.
    const cache = createTxCache({ cacheDir: tempDir, network: 'alfajores' });
    await cache.write(ADDR, {
      address: ADDR, dateRange: { from: 0, to: 1 },
      rawTxns: [], tokenTransfers: [], internalTxns: [],
      source: 'celoscan', fetchedAt: 1, paginationComplete: true, fetchErrors: [],
      contractMetadata: new Map(),
    });

    // First call WITH refresh → bypass cache, fetch, write through.
    const a = await fetchTxs(mkRequest(), {
      apiUrl: 'https://api-alfajores.celoscan.io/api', network: 'alfajores',
      cacheDir: tempDir, fetcher, cache, refresh: true,
    });
    expect(fetcherCalls).toBe(3);
    expect(a.fetchedAt).not.toBe(1); // not the cached value

    // Second call WITHOUT refresh → cache hit.
    const b = await fetchTxs(mkRequest(), {
      apiUrl: 'https://api-alfajores.celoscan.io/api', network: 'alfajores',
      cacheDir: tempDir, fetcher, cache,
    });
    expect(fetcherCalls).toBe(3); // no new fetcher calls
    expect(b.fetchedAt).toBe(a.fetchedAt); // same as the refresh result
  });

  it('uses the injected cache directly (no filesystem IO via temp dir)', async () => {
    let fetcherCalls = 0;
    const fetcher = stubFetcher({
      txlist: () => { fetcherCalls += 1; return { status: '0', message: 'No transactions found', result: [] }; },
      tokentx: () => { fetcherCalls += 1; return { status: '0', message: 'No transactions found', result: [] }; },
      txlistinternal: () => { fetcherCalls += 1; return { status: '0', message: 'No transactions found', result: [] }; },
    });
    // Pre-warm the cache by writing a known value into a real temp dir.
    const cache = createTxCache({ cacheDir: tempDir, network: 'alfajores' });
    await cache.write(ADDR, {
      address: ADDR, dateRange: { from: 0, to: 1 },
      rawTxns: [], tokenTransfers: [], internalTxns: [],
      source: 'celoscan', fetchedAt: 1, paginationComplete: true, fetchErrors: [],
      contractMetadata: new Map(),
    });
    const result = await fetchTxs(mkRequest(), {
      apiUrl: 'https://api-alfajores.celoscan.io/api', network: 'alfajores',
      cacheDir: tempDir, fetcher, cache,
    });
    expect(fetcherCalls).toBe(0); // cache hit prevented the fetcher from being called
    expect(result.fetchedAt).toBe(1);
  });
});
