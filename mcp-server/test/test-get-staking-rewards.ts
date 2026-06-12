import 'dotenv/config';
import { getStakingRewards } from '../src/tools/get-staking-rewards.js';

/**
 * Integration test for get_staking_rewards tool.
 *
 * Directly invokes the handler (server wiring is Wave 7) to test real Celoscan + CoinGecko.
 * Demo wallet: 0x4678ED5759c734E4D98267d8E84B23f62D86C0c1 (0x4678…1c25)
 * Time range: 2024-01-01 → 2026-12-31
 *
 * Run: cd mcp-server && npx tsx test/test-get-staking-rewards.ts
 */

const DEMO_ADDRESS = '0x4678ED5759c734E4D98267d8E84B23f62D86C0c1';
const DEMO_ADDRESS_TRIMMED = '0x4678…1c25';

async function main(): Promise<void> {
  if (!process.env.CELOSCAN_API_KEY) {
    console.warn('[SKIP] CELOSCAN_API_KEY not set — skipping live Celoscan test');
    process.exit(0);
  }

  console.log('[TEST] get_staking_rewards integration test');
  console.log(`[TEST] Demo wallet: ${DEMO_ADDRESS_TRIMMED}`);

  const result = await getStakingRewards({
    address: DEMO_ADDRESS,
    network: 'mainnet',
    fromTimestamp: Math.floor(new Date('2024-01-01').getTime() / 1000),
    toTimestamp: Math.floor(new Date('2026-12-31').getTime() / 1000),
  });

  if (!('address' in result)) {
    throw new Error(`Expected 'address' in result, got: ${JSON.stringify(result)}`);
  }

  const rewards = result.rewards as unknown[];
  if (!Array.isArray(rewards)) {
    throw new Error(`Expected 'rewards' array, got: ${JSON.stringify(result)}`);
  }

  console.log(`[TEST] Rewards found: ${rewards.length}`);
  console.log(`[TEST] Total rewards (CELO): ${result.totalRewardsCel}`);
  console.log(`[TEST] Data source: ${result.dataSource}`);
  console.log(`[TEST] Epoch count: ${result.epochCount}`);

  if (rewards.length > 0) {
    const first = rewards[0] as Record<string, unknown>;
    if (typeof first.amountCel !== 'string') throw new Error(`amountCel should be string, got: ${first.amountCel}`);
    if (typeof first.timestamp !== 'number') throw new Error(`timestamp should be number, got: ${first.timestamp}`);
    if (first.amountUsd !== null && typeof first.amountUsd !== 'number') {
      throw new Error(`amountUsd should be number|null, got: ${first.amountUsd}`);
    }
    console.log(`[TEST] First reward: ${first.amountCel} CELO at block ${first.blockNumber}`);
  }

  if (result.dataSource !== 'transfer-heuristic') {
    console.warn(`[WARN] Expected dataSource=transfer-heuristic, got: ${result.dataSource}`);
  }

  console.log('[PASS] get_staking_rewards returned valid structure');
  console.log('[TEST] Done.');
}

main().catch((err) => {
  console.error('[FAIL]', err.message);
  process.exit(1);
});
