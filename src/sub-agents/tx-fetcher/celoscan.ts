/**
 * Celoscan / Etherscan API client.
 *
 * Owner: Credio (tx-fetcher sub-agent).
 *
 * Thin Etherscan-compatible client. Each endpoint returns a single page; the
 * pagination loop lives in `pagination.ts`. The fetcher is injected so tests
 * can stub the network without spinning up a Celoscan fixture.
 *
 * Endpoints (V2 — `https://api.etherscan.io/v2/api?chainid={N}&...`):
 *   - txlist          → normal transactions (`module=account&action=txlist`)
 *   - tokentx         → ERC-20 token transfers (`module=account&action=tokentx`)
 *   - txlistinternal  → internal (contract-to-wallet) transactions
 *   - getsourcecode   → contract metadata (`module=contract&action=getsourcecode`)
 *
 * V1 (`https://api.celoscan.io/api`) was deprecated 2025; V2 requires a
 * `chainid` query param to disambiguate chains (Celo mainnet 42220,
 * Celo Alfajores 44787). See https://docs.etherscan.io/v2-migration.
 *
 * Free tier = 5 req/sec; `CELOSCAN_API_KEY` lifts this to 100k/day.
 */

import type { Address, ContractMetadata, Timestamp } from '../../shared/types.js';
import { httpFetch, type HttpResponse } from '../../shared/http.js';
import { CeloscanError } from '../../shared/errors.js';
import type {
  CeloscanEndpoint,
  CeloscanInternalTx,
  CeloscanNormalTx,
  CeloscanResponse,
  CeloscanTokenTx,
} from './types.js';
import pLimit from 'p-limit';

/** Function shape that matches `httpFetch` so tests can inject a stub. */
export type CeloscanFetcher = <T>(url: string) => Promise<HttpResponse<T>>;

export interface CeloscanClientOptions {
  apiUrl: string;
  apiKey?: string;
  fetcher?: CeloscanFetcher;
  /** Max page offset (default 10_000, per Celoscan hard limit). */
  maxPageSize?: number;
  /**
   * Etherscan V2 chain id (e.g. 42220 for Celo mainnet, 44787 for Alfajores).
   * Required when targeting the V2 endpoint; ignored by V1.
   */
  chainId?: number;
}

export interface FetchPageArgs {
  address: Address;
  endpoint: CeloscanEndpoint;
  page: number;
  startblock?: number;
  endblock?: number;
  sort?: 'asc' | 'desc';
}

const DEFAULT_MAX_PAGE = 10_000;

/** Default concurrency for contract-metadata fan-out. Celoscan free tier = 5/sec. */
const DEFAULT_RATE_LIMIT_CONCURRENCY = 5;

/** Raw row returned by `module=contract&action=getsourcecode`. Loose typing. */
interface CeloscanContractSource {
  ContractName?: string;
  Implementation?: string;
  Proxy?: '0' | '1' | string;
  // Other fields exist (SourceCode, ABI, etc.) but we don't need them.
  [k: string]: unknown;
}

