/**
 * get_celo_transaction_history — returns transactions for a Celo address from Celoscan V2 API.
 *
 * Input:
 *   address     — wallet address
 *   network     — 'mainnet' | 'alfajores' (default: mainnet)
 *   fromBlock   — optional start block
 *   toBlock     — optional end block
 *   page        — page number 1-10 (default: 1)
 *   offset      — page size 1-100 (default: 100)
 *
 * Output:
 *   { address, network, transactions: [...], totalReturned, page, hasMore }
 *
 * Data source: Celoscan V2 (Etherscan-compatible unified endpoint).
 *   chainid=42220 for Celo mainnet.
 */

import { z } from 'zod';

import { fetchWithRetry, sleep } from '../lib/http.js';

// ─── Input schema ─────────────────────────────────────────────────────────────

const InputSchema = z.object({
  address: z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'Invalid 0x address'),
  network: z.enum(['mainnet', 'alfajores']).default('mainnet'),
  fromBlock: z.number().int().nonnegative().optional(),
  toBlock: z.number().int().nonnegative().optional(),
  page: z.number().int().min(1).max(10).default(1),
  offset: z.number().int().min(1).max(100).default(100),
});

type Input = z.infer<typeof InputSchema>;

// ─── Celoscan response types ───────────────────────────────────────────────────

interface CeloscanResponse<T> {
  status: string;
  message: string;
  result: T;
}

interface CeloscanTx {
  hash: string;
  blockNumber: string;
  from: string;
  to: string;
  value: string;
  isError: string;
  timestamp: string;
  functionSelector?: string;
  input?: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const CHAIN_IDS = { mainnet: 42220, alfajores: 44787 } as const;

// ─── Main tool handler ────────────────────────────────────────────────────────

export async function getCeloTransactionHistory(
  rawArgs: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const parsed = InputSchema.safeParse(rawArgs);
  if (!parsed.success) {
    return {
      error: 'INVALID_INPUT',
      message: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    };
  }

  const { address, network, fromBlock, toBlock, page, offset } = parsed.data;

  // Env
  const apiUrl = process.env.CELOSCAN_API_URL ?? 'https://api.etherscan.io/v2/api';
  const apiKey = process.env.CELOSCAN_API_KEY ?? '';
  const chainId = CHAIN_IDS[network];

  // ── Build Celoscan URL ─────────────────────────────────────────────────────
  const params = new URLSearchParams({
    module: 'account',
    action: 'txlist',
    address,
    startblock: String(fromBlock ?? 0),
    endblock: String(toBlock ?? 99_999_999),
    page: String(page),
    offset: String(offset),
    sort: 'desc',
    chainid: String(chainId),
  });
  if (apiKey) params.set('apikey', apiKey);
  const url = `${apiUrl}?${params.toString()}`;

  // ── Fetch ─────────────────────────────────────────────────────────────────
  let raw: CeloscanResponse<CeloscanTx[]>;

  try {
    raw = await fetchWithRetry<CeloscanResponse<CeloscanTx[]>>(url);
  } catch (err) {
    return {
      error: 'CELOSCAN_ERROR',
      message: `Failed to fetch transactions: ${err instanceof Error ? err.message : String(err)}`,
      address,
      network,
    };
  }

  // Celoscan returns status="0" with message="No transactions found" for empty results
  if (raw.status === '0' && raw.message !== 'No transactions found') {
    return {
      error: 'CELOSCAN_ERROR',
      message: raw.message ?? 'Unknown Celoscan error',
      address,
      network,
    };
  }

  const txs = raw.result ?? [];

  // ── Normalize ──────────────────────────────────────────────────────────────
  const transactions = txs.map((tx) => ({
    hash: tx.hash,
    blockNumber: parseInt(tx.blockNumber, 10),
    from: tx.from,
    to: tx.to ?? null,
    value: tx.value,
    timestamp: parseInt(tx.timestamp, 10),
    isError: tx.isError === '1',
    functionSelector: tx.functionSelector ?? null,
    input: tx.input !== '0x' ? tx.input : null,
  }));

  const totalReturned = transactions.length;
  // If we got a full page, there are probably more
  const hasMore = totalReturned === offset;

  return {
    address,
    network,
    chainId,
    transactions,
    totalReturned,
    page,
    hasMore,
    fetchedAt: new Date().toISOString(),
  };
}
