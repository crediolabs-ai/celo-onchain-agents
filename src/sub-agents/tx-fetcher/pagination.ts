/**
 * Pagination loop for Celoscan endpoints.
 *
 * Owner: Credio (tx-fetcher sub-agent).
 *
 * Celoscan returns at most 10_000 rows per call; wallets with >100 normal
 * txs require multiple pages. This loop keeps calling `fetchPage` with
 * monotonically increasing `page` until the result is shorter than the
 * page size (signalling "last page") or empty.
 *
 * Returns all rows concatenated in arrival order. Throws on per-page errors
 * so the caller can surface them via the FetchedTxData.fetchErrors surface.
 *
 * Hit-cap detection: Celoscan enforces `page × offset ≤ 10_000`. With the
 * default `maxPageSize=100`, that means we can fetch at most 100 pages
 * (10,000 rows). For wallets with more than 10,000 txs (e.g. exchanges,
 * heavy user wallets), the loop exits via `page > maxPages` and
 * `paginationComplete: false` is returned. Without this flag the caller
 * can't distinguish "we got everything" from "we hit the cap".
 */

import type { Address } from '../../shared/types.js';
import { createCeloscanClient } from './celoscan.js';
import type {
  CeloscanInternalTx,
  CeloscanNormalTx,
  CeloscanTokenTx,
  CeloscanEndpoint,
} from './types.js';

export interface PaginateArgs {
  client: ReturnType<typeof createCeloscanClient>;
  endpoint: CeloscanEndpoint;
  address: Address;
  startblock?: number;
  endblock?: number;
  sort?: 'asc' | 'desc';
  /** Hard cap to prevent runaway loops. Default 100 pages × 100 = 10k rows. */
  maxPages?: number;
}

/** Result shape returned by the paginate* wrappers. */
export interface PaginateResult<T> {
  rows: T[];
  /** False when the loop exited because `page > maxPages` instead of
   *  receiving a short last page. Set to false means the caller should
   *  flag the data as incomplete (some txs may be missing). */
  paginationComplete: boolean;
  /** How many pages were fetched. Useful for diagnostics. */
  pagesFetched: number;
}

const DEFAULT_MAX_PAGES = 100;

/** Paginate the normal-transactions endpoint. */
export async function paginateNormalTxs(args: PaginateArgs): Promise<PaginateResult<CeloscanNormalTx>> {
  return paginateRows(args) as Promise<PaginateResult<CeloscanNormalTx>>;
}

/** Paginate the token-transfers endpoint. */
export async function paginateTokenTxs(args: PaginateArgs): Promise<PaginateResult<CeloscanTokenTx>> {
  return paginateRows(args) as Promise<PaginateResult<CeloscanTokenTx>>;
}

/** Paginate the internal-transactions endpoint. */
export async function paginateInternalTxs(args: PaginateArgs): Promise<PaginateResult<CeloscanInternalTx>> {
  return paginateRows(args) as Promise<PaginateResult<CeloscanInternalTx>>;
}

/**
 * Generic pagination loop. We type-erase the row type inside the loop
 * (since all three endpoints share the same paginate shape) and cast on
 * the way out via the wrappers above. This keeps the loop DRY without
 * the gymnastics of a higher-kinded generic over a union of array types.
 *
 * Rate-limit handling: the Celoscan V2 endpoint returns
 * `status=0, message=NOTOK, result="Max calls per sec rate limit
 * reached (3/sec)"` when the per-second call budget is exhausted.
 * Because `Promise.allSettled` parallelises three endpoints, even
 * offset=100 isn't enough headroom — a wallet with >100 txs hits the
 * limit on the second page of any endpoint. We detect the
 * `Max calls per sec rate limit reached` message and sleep 1.2s
 * before retrying, which resets the 3/sec budget.
 */
async function paginateRows(
  args: PaginateArgs,
): Promise<PaginateResult<unknown>> {
  const { client, endpoint, address, startblock, endblock, sort, maxPages = DEFAULT_MAX_PAGES } = args;
  const all: unknown[] = [];
  let paginationComplete = true;
  let pagesFetched = 0;
  for (let page = 1; page <= maxPages; page++) {
    let rows: unknown[] = [];
    let rateLimitRetries = 0;
    // Up to 3 rate-limit retries per page before giving up. 3 × 1.2s
    // ≈ 3.6s extra, well within the 30s http.ts timeout.
    while (true) {
      try {
        rows = await client.fetchPage({
          address,
          endpoint,
          page,
          ...(startblock !== undefined && { startblock }),
          ...(endblock !== undefined && { endblock }),
          ...(sort !== undefined && { sort }),
        });
        break;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('rate limit') && rateLimitRetries < 3) {
          rateLimitRetries++;
          await sleep(1200);
          continue;
        }
        throw err;
      }
    }
    pagesFetched = page;
    if (rows.length === 0) break;
    all.push(...rows);
    // Last page is signalled by a short result. Threshold = the client's
    // configured `maxPageSize` (Celoscan default 100, hard-capped at
    // 10_000 rows total by the `page × offset ≤ 10_000` rule).
    if (rows.length < client.maxPageSize) break;
    // We received a full page. If the next iteration would exceed
    // `maxPages`, mark paginationComplete=false and stop. Otherwise
    // continue (next page will be fetched in the for-loop continuation).
    if (page === maxPages) {
      paginationComplete = false;
      // Surface a diagnostic so the caller can see this in the CLI
      // summary. Silent data loss was the previous behavior.
      console.warn(
        `[tx-fetcher] pagination cap hit on ${endpoint} for ${address}: ` +
        `fetched ${page * client.maxPageSize} rows; more may exist.`,
      );
      break;
    }
  }
  return { rows: all, paginationComplete, pagesFetched };
}

/** Sleep for `ms` milliseconds. Resolves immediately on 0/negative. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}
