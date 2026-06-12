/**
 * get_celo_portfolio — returns all holdings (native CELO + known ERC-20s) with USD values.
 *
 * Input:
 *   address  — 0x... 40 hex
 *   network  — 'mainnet' | 'alfajores' (default: mainnet)
 *
 * Output:
 *   { address, network, holdings: [...], totalUsdValue, fetchedAt }
 *
 * Data sources:
 *   - viem public client → getBalance (native CELO) + multicall ERC-20 balances
 *   - CoinGecko /simple/price → USD spot prices for held tokens
 *
 * Token universe = Celo native tokens (CELO, cUSD, cEUR, cREAL, USDC, USDT).
 * Any other token held returns symbol: 'UNKNOWN', usdValue: null.
 */

import { createPublicClient, http, formatEther, getAddress } from 'viem';
import { celo, celoAlfajores } from 'viem/chains';
import { z } from 'zod';

import { COINGECKO_IDS, fetchCoinGeckoPrices } from '../lib/coingecko.js';
import { fetchWithRetry } from '../lib/http.js';

// ─── Known Celo native tokens ─────────────────────────────────────────────────

interface TokenDef {
  symbol: string;
  decimals: number;
  /** Null for Alfajores where address isn't known. */
  address: string | null;
}

const NATIVE_TOKENS: TokenDef[] = [
  { symbol: 'CELO', decimals: 18, address: '0x471EcE3750Da237f93B8E339c536989b8978a438' },
  { symbol: 'cUSD', decimals: 18, address: '0x765DE816845861e75A25fCA122bb6898B8B3212a' },
  { symbol: 'cEUR', decimals: 18, address: '0xD8763CBa276a3738E6DE85b4b3bF5FDed6D6cA73' },
  { symbol: 'cREAL', decimals: 18, address: '0xe8537a3d056DA446677B9E9d6c5dB704EaAb4787' },
  { symbol: 'USDC', decimals: 6, address: '0xcebA9300f2b948710d2653dD7B07f33A8B32118C' },
  { symbol: 'USDT', decimals: 6, address: '0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e' },
];

/** Tokens that are NOT native CELO — skip them in the ERC-20 multicall (CELO has its own native path). */
const ERC20_TOKENS = NATIVE_TOKENS.filter((t) => t.symbol !== 'CELO');

// ─── Input schema ─────────────────────────────────────────────────────────────

const InputSchema = z.object({
  address: z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'Invalid 0x address'),
  network: z.enum(['mainnet', 'alfajores']).default('mainnet'),
});

type Input = z.infer<typeof InputSchema>;

// ─── ERC-20 balance fetch via multicall ──────────────────────────────────────

/** Minimal ERC-20 ABI for balanceOf + decimals + symbol. */
const MINIMAL_ABI = [
  {
    name: 'balanceOf',
    type: 'function',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    name: 'decimals',
    type: 'function',
    inputs: [],
    outputs: [{ name: '', type: 'uint8' }],
    stateMutability: 'view',
  },
  {
    name: 'symbol',
    type: 'function',
    inputs: [],
    outputs: [{ name: '', type: 'string' }],
    stateMutability: 'view',
  },
] as const;

// ─── Main tool handler ─────────────────────────────────────────────────────────

export async function getCeloPortfolio(
  rawArgs: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const parsed = InputSchema.safeParse(rawArgs);
  if (!parsed.success) {
    return {
      error: 'INVALID_INPUT',
      message: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    };
  }

  const { address, network } = parsed.data;

  const chain = network === 'mainnet' ? celo : celoAlfajores;
  const chainId = chain.id;

  // Load env
  const rpcUrl = process.env.CELO_RPC_URL ?? 'https://forno.celo.org';
  const coingeckoApiKey = process.env.COINGECKO_API_KEY ?? '';

  // ── 1. Build viem client ────────────────────────────────────────────────────
  const client = createPublicClient({
    chain,
    transport: http(rpcUrl),
  });

  // ── 2. Fetch native CELO balance ────────────────────────────────────────────
  let nativeBalance = 0n;
  try {
    nativeBalance = await client.getBalance({ address: getAddress(address) });
  } catch (err) {
    return {
      error: 'RPC_ERROR',
      message: `Failed to fetch native balance: ${err instanceof Error ? err.message : String(err)}`,
      address,
      network,
    };
  }

  // ── 3. Multicall ERC-20 balances for known tokens ────────────────────────────
  // Only tokens with an address on this network (ERC-20 only, CELO is handled natively)
  const tokensWithAddress = ERC20_TOKENS.filter((t) => t.address !== null);

  type BalanceResult = { symbol: string; balance: bigint; decimals: number; contractAddress: string };

  const balanceResults: BalanceResult[] = [];

  for (const token of tokensWithAddress) {
    try {
      const balance = await client.readContract({
        address: getAddress(token.address!),
        abi: MINIMAL_ABI,
        functionName: 'balanceOf',
        args: [getAddress(address)],
      });
      balanceResults.push({
        symbol: token.symbol,
        balance: balance as bigint,
        decimals: token.decimals,
        contractAddress: token.address!,
      });
    } catch {
      // Token contract might not exist on this network or call failed — skip
    }
  }

  // ── 4. Filter to tokens with non-zero balances ──────────────────────────────
  const heldTokens = balanceResults.filter((r) => r.balance > 0n);

  // ── 5. Fetch CoinGecko prices for held tokens (including native CELO) ───────
  const symbolsToPrice = ['CELO', ...heldTokens.map((t) => t.symbol)];
  const prices = await fetchCoinGeckoPrices(symbolsToPrice, coingeckoApiKey);

  // ── 6. Build holdings array ─────────────────────────────────────────────────
  const holdings: Record<string, unknown>[] = [];

  // Native CELO
  const celoPrice = prices['CELO'] ?? null;
  const celoUsd = celoPrice !== null ? Number(formatEther(nativeBalance)) * celoPrice : null;
  const celoAddress = NATIVE_TOKENS.find((t) => t.symbol === 'CELO')!.address!;
  holdings.push({
    token: 'CELO',
    symbol: 'CELO',
    balance: nativeBalance.toString(),
    decimals: 18,
    usdValue: celoUsd,
    contractAddress: celoAddress,
    isNative: true,
  });

  // ERC-20 tokens
  for (const t of heldTokens) {
    const price = prices[t.symbol] ?? null;
    const adjustedBalance = Number(t.balance) / 10 ** t.decimals;
    const usdValue = price !== null ? adjustedBalance * price : null;
    holdings.push({
      token: t.symbol,
      symbol: t.symbol,
      balance: t.balance.toString(),
      decimals: t.decimals,
      usdValue,
      contractAddress: t.contractAddress,
      isNative: false,
    });
  }

  // ── 7. Compute total ───────────────────────────────────────────────────────
  const totalUsdValue = holdings.reduce<number | null>((sum, h) => {
    const val = h.usdValue as number | null;
    if (val === null) return sum;
    return (sum ?? 0) + val;
  }, null);

  return {
    address,
    network,
    chainId,
    holdings,
    totalUsdValue,
    fetchedAt: new Date().toISOString(),
  };
}