/** Build a Celoscan client. Pure construction; no I/O happens here. */
export function createCeloscanClient(options: CeloscanClientOptions) {
  const {
    apiUrl,
    apiKey = '',
    fetcher = httpFetch as CeloscanFetcher,
    maxPageSize = DEFAULT_MAX_PAGE,
    chainId,
  } = options;

  /** Build the full URL with query params for one (endpoint, page) call. */
  function buildUrl(args: FetchPageArgs): string {
    const u = new URL(apiUrl);
    u.searchParams.set('module', 'account');
    u.searchParams.set('action', args.endpoint);
    u.searchParams.set('address', args.address);
    u.searchParams.set('startblock', String(args.startblock ?? 0));
    u.searchParams.set('endblock', String(args.endblock ?? 99_999_999));
    u.searchParams.set('page', String(args.page));
    u.searchParams.set('offset', String(maxPageSize));
    u.searchParams.set('sort', args.sort ?? 'asc');
    if (chainId !== undefined) u.searchParams.set('chainid', String(chainId));
    if (apiKey) u.searchParams.set('apikey', apiKey);
    return u.toString();
  }

  /**
   * Fetch one page. Returns the parsed response. Throws `CeloscanError` on
   * non-OK status from Celoscan (status=0 with a non-"no transactions"
   * message). `httpFetch` already retries 5xx / 429.
   */
  async function fetchPage<T extends CeloscanNormalTx[] | CeloscanTokenTx[] | CeloscanInternalTx[]>(
    args: FetchPageArgs,
  ): Promise<T> {
    const url = buildUrl(args);
    let res: HttpResponse<CeloscanResponse<T>>;
    try {
      res = await fetcher<CeloscanResponse<T>>(url);
    } catch (err) {
      throw new CeloscanError(
        `Celoscan request failed (${args.endpoint} page=${args.page}): ${err instanceof Error ? err.message : String(err)}`,
        err,
      );
    }
    const body = res.data;
    if (body.status === '0' && body.message !== 'No transactions found') {
      throw new CeloscanError(
        `Celoscan error (${args.endpoint} page=${args.page}): ${body.message ?? 'unknown'}`,
      );
    }
    return body.result ?? ([] as unknown as T);
  }

  /** Build a URL for one (address) getsourcecode call. */
  function buildContractUrl(address: Address): string {
    const u = new URL(apiUrl);
    u.searchParams.set('module', 'contract');
    u.searchParams.set('action', 'getsourcecode');
    u.searchParams.set('address', address);
    if (chainId !== undefined) u.searchParams.set('chainid', String(chainId));
    if (apiKey) u.searchParams.set('apikey', apiKey);
    return u.toString();
  }

  /**
   * Fetch Celoscan contract metadata for one address. Returns `null` on
   * Celoscan `status=0` (unknown or unverified address). Throws `CeloscanError`
   * on network/HTTP failures.
   */
  async function fetchContractMetadata(address: Address): Promise<ContractMetadata | null> {
    const url = buildContractUrl(address);
    let res: HttpResponse<CeloscanResponse<CeloscanContractSource[]>>;
    try {
      res = await fetcher<CeloscanResponse<CeloscanContractSource[]>>(url);
    } catch (err) {
      throw new CeloscanError(
        `Celoscan contract-metadata request failed for ${address}: ${err instanceof Error ? err.message : String(err)}`,
        err,
      );
    }
    const body = res.data;
    if (body.status === '0') return null; // unknown address or not verified
    const row = body.result?.[0];
    if (!row) return null;
    const rawName = typeof row.ContractName === 'string' ? row.ContractName.trim() : '';
    const name = rawName.length > 0 ? rawName : '';
    const isProxy = String(row.Proxy ?? '') === '1';
    const implRaw = typeof row.Implementation === 'string' ? row.Implementation.trim() : '';
    const impl =
      implRaw.length > 0 && /^0x[0-9a-fA-F]{40}$/.test(implRaw) ? (implRaw as Address) : null;
    return { name, isProxy, impl, verifiedAt: '' };
  }

  /**
   * Batch version with bounded concurrency. Returns a Map keyed by lowercase
   * address. Addresses that fail to resolve (network/Celoscan error) are
   * omitted from the result — never throw, callers must keep going.
   * `limit` defaults to {@link DEFAULT_RATE_LIMIT_CONCURRENCY}.
   */
  async function fetchContractMetadataBatch(
    addresses: readonly Address[],
    limit: number = DEFAULT_RATE_LIMIT_CONCURRENCY,
  ): Promise<Map<Address, ContractMetadata>> {
    const out = new Map<Address, ContractMetadata>();
    if (addresses.length === 0) return out;
    const l = pLimit(Math.max(1, limit));
    // Lowercase keys up front so the map is case-insensitive at lookup time
    // (Celoscan returns addresses in mixed case; callers should normalize).
    const unique = Array.from(new Set(addresses.map((a) => a.toLowerCase())));
    await Promise.allSettled(
      unique.map((addr) =>
        l(async () => {
          try {
            const meta = await fetchContractMetadata(addr as Address);
            if (meta) out.set(addr as Address, meta);
          } catch {
            // Per-address error: skip silently so one bad address doesn't
            // void the whole batch.
          }
        }),
      ),
    );
    return out;
  }

  return {
    fetchPage,
    buildUrl,
    buildContractUrl,
    fetchContractMetadata,
    fetchContractMetadataBatch,
    /** Exposed so the pagination loop can detect "short" pages correctly. */
    maxPageSize,
  };
}

// Type exports for the pagination layer.
export type { Timestamp };
