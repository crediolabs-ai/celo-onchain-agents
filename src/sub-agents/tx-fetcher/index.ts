/**
 * Tx History Fetcher — Stage 1 of the Agent 06 pipeline.
 *
 * Owner: Credio (tx-fetcher sub-agent).
 *
 * Public surface: `fetchTxs(request, deps): Promise<FetchedTxData>`.
 *
 * Pulls a wallet's full transaction history from Celoscan, normalized into
 * the interface contract's shape. Caches per-address so re-running the
 * agent against the same wallet doesn't re-hit the API.
 *
 * Failure mode: per-endpoint errors (e.g. Celoscan rate-limited) are
 * surfaced via `FetchedTxData.fetchErrors` rather than thrown. The pipeline
 * keeps going with whatever endpoints succeeded.
 *
 * The fetcher + cache are injected via `deps` so tests can stub the network
 * and use a temp dir for cache.
 */

import type {
  Address,
  ContractMetadata,
  FetchedTxData,
  PipelineRequest,
  Timestamp,
  TxHash,
} from '../../shared/types.js';
import { createCeloscanClient, type CeloscanClientOptions, type CeloscanFetcher } from './celoscan.js';
import {
  paginateInternalTxs,
  paginateNormalTxs,
  paginateTokenTxs,
} from './pagination.js';
import { createContractCache, createTxCache, type ContractCache, type TxCache } from './cache.js';
import {
  toInternalTx,
  toRawTx,
  toTokenTransfer,
} from './types.js';
import { CeloscanError } from '../../shared/errors.js';

export interface FetchTxsDeps {
  /** Etherscan V2 API base URL (e.g. `https://api.etherscan.io/v2/api`). */
  apiUrl: string;
  /** Optional API key — boosts rate limit from 5/sec to ~100k/day. */
  apiKey?: string;
  /** Network (mainnet / alfajores) for cache key + default chain. */
  network: 'alfajores' | 'mainnet';
  /**
   * Etherscan V2 chain id (Celo mainnet 42220, Celo Alfajores 44787). Forwarded
   * to the client as the `chainid` query param. Required for V2.
   */
  chainId?: number;
  /** Local cache directory. Pass an empty string to disable. */
  cacheDir: string;
  /** Optional fetcher injection for tests. Defaults to `httpFetch`. */
  fetcher?: CeloscanFetcher;
  /** Optional cache injection for tests. */
  cache?: TxCache;
  /** Optional contract-metadata cache injection for tests. */
  contractCache?: ContractCache;
  /** Fetched-at timestamp. Injected for test determinism. */
  now?: () => number;
  /**
   * When true, skip the cache read on entry. The fresh fetch still writes
   * through to the cache. Used by `pnpm dev --refresh`.
   */
  refresh?: boolean;
  /**
   * When false, skip the Celoscan `getsourcecode` lookup that powers the
   * protocol-aware classifier. Default: true. Useful for tests that don't
   * stub a contract endpoint.
   */
  fetchContractMetadata?: boolean;
}

/**
 * Fetch the full tx history for `request.address` from Celoscan.
 * Returns the normalized `FetchedTxData` shape consumed by the classifier.
 */
