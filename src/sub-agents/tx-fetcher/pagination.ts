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

const DEFAULT_MAX_PAGES = 100;

/** Paginate the normal-transactions endpoint. */
export async function paginateNormalTxs(args: PaginateArgs): Promise<CeloscanNormalTx[]> {
  const rows = await paginateRows(args);
  return rows as CeloscanNormalTx[];
}

/** Paginate the token-transfers endpoint. */
export async function paginateTokenTxs(args: PaginateArgs): Promise<CeloscanTokenTx[]> {
  const rows = await paginateRows(args);
  return rows as CeloscanTokenTx[];
}

/** Paginate the internal-transactions endpoint. */
export async function paginateInternalTxs(args: PaginateArgs): Promise<CeloscanInternalTx[]> {
  const rows = await paginateRows(args);
  return rows as CeloscanInternalTx[];
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
): Promise<unknown[]> {
  const { client, endpoint, address, startblock, endblock, sort, maxPages = DEFAULT_MAX_PAGES } = args;
  const all: unknown[] = [];
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
    if (rows.length === 0) break;
    all.push(...rows);
    // Last page is signalled by a short result. Threshold = the client's
    // configured `maxPageSize` (Celoscan default 10_000).
    if (rows.length < client.maxPageSize) break;
  }
  return all;
}

/** Sleep for `ms` milliseconds. Resolves immediately on 0/negative. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}
