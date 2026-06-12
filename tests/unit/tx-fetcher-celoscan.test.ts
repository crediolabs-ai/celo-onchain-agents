/**
 * Unit tests for the Celoscan client (`src/sub-agents/tx-fetcher/celoscan.ts`).
 *
 * Owner: Credio (tx-fetcher sub-agent).
 */

import { describe, it, expect } from 'vitest';
import { createCeloscanClient, type CeloscanFetcher } from '../../src/sub-agents/tx-fetcher/celoscan.js';
import { CeloscanError } from '../../src/shared/errors.js';
import type { HttpResponse } from '../../src/shared/http.js';

const ADDR = '0x0000000000000000000000000000000000000abc' as `0x${string}`;

function stubFetcher(responses: Record<string, unknown>): CeloscanFetcher {
  return async <T>(url: string): Promise<HttpResponse<T>> => {
    // Find the response keyed by endpoint name (encoded in the URL)
    for (const [key, value] of Object.entries(responses)) {
      if (url.includes(`action=${key}`)) {
        return { status: 200, headers: new Headers(), data: value as T };
      }
    }
    throw new Error(`Stub fetcher: no canned response for URL ${url}`);
  };
}

describe('CeloscanClient.buildUrl', () => {
  it('encodes all required query params', () => {
    const client = createCeloscanClient({ apiUrl: 'https://api-alfajores.celoscan.io/api' });
    const url = client.buildUrl({ address: ADDR, endpoint: 'txlist', page: 1 });
    const u = new URL(url);
    expect(u.searchParams.get('module')).toBe('account');
    expect(u.searchParams.get('action')).toBe('txlist');
    expect(u.searchParams.get('address')).toBe(ADDR);
    expect(u.searchParams.get('startblock')).toBe('0');
    expect(u.searchParams.get('endblock')).toBe('99999999');
    expect(u.searchParams.get('page')).toBe('1');
    expect(u.searchParams.get('offset')).toBe('10000');
    expect(u.searchParams.get('sort')).toBe('asc');
    expect(u.searchParams.get('apikey')).toBeNull();
  });

  it('appends apikey query param when configured', () => {
    const client = createCeloscanClient({
      apiUrl: 'https://api.celoscan.io/api',
      apiKey: 'TEST_KEY_42',
    });
    const url = client.buildUrl({ address: ADDR, endpoint: 'tokentx', page: 2 });
    expect(new URL(url).searchParams.get('apikey')).toBe('TEST_KEY_42');
  });

  it('appends chainid query param when configured (V2 multi-chain)', () => {
    const client = createCeloscanClient({
      apiUrl: 'https://api.etherscan.io/v2/api',
      chainId: 42220, // Celo mainnet
    });
    const url = client.buildUrl({ address: ADDR, endpoint: 'txlist', page: 1 });
    expect(new URL(url).searchParams.get('chainid')).toBe('42220');
  });

  it('omits chainid when not configured (V1 backward compat)', () => {
    const client = createCeloscanClient({
      apiUrl: 'https://api-alfajores.celoscan.io/api',
    });
    const url = client.buildUrl({ address: ADDR, endpoint: 'txlist', page: 1 });
    expect(new URL(url).searchParams.get('chainid')).toBeNull();
  });
});

describe('CeloscanClient.fetchPage', () => {
  it('parses a successful response into the result array', async () => {
    const client = createCeloscanClient({
      apiUrl: 'https://api-alfajores.celoscan.io/api',
      fetcher: stubFetcher({
        txlist: {
          status: '1',
          message: 'OK',
          result: [
            { hash: '0x' + 'a'.repeat(64), blockNumber: '100', timeStamp: '1700000000',
              from: ADDR, to: '0x' + 'b'.repeat(40), value: '0', gasUsed: '21000',
              gasPrice: '5000000000', input: '0x', isError: '0' },
          ],
        },
      }),
    });
    const rows = await client.fetchPage({ address: ADDR, endpoint: 'txlist', page: 1 });
    expect(rows).toHaveLength(1);
  });

  it('treats "No transactions found" as an empty result, not an error', async () => {
    const client = createCeloscanClient({
      apiUrl: 'https://api-alfajores.celoscan.io/api',
      fetcher: stubFetcher({
        txlist: { status: '0', message: 'No transactions found', result: [] },
      }),
    });
    const rows = await client.fetchPage({ address: ADDR, endpoint: 'txlist', page: 1 });
    expect(rows).toEqual([]);
  });

  it('throws CeloscanError on unexpected status=0', async () => {
    const client = createCeloscanClient({
      apiUrl: 'https://api-alfajores.celoscan.io/api',
      fetcher: stubFetcher({
        txlist: { status: '0', message: 'Invalid address format', result: [] },
      }),
    });
    await expect(client.fetchPage({ address: ADDR, endpoint: 'txlist', page: 1 }))
      .rejects.toBeInstanceOf(CeloscanError);
  });

  it('wraps network errors in CeloscanError', async () => {
    const client = createCeloscanClient({
      apiUrl: 'https://api-alfajores.celoscan.io/api',
      fetcher: (async () => { throw new Error('socket reset'); }) as CeloscanFetcher,
    });
    await expect(client.fetchPage({ address: ADDR, endpoint: 'txlist', page: 1 }))
      .rejects.toBeInstanceOf(CeloscanError);
  });
});