export async function fetchTxs(
  request: PipelineRequest,
  deps: FetchTxsDeps,
): Promise<FetchedTxData> {
  const cache = deps.cache ?? createTxCache({ cacheDir: deps.cacheDir, network: deps.network });

  // Cache hit → return immediately (unless --refresh bypasses).
  if (deps.refresh !== true) {
    const cached = await cache.read(request.address);
    if (cached !== null) return cached;
  }

  const clientOptions: CeloscanClientOptions = {
    apiUrl: deps.apiUrl,
    ...(deps.apiKey !== undefined && deps.apiKey !== '' && { apiKey: deps.apiKey }),
    ...(deps.chainId !== undefined && { chainId: deps.chainId }),
    ...(deps.fetcher !== undefined && { fetcher: deps.fetcher }),
  };
  const client = createCeloscanClient(clientOptions);

  const fetchErrors: { hash: TxHash; reason: string }[] = [];
  // Capture `now` once so `dateRange.to` and `fetchedAt` are always equal.
  // Calling it twice could let the second call observe a different wall
  // second (e.g. across a clock-tick boundary).
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  const fetchedAt = now();
  // Celoscan indexes from block 0; date-range filter is applied downstream
  // by the classifier (dateRange.to on each tx's `timestamp`).
  const startblock = 0;
  const endblock = 99_999_999;

  // Run the three endpoint paginations. Errors are collected, not thrown.
  const [normalResult, tokenResult, internalResult] = await Promise.allSettled([
    paginateNormalTxs({ client, endpoint: 'txlist', address: request.address, startblock, endblock, sort: 'asc' }),
    paginateTokenTxs({ client, endpoint: 'tokentx', address: request.address, startblock, endblock, sort: 'asc' }),
    paginateInternalTxs({ client, endpoint: 'txlistinternal', address: request.address, startblock, endblock, sort: 'asc' }),
  ]);

  const rawTxns =
    normalResult.status === 'fulfilled'
      ? normalResult.value.map(toRawTx)
      : (collectErr(fetchErrors, 'normal', normalResult.reason), []);
  const tokenTransfers =
    tokenResult.status === 'fulfilled'
      ? tokenResult.value.map(toTokenTransfer)
      : (collectErr(fetchErrors, 'token', tokenResult.reason), []);
  const internalTxns =
    internalResult.status === 'fulfilled'
      ? internalResult.value.map(toInternalTx)
      : (collectErr(fetchErrors, 'internal', internalResult.reason), []);

  const paginationComplete = fetchErrors.length === 0;

  // Gather unique non-null `to` addresses from the raw tx list + the contract
  // addresses from token transfers. These are the addresses the classifier's
  // protocol-aware path will need to recognize.
  const candidateAddresses = new Set<string>();
  for (const tx of rawTxns) {
    if (tx.to) candidateAddresses.add(tx.to.toLowerCase());
  }
  for (const t of tokenTransfers) {
    if (t.contractAddress) candidateAddresses.add(t.contractAddress.toLowerCase());
  }
  const uniqueAddrs = Array.from(candidateAddresses) as Address[];

  // Contract metadata is best-effort: never throw, never block the report.
  const contractMetadata = await loadContractMetadata(
    uniqueAddrs,
    deps,
    client,
  );

  const fetched: FetchedTxData = {
    address: request.address,
    dateRange: {
      from: (request.dateRange?.from ?? 0) as Timestamp,
      to: (request.dateRange?.to ?? fetchedAt) as Timestamp,
    },
    rawTxns,
    tokenTransfers,
    internalTxns,
    source: 'celoscan',
    fetchedAt: fetchedAt as Timestamp,
    paginationComplete,
    fetchErrors,
    contractMetadata,
  };

  // Write-through cache. Best-effort — don't void the report on cache failure.
  try {
    await cache.write(request.address, fetched);
  } catch {
    // ignored — caching is an optimization, not a correctness gate
  }

  return fetched;
}

/**
 * Load contract metadata for a list of addresses, with a per-(address, network)
 * on-disk cache. Reads are parallel; writes for fresh fetches are best-effort.
 * Returns a Map keyed by lowercased address.
 */
async function loadContractMetadata(
  addresses: readonly Address[],
  deps: FetchTxsDeps,
  client: ReturnType<typeof createCeloscanClient>,
): Promise<Map<Address, ContractMetadata>> {
  if (deps.fetchContractMetadata === false || addresses.length === 0) {
    return new Map<Address, ContractMetadata>();
  }
  const cache = deps.contractCache ?? createContractCache({ cacheDir: deps.cacheDir, network: deps.network });

  // Seed from disk cache.
  const out = await cache.readMany(addresses);

  // Fan out for the misses.
  const misses = addresses.filter((a) => !out.has(a.toLowerCase() as Address));
  if (misses.length > 0) {
    try {
      const fresh = await client.fetchContractMetadataBatch(misses);
      for (const [addr, meta] of fresh) {
        out.set(addr, meta);
        // Best-effort write — never block on cache I/O failures.
        try {
          await cache.write(addr, meta);
        } catch {
          // ignored
        }
      }
    } catch (err) {
      // One bad address shouldn't void the whole metadata map. Log only.
      console.warn('[tx-fetcher] contract-metadata batch failed', err);
    }
  }

  return out;
}

function collectErr(
  out: { hash: TxHash; reason: string }[],
  label: string,
  reason: unknown,
): void {
  const msg = reason instanceof CeloscanError ? reason.message : reason instanceof Error ? reason.message : String(reason);
  out.push({
    hash: ('0x' + '0'.repeat(64)) as TxHash, // placeholder; one bucket per failed endpoint
    reason: `[${label}] ${msg}`,
  });
}
