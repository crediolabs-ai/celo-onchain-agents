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

  // Run the three endpoint paginations sequentially to avoid hitting Celoscan's
  // 3-calls/sec rate-limit burst. When all three endpoints were fired in
  // parallel via Promise.allSettled, page 1 of all three + page 2 of all three
  // = 6 calls in <2s, which exceeded the rate limit and triggered retry
  // backoff (1.2s/retry × up to 3 retries = 3.6s wasted per page).
  // Sequential execution costs more wall-clock time but eliminates rate-limit
  // hits entirely. Fix #8 (2026-06-13).
  //
  // Each paginateX call now returns a `PaginateResult<T>` with a
  // `paginationComplete` flag. We aggregate these into a single
  // paginationComplete for the FetchedTxData — false if ANY endpoint
  // hit the cap. Fix 2026-06-14 (Quan feedback: silent data loss was
  // masking the 10k-tx cap for heavy wallets).
  let normalResult: Awaited<ReturnType<typeof paginateNormalTxs>> = { rows: [], paginationComplete: true, pagesFetched: 0 };
  let tokenResult: Awaited<ReturnType<typeof paginateTokenTxs>> = { rows: [], paginationComplete: true, pagesFetched: 0 };
  let internalResult: Awaited<ReturnType<typeof paginateInternalTxs>> = { rows: [], paginationComplete: true, pagesFetched: 0 };

  try {
    normalResult = await paginateNormalTxs({ client, endpoint: 'txlist', address: request.address, startblock, endblock, sort: 'asc' });
  } catch (err) {
    collectErr(fetchErrors, 'normal', err);
  }

  try {
    tokenResult = await paginateTokenTxs({ client, endpoint: 'tokentx', address: request.address, startblock, endblock, sort: 'asc' });
  } catch (err) {
    collectErr(fetchErrors, 'token', err);
  }

  try {
    internalResult = await paginateInternalTxs({ client, endpoint: 'txlistinternal', address: request.address, startblock, endblock, sort: 'asc' });
  } catch (err) {
    collectErr(fetchErrors, 'internal', err);
  }

  const normalRows = normalResult.rows;
  const tokenRows = tokenResult.rows;
  const internalRows = internalResult.rows;

  const rawTxns = normalRows.map(toRawTx);
  const tokenTransfers = tokenRows.map(toTokenTransfer);
  const internalTxns = internalRows.map(toInternalTx);

  // ─── Etherscan V2 quirk: orphan token transfers ─────────────────────
  // Etherscan V2's `txlist` and `txlistinternal` endpoints sometimes omit
  // txs that the `tokentx` endpoint returns — typically zero-native-value
  // ERC-20 transfers where the V2 backend has indexed only the token
  // movement. Example (Quan 2026-06-14): wallet 0xBE19 had a 5,374.90 USDC
  // IN on 2024-12-14 (hash 0x9aa27723…) returned by `tokentx` but absent
  // from `txlist`/`txlistinternal`. Without this fallback, the token
  // transfer would never reach the classifier and the realized 374.90 USDC
  // yield was invisible to the tax report.
  //
  // For each token transfer whose hash isn't in rawTxns or internalTxns,
  // synthesize a RawTx stub so the existing rule-based classifier picks
  // it up via the tx-hash → token-transfer join (the rule engine sees
  // the synthetic raw tx + the associated transfer and emits a
  // TRANSFER_IN/TRANSFER_OUT classified event).
  const rawHashes = new Set<string>([...rawTxns.map((t) => t.hash.toLowerCase()), ...internalTxns.map((t) => t.hash.toLowerCase())]);
  const orphanTokenTransfers = tokenTransfers.filter(
    (t) => !rawHashes.has(t.hash.toLowerCase()),
  );
  for (const t of orphanTokenTransfers) {
    rawTxns.push({
      hash: t.hash,
      blockNumber: t.blockNumber,
      timestamp: t.timestamp,
      from: t.from,
      // The "to" of the synthesized raw tx is the contract being interacted
      // with (the ERC-20 token). The rule engine joins this hash back to
      // the token transfer to populate assetIn/assetOut.
      to: t.contractAddress,
      value: '0',
      gasUsed: '0',
      gasPrice: '0',
      input: '0x',
      // Sentinel — lets the audit trail show "this came from a token-
      // transfer-only fix-up, not a normal txlist result" without
      // confusing the rule path (which doesn't read methodName).
      methodName: '(synthesized from token transfer)',
      isError: '0',
    });
  }
  if (orphanTokenTransfers.length > 0) {
    // Surface for the agent's diagnostic summary — silent otherwise.
    console.warn(
      `[tx-fetcher] synthesized ${orphanTokenTransfers.length} raw-tx stub(s) for orphan token transfer(s); ` +
        `this is an Etherscan V2 quirk, not a fetcher bug.`,
    );
  }

  const paginationComplete =
    fetchErrors.length === 0 &&
    normalResult.paginationComplete &&
    tokenResult.paginationComplete &&
    internalResult.paginationComplete;

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
