/**
 * Unit tests for the pagination loop (`src/sub-agents/tx-fetcher/pagination.ts`).
 *
 * Owner: Credio (tx-fetcher sub-agent).
 */

import { describe, it, expect } from 'vitest';
import { createCeloscanClient, type CeloscanFetcher } from '../../src/sub-agents/tx-fetcher/celoscan.js';
import {
  paginateNormalTxs,
  paginateTokenTxs,
  paginateInternalTxs,
} from '../../src/sub-agents/tx-fetcher/pagination.js';
import type { HttpResponse } from '../../src/shared/http.js';

const ADDR = '0x0000000000000000000000000000000000000abc' as `0x${string}`;

function mkRow(seed: number, endpoint: string): unknown {
  const base = { hash: ('0x' + seed.toString(16).padStart(64, '0')) as `0x${string}`,
    blockNumber: String(1000 + seed), timeStamp: String(1700000000 + seed) };
  if (endpoint === 'txlist') {
    return { ...base, from: ADDR, to: '0x' + '1'.repeat(40), value: '0',
      gasUsed: '21000', gasPrice: '5000000000', input: '0x', isError: '0' };
  }
  if (endpoint === 'tokentx') {
    return { ...base, from: ADDR, to: ADDR, contractAddress: ADDR,
      tokenSymbol: 'cUSD', tokenDecimal: '18', value: '1000' };
  }
  return { ...base, from: ADDR, to: ADDR, value: '0', callType: 'call' as const };
}

function paginatingFetcher(endpoint: string, pageSizes: number[]): CeloscanFetcher {
  let call = 0;
  return async <T>(_url: string): Promise<HttpResponse<T>> => {
    const size = pageSizes[call] ?? 0;
    call += 1;
    const rows = Array.from({ length: size }, (_, i) => mkRow(call * 100 + i, endpoint));
    return {
      status: 200,
      headers: new Headers(),
      data: { status: '1', message: 'OK', result: rows } as unknown as T,
    };
  };
}

describe('paginateNormalTxs', () => {
  it('stops after a single short page (< maxPageSize) and reports paginationComplete=true', async () => {
    // The paginator treats a page shorter than the configured maxPageSize
    // as "last page" and breaks. A 50-row response with maxPageSize=100
    // triggers exactly one fetch.
    let calls = 0;
    const fetcher: CeloscanFetcher = async <T>(_url: string) => {
      calls += 1;
      const rows = Array.from({ length: 50 }, (_, i) => mkRow(i, 'txlist'));
      return { status: 200, headers: new Headers(),
        data: { status: '1', message: 'OK', result: rows } as unknown as T };
    };
    const client = createCeloscanClient({
      apiUrl: 'https://api-alfajores.celoscan.io/api', fetcher, maxPageSize: 100,
    });
    const r = await paginateNormalTxs({ client, endpoint: 'txlist', address: ADDR });
    expect(r.rows).toHaveLength(50);
    expect(r.paginationComplete).toBe(true);
    expect(r.pagesFetched).toBe(1);
    expect(calls).toBe(1);
  });

  it('follows 3 pages then stops on a short final page', async () => {
    const fetcher = paginatingFetcher('txlist', [100, 100, 47]);
    const client = createCeloscanClient({
      apiUrl: 'https://api-alfajores.celoscan.io/api', fetcher, maxPageSize: 100,
    });
    const r = await paginateNormalTxs({ client, endpoint: 'txlist', address: ADDR });
    expect(r.rows).toHaveLength(247);
    expect(r.paginationComplete).toBe(true);
    expect(r.pagesFetched).toBe(3);
  });

  it('stops immediately on an empty first page', async () => {
    const fetcher = paginatingFetcher('txlist', [0]);
    const client = createCeloscanClient({
      apiUrl: 'https://api-alfajores.celoscan.io/api', fetcher, maxPageSize: 100,
    });
    const r = await paginateNormalTxs({ client, endpoint: 'txlist', address: ADDR });
    expect(r.rows).toHaveLength(0);
    expect(r.paginationComplete).toBe(true);
  });

  it('respects the maxPages hard cap and reports paginationComplete=false (Quan fix 2026-06-14)', async () => {
    // maxPageSize=100 matches the per-call response size, so the loop never
    // thinks a page is "short" — only maxPages stops it. With maxPages=3
    // and 11 pages of data available, the loop must stop at page 3 and
    // surface paginationComplete=false so the caller knows data is missing.
    const fetcher = paginatingFetcher('txlist', [100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100]);
    const client = createCeloscanClient({
      apiUrl: 'https://api-alfajores.celoscan.io/api', fetcher, maxPageSize: 100,
    });
    const r = await paginateNormalTxs({ client, endpoint: 'txlist', address: ADDR, maxPages: 3 });
    expect(r.rows).toHaveLength(300); // 3 full pages
    expect(r.paginationComplete).toBe(false);
    expect(r.pagesFetched).toBe(3);
  });
});

describe('paginateTokenTxs / paginateInternalTxs', () => {
  it('paginateTokenTxs follows multiple pages', async () => {
    const fetcher = paginatingFetcher('tokentx', [100, 12]);
    const client = createCeloscanClient({
      apiUrl: 'https://api-alfajores.celoscan.io/api', fetcher, maxPageSize: 100,
    });
    const r = await paginateTokenTxs({ client, endpoint: 'tokentx', address: ADDR });
    expect(r.rows).toHaveLength(112);
    expect(r.paginationComplete).toBe(true);
  });

  it('paginateInternalTxs follows multiple pages', async () => {
    const fetcher = paginatingFetcher('txlistinternal', [100, 100, 5]);
    const client = createCeloscanClient({
      apiUrl: 'https://api-alfajores.celoscan.io/api', fetcher, maxPageSize: 100,
    });
    const r = await paginateInternalTxs({ client, endpoint: 'txlistinternal', address: ADDR });
    expect(r.rows).toHaveLength(205);
    expect(r.paginationComplete).toBe(true);
  });
});
