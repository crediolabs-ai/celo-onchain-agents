/**
 * Unit tests for the Vault Oracle.
 *
 * Owner: Credio (infra).
 *
 * Stub pattern: inject a fake `VaultReadClient` (the structural type
 * `vault-oracle.ts` exports) and a stub `DefiLlamaOracle` (the DefiLlama
 * class isn't test-friendly when used as a dependency — it's a class
 * with a private cache — so the test treats it as a duck-typed object).
 */

import { describe, expect, it } from 'vitest';
import { VaultOracle, type VaultReadClient } from '../../src/infra/vault-oracle.js';
import type { Address, Timestamp } from '../../src/shared/types.js';
import type { PricePoint } from '../../src/shared/price-oracle/defillama.js';

const VAULT = '0x2a68c98bd43aa24331396f29166aef2bfd51343f' as Address;
const UNKNOWN_VAULT = '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef' as Address;
const TS = 1_750_000_000 as Timestamp;
const BLOCK = 29_597_172n;

function stubDeps(opts: {
  convertToAssetsResult?: bigint;
  readContractThrows?: boolean;
  underlyingUsdPrice?: number | null;
}) {
  const publicClient: VaultReadClient = opts.readContractThrows
    ? {
        readContract: async () => {
          throw new Error('RPC failure');
        },
      }
    : {
        readContract: async () => opts.convertToAssetsResult ?? 0n,
      };
  const defiLlamaOracle = {
    getHistoricalPrice: async (_symbol: string, _ts: Timestamp): Promise<PricePoint | null> => {
      if (opts.underlyingUsdPrice === null || opts.underlyingUsdPrice === undefined) return null;
      return { timestamp: _ts, priceUsd: opts.underlyingUsdPrice, staleByHours: 0 };
    },
  };
  return new VaultOracle({ rpcUrl: '', defiLlamaOracle: defiLlamaOracle as never, publicClient });
}

describe('VaultOracle', () => {
  it('returns null for an unknown vault address', async () => {
    const oracle = stubDeps({ convertToAssetsResult: 1_000_000_000n, underlyingUsdPrice: 1.0 });
    const price = await oracle.getSharePriceUsd(UNKNOWN_VAULT, BLOCK, TS);
    expect(price).toBeNull();
  });

  it('computes share price from convertToAssets for a USDC-backed vault', async () => {
    // 1e18 shares (1 full share) = 999_500 USDC units (USDC has 6 decimals)
    //   → ratio = 999_500 / 1_000_000 = 0.9995 USDC per share
    // USDC USD price = 1.0 → share price = 0.9995 * 1.0 = 0.9995
    const oracle = stubDeps({ convertToAssetsResult: 999_500n, underlyingUsdPrice: 1.0 });
    const price = await oracle.getSharePriceUsd(VAULT, BLOCK, TS);
    expect(price).not.toBeNull();
    expect(price).toBeCloseTo(0.9995, 4);
  });

  it('combines convertToAssets ratio with non-1.0 underlying USD price', async () => {
    // 1 share = 1.2 USDC at the block, USDC USD price = 0.60 (depegged)
    //   → ratio = 1_200_000 / 1_000_000 = 1.2
    //   → share price = 1.2 * 0.60 = 0.72
    const oracle = stubDeps({ convertToAssetsResult: 1_200_000n, underlyingUsdPrice: 0.6 });
    const price = await oracle.getSharePriceUsd(VAULT, BLOCK, TS);
    expect(price).not.toBeNull();
    expect(price).toBeCloseTo(0.72, 4);
  });

  it('returns null when readContract throws (RPC failure)', async () => {
    const oracle = stubDeps({ readContractThrows: true, underlyingUsdPrice: 1.0 });
    const price = await oracle.getSharePriceUsd(VAULT, BLOCK, TS);
    expect(price).toBeNull();
  });

  it('returns null when underlying USD price is unavailable', async () => {
    const oracle = stubDeps({ convertToAssetsResult: 999_500n, underlyingUsdPrice: null });
    const price = await oracle.getSharePriceUsd(VAULT, BLOCK, TS);
    expect(price).toBeNull();
  });

  it('returns null when convertToAssets returns 0 (degenerate ratio)', async () => {
    const oracle = stubDeps({ convertToAssetsResult: 0n, underlyingUsdPrice: 1.0 });
    const price = await oracle.getSharePriceUsd(VAULT, BLOCK, TS);
    expect(price).toBeNull();
  });
});
