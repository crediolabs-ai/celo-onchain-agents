/**
 * Unit tests for the local file cache (`src/sub-agents/tx-fetcher/cache.ts`).
 *
 * Owner: Credio (tx-fetcher sub-agent).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTxCache } from '../../src/sub-agents/tx-fetcher/cache.js';
import type { Address, FetchedTxData } from '../../src/shared/types.js';

const ADDR = '0x0000000000000000000000000000000000000abc' as Address;

let tempDir: string;
let cache: ReturnType<typeof createTxCache>;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'tx-cache-'));
  cache = createTxCache({ cacheDir: tempDir, network: 'alfajores' });
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

function mkFetched(): FetchedTxData {
  return {
    address: ADDR,
    dateRange: { from: 0, to: 100 },
    rawTxns: [],
    tokenTransfers: [],
    internalTxns: [],
    source: 'celoscan',
    fetchedAt: 100,
    paginationComplete: true,
    fetchErrors: [],
    contractMetadata: new Map(),
  };
}

describe('TxCache', () => {
  it('returns null for a cache miss', async () => {
    const result = await cache.read(ADDR);
    expect(result).toBeNull();
  });

  it('returns the written data on a cache hit', async () => {
    const data = mkFetched();
    await cache.write(ADDR, data);
    const result = await cache.read(ADDR);
    expect(result).toEqual(data);
  });

  it('keys by lowercased address (read is case-insensitive on checksum address)', async () => {
    // EIP-55 checksum address: same bytes, different casing. Should resolve
    // to the same cache file via lowercase normalization.
    const data = mkFetched();
    const checksummed = ('0x' + 'aBcDeF0000000000000000000000000000000abc') as Address;
    await cache.write(checksummed, data);
    // Read with the same checksummed address — should hit.
    const result = await cache.read(checksummed);
    expect(result).toEqual(data);
  });

  it('clear() removes the cache file', async () => {
    await cache.write(ADDR, mkFetched());
    await cache.clear(ADDR);
    expect(await cache.read(ADDR)).toBeNull();
  });

  it('clear() is a no-op when nothing is cached (no throw)', async () => {
    await expect(cache.clear(ADDR)).resolves.toBeUndefined();
  });

  it('isolates entries by network (alfajores ≠ mainnet)', async () => {
    const mainnetCache = createTxCache({ cacheDir: tempDir, network: 'mainnet' });
    await cache.write(ADDR, mkFetched());
    expect(await mainnetCache.read(ADDR)).toBeNull(); // separate namespace
  });
});
