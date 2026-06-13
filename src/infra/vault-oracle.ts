/**
 * Vault Oracle — USD price of an ERC-4626 vault share at a historical block.
 *
 * Owner: Credio (infra).
 *
 * Why this exists:
 *   - Vault receipt tokens (USDyc, m-cUSD, etc.) are synthetic — minted by
 *     the vault contract, not by an external issuer. DefiLlama and CoinGecko
 *     do not list them.
 *   - The vault itself is the source of truth for its own exchange rate via
 *     `convertToAssets(uint256)`. Reading that at a historical block gives
 *     the share-to-underlying ratio at that moment.
 *   - Combined with the underlying's USD price, this yields a canonical
 *     "fair value" of one vault share for tax reporting.
 *
 * Pipeline:
 *   1. Read `convertToAssets(1e18)` on the vault at the event's block
 *      (1 share = `assetsOut` underlying wei).
 *   2. Normalize to a unitless ratio: `assetsOut / 10^underlyingDecimals`.
 *   3. Look up the underlying's USD price at the event's timestamp
 *      (via DefiLlama — handles stables at ~$1, real assets at real prices).
 *   4. Return `ratio * underlyingUsdPrice`.
 *
 * Failure modes (all return `null`, never throw — caller falls back to
 * DefiLlama or records a price gap):
 *   - Unknown vault (not in `VAULT_UNDERLYING_BY_ADDRESS`).
 *   - RPC read fails (offline, rate-limited, bad archive node).
 *   - Underlying's USD price unavailable.
 */

import { createPublicClient, http, type Address } from 'viem';
import { celo } from 'viem/chains';
import { DefiLlamaOracle } from '../shared/price-oracle/defillama.js';
import { VAULT_UNDERLYING_BY_ADDRESS } from '../shared/contracts.js';
import type { Timestamp } from '../shared/types.js';

/** 1 share expressed in the ERC-4626 standard's 18-decimal precision. */
const SHARES_UNIT = 10n ** 18n;

/** Minimal ABI for `convertToAssets(uint256) → uint256`. */
const ERC4626_CONVERT_TO_ASSETS_ABI = [
  {
    name: 'convertToAssets',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'shares', type: 'uint256' }],
    outputs: [{ name: 'assets', type: 'uint256' }],
  },
] as const;

/**
 * Structural read-only client shape we need from viem. Typed as a
 * minimal interface (not `PublicClient`) so test stubs don't have to
 * match the chain-specific generic — viem exports many `PublicClient`
 * flavors and structural subtyping keeps the surface testable.
 */
export interface VaultReadClient {
  readContract(args: {
    address: Address;
    abi: typeof ERC4626_CONVERT_TO_ASSETS_ABI;
    functionName: 'convertToAssets';
    args: [bigint];
    blockNumber: bigint;
  }): Promise<bigint>;
}

export interface VaultOracleOptions {
  /** Celo RPC URL. Forks/archive nodes required for historical `blockNumber` reads. */
  rpcUrl: string;
  /** Used to look up the underlying token's USD price. */
  defiLlamaOracle: DefiLlamaOracle;
  /** Override the public client (used by tests to stub the RPC). */
  publicClient?: VaultReadClient;
}

export class VaultOracle {
  private readonly defiLlama: DefiLlamaOracle;
  private readonly publicClient: VaultReadClient;

  constructor(opts: VaultOracleOptions) {
    this.defiLlama = opts.defiLlamaOracle;
    this.publicClient =
      opts.publicClient ??
      (createPublicClient({
        chain: celo,
        transport: http(opts.rpcUrl),
      }) as unknown as VaultReadClient);
  }

  /**
   * Returns the USD price of 1 share of `vaultAddress` at `blockNumber`.
   *
   * @param vaultAddress  ERC-4626 vault contract address
   * @param blockNumber   Celo block number (historical read supported)
   * @param timestamp     Event timestamp (Unix seconds) — used for the
   *                      underlying's USD price lookup
   * @returns price in USD per share, or `null` on any failure
   */
  async getSharePriceUsd(
    vaultAddress: Address,
    blockNumber: bigint,
    timestamp: Timestamp,
  ): Promise<number | null> {
    // 1. Read convertToAssets(1e18 shares) at the given block.
    let assetsOut: bigint;
    try {
      assetsOut = (await this.publicClient.readContract({
        address: vaultAddress,
        abi: ERC4626_CONVERT_TO_ASSETS_ABI,
        functionName: 'convertToAssets',
        args: [SHARES_UNIT],
        blockNumber,
      })) as bigint;
    } catch {
      return null;
    }

    // 2. Look up the underlying token's metadata.
    const underlying = VAULT_UNDERLYING_BY_ADDRESS[vaultAddress.toLowerCase()];
    if (!underlying) return null;

    // 3. Compute the share-to-underlying ratio.
    //    `assetsOut` is in the underlying's native units (decimals from
    //    the underlying token). Normalize by the underlying's unit.
    const underlyingUnit = 10n ** BigInt(underlying.decimals);
    const ratio = Number(assetsOut) / Number(underlyingUnit);
    if (ratio <= 0 || !Number.isFinite(ratio)) return null;

    // 4. Look up the underlying's USD price at the event timestamp.
    const point = await this.defiLlama.getHistoricalPrice(underlying.symbol, timestamp);
    if (!point) return null;

    return ratio * point.priceUsd;
  }
}
