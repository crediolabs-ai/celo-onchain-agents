/**
 * get_staking_rewards — returns Celo validator/epoch staking rewards for an address.
 *
 * TRANSFER-HEURISTIC (v1 — STAKING_REWARD_DISTRIBUTOR address is null):
 *   Fetches all incoming CELO token transfers to the address via Celoscan ?action=tokentx.
 *   Groups transfers by (sender, amount). Groups with ≥2 transfers within ≤7 days are
 *   flagged as epoch/staking rewards — Celo distributes rewards once per epoch (≈daily)
 *   as equal CELO amounts. False positives unlikely (ordinary transfers rarely repeat
 *   identical amounts). False negatives possible if validator changed its distribution
 *   address or reward was tiny. Upgrade to eth_getLogs path (v2) when EpochRewards
 *   address is populated in src/shared/contracts.ts.
 *
 * Input:  address, network (default mainnet), fromTimestamp, toTimestamp (optional Unix s)
 * Output: { address, network, totalRewardsCel, rewards[], epochCount, fetchedAt, dataSource }
 */

import { z } from 'zod';
import { fetchCoinGeckoPrices } from '../lib/coingecko.js';
import { fetchWithRetry } from '../lib/http.js';

const CELO_TOKEN_CONTRACT_MAINNET = '0x471EcE3750Da237f93B8E339c536989b8978a438';
const CELO_TOKEN_CONTRACT_ALFAJORES = '0xF194afDf50C6e62cAd8216D3603f0f9B7A4D3a2B';

const InputSchema = z.object({
  address: z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'Invalid 0x address'),
  network: z.enum(['mainnet', 'alfajores']).default('mainnet'),
  fromTimestamp: z.number().int().nonnegative().optional(),
  toTimestamp: z.number().int().nonnegative().optional(),
});

const CHAIN_IDS = { mainnet: 42220, alfajores: 44787 } as const;

interface CeloscanTokenTx {
  hash: string; blockNumber: string; timeStamp: string; from: string; to: string; value: string;
}

interface CeloscanTokenTxResponse {
  status: string; message: string; result: CeloscanTokenTx[];
}

/**
 * Groups txs by (sender, amount). Keeps groups with ≥2 transfers where any pair
 * is ≤7 days apart — captures Celo's once-per-epoch reward distribution pattern.
 */
function findRewardGroups(txs: CeloscanTokenTx[]): Map<string, CeloscanTokenTx[]> {
  const groups = new Map<string, CeloscanTokenTx[]>();
  for (const tx of txs) {
    const key = `${tx.from}:${tx.value}`;
    (groups.get(key) ?? []).push(tx);
    groups.set(key, groups.get(key)!);
  }
  const rewardGroups = new Map<string, CeloscanTokenTx[]>();
  for (const [, g] of groups) {
    if (g.length < 2) continue;
    for (let i = 0; i < g.length - 1; i++) {
      if (parseInt(g[i + 1].timeStamp, 10) - parseInt(g[i].timeStamp, 10) <= 604_800) {
        rewardGroups.set(`${g[i].from}:${g[i].value}`, g);
        break;
      }
    }
  }
  return rewardGroups;
}

export async function getStakingRewards(
  rawArgs: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const parsed = InputSchema.safeParse(rawArgs);
  if (!parsed.success) {
    return {
      error: 'INVALID_INPUT',
      message: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    };
  }

  const { address, network, fromTimestamp, toTimestamp } = parsed.data;

  const apiUrl = process.env.CELOSCAN_API_URL ?? 'https://api.etherscan.io/v2/api';
  const apiKey = process.env.CELOSCAN_API_KEY ?? '';
  const coingeckoApiKey = process.env.COINGECKO_API_KEY ?? '';
  const chainId = CHAIN_IDS[network];
  const celoContract =
    network === 'mainnet' ? CELO_TOKEN_CONTRACT_MAINNET : CELO_TOKEN_CONTRACT_ALFAJORES;

  // Paginate incoming CELO token transfers
  const allTokenTxs: CeloscanTokenTx[] = [];
  let page = 1;
  const offset = 100;
  let hasMore = true;

  while (hasMore) {
    const params = new URLSearchParams({
      module: 'account', action: 'tokentx', address,
      contractaddress: celoContract, startblock: '0', endblock: '999999999',
      page: String(page), offset: String(offset), sort: 'asc', chainid: String(chainId),
    });
    if (apiKey) params.set('apikey', apiKey);

    let raw: CeloscanTokenTxResponse;
    try {
      raw = await fetchWithRetry<CeloscanTokenTxResponse>(`${apiUrl}?${params.toString()}`);
    } catch (err) {
      return {
        error: 'CELOSCAN_ERROR',
        message: `Failed to fetch CELO transfers: ${err instanceof Error ? err.message : String(err)}`,
        address, network,
      };
    }

    if (raw.status === '0' && raw.message !== 'No transactions found') {
      return { error: 'CELOSCAN_ERROR', message: raw.message ?? 'Unknown Celoscan error', address, network };
    }

    const txs: CeloscanTokenTx[] = raw.result ?? [];
    allTokenTxs.push(...txs);
    hasMore = txs.length === offset;
    if (++page > 100) break;
  }

  // Filter to incoming + timestamp window, then apply heuristic
  const addr = address.toLowerCase();
  const filtered = allTokenTxs.filter((tx) => {
    if (tx.to.toLowerCase() !== addr) return false;
    const ts = parseInt(tx.timeStamp, 10);
    if (fromTimestamp !== undefined && ts < fromTimestamp) return false;
    if (toTimestamp !== undefined && ts > toTimestamp) return false;
    return true;
  });

  const rewardGroups = findRewardGroups(filtered);
  const rewardTxs: CeloscanTokenTx[] = [];
  for (const g of rewardGroups.values()) rewardTxs.push(...g);
  rewardTxs.sort((a, b) => parseInt(a.timeStamp, 10) - parseInt(b.timeStamp, 10));

  // USD price for CELO
  const celoPriceUsd = (await fetchCoinGeckoPrices(['CELO'], coingeckoApiKey))['CELO'] ?? null;

  // Build reward entries
  let totalRewardsCel = 0n;
  const rewards = rewardTxs.map((tx) => {
    const amountCelRaw = BigInt(tx.value);
    totalRewardsCel += amountCelRaw;
    const amountCel = (Number(amountCelRaw) / 1e18).toFixed(18);
    return {
      txHash: tx.hash,
      blockNumber: parseInt(tx.blockNumber, 10),
      timestamp: parseInt(tx.timeStamp, 10),
      amountCel,
      amountUsd: celoPriceUsd !== null ? parseFloat(amountCel) * celoPriceUsd : null,
      validatorGroup: tx.from,
    };
  });

  return {
    address, network,
    totalRewardsCel: (Number(totalRewardsCel) / 1e18).toFixed(18),
    rewards, epochCount: rewards.length,
    fetchedAt: new Date().toISOString(),
    dataSource: 'transfer-heuristic',
    caveats: [
      'STAKING_REWARD_DISTRIBUTOR address is null in src/shared/contracts.ts — using transfer heuristic (v1).',
      'Heuristic: groups of ≥2 identical-amount CELO transfers from the same sender within ≤7 days are flagged as staking rewards.',
      'False negatives possible if validator changed distribution address or reward was smaller than ordinary tx.',
    ],
  };
}
