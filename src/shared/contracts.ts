/**
 * Registry of named Celo contracts.
 *
 * OWNER: Credio (build side)
 * CONSUMERS:
 *   - tx-classifier (Tuan) — for `toIn` / `fromIs` predicate resolution
 *   - tx-fetcher (Credio) — for internal-txn decoding
 *   - orchestrator (Credio) — for the demo script's address resolution
 *
 * Each named contract is keyed by an alias and exists on both Celo mainnet and
 * Alfajores testnet (or marked `null` if the testnet counterpart is unavailable).
 * The lookup is network-aware so the same code runs against either network.
 *
 * Address sources (verified 2026-06-10):
 *   - Ubeswap:      https://docs.ubeswap.org/code-contracts/contract-addresses
 *   - Mento:        https://docs.mento.org/mento-v3/build/deployments/addresses
 *   - Wormhole:     https://wormhole.com/docs/products/reference/contract-addresses
 *   - GoodDollar:   https://docs.gooddollar.org/for-developers/core-contracts
 *
 * Still TODO (no canonical address found yet — see CONTRACT-RESEARCH-NOTES.md):
 *   - STAKING_REWARD_DISTRIBUTOR (Celo validator-group epoch rewards)
 *   - CELO_NATIVE_BRIDGE (pre-Plume Optics, deprecated after L2 migration)
 *   - CELO_REGISTRY (on-chain validators/accounts registry)
 *   - All Alfajores testnet addresses (docs only list mainnet + Celo Sepolia)
 *
 *   For the hackathon, demo should run on Celo Sepolia (post-L2) or mainnet
 *   (post-hackathon). Alfajores is the pre-L2 testnet — addresses may need
 *   to be re-deployed.
 */

import { celo, celoAlfajores } from 'viem/chains';
import type { Address } from './types.js';

export type Network = 'alfajores' | 'mainnet';

/** Aliases for known Celo contracts. Referenced by the classifier's `toIn` predicate. */
export type ContractAlias =
  | 'UBESWAP_V2_ROUTER'
  | 'MENTO_BROKER'
  | 'MENTO_ROUTER'
  | 'STAKING_REWARD_DISTRIBUTOR'
  | 'CELO_NATIVE_BRIDGE'
  | 'PORTAL_BRIDGE'
  | 'GOOD_DOLLAR_RESERVE'
  | 'CELO_REGISTRY'
  | 'UNTANGLED_USDY_VAULT';

export interface NamedContract {
  alias: ContractAlias;
  description: string;
  addresses: Record<Network, Address | null>;
  /** Optional: where the address was sourced from (URL or "monorepo:symbol"). */
  source?: string;
}

/**
 * Native Celo token addresses on Celo mainnet (chainId 42220). Sourced from
 * celo-chain-data.md / Etherscan and verified 2026-06-11. Re-exported as
 * constants for the protocol-registry + test fixtures.
 *
 * Note: `USDC_BRIDGED` is the canonical bridged USDC.e on Celo (the address
 * also matches the `namePatterns` `FiatTokenProxy` match in
 * `src/shared/protocol-registry.ts`).
 */
export const CELO_NATIVE = '0x471EcE3750Da237f93B8E339c536989b8978a438';
export const CUSD_MENTO = '0x765DE816845861e75A25fCA122bb6898B8B1282a';
export const CEUR_MENTO = '0xD8763CBa276a3738E6DE85b4b3bF5FDed6D6cA73';
export const CREAL_MENTO = '0xe8537a3d056DA446677B9E9d6c5dB704EaAb4787';
export const USDC_BRIDGED = '0xcebA9300f2b948710d2653dD7B07f33A8B32118C';
export const USDT_BRIDGED = '0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e';

/**
 * All native Celo token addresses as a set, lowercased. Used by the
 * protocol-registry to recognize a token's `contractAddress` in a transfer
 * without going through the rule table. The set is the union of
 * `CELO_NATIVE`, `CUSD_MENTO`, `CEUR_MENTO`, `CREAL_MENTO`, `USDC_BRIDGED`,
 * and `USDT_BRIDGED`.
 */
export const CELO_NATIVE_TOKENS: ReadonlySet<string> = new Set(
  [CELO_NATIVE, CUSD_MENTO, CEUR_MENTO, CREAL_MENTO, USDC_BRIDGED, USDT_BRIDGED].map((a) =>
    a.toLowerCase(),
  ),
);

/** Default named-contract registry. Mainnet addresses populated 2026-06-10. */
export const NAMED_CONTRACTS: readonly NamedContract[] = [
  {
    alias: 'UBESWAP_V2_ROUTER',
    description: 'Ubeswap V2 router (Celo main DEX). Swap routing contract.',
    source: 'https://docs.ubeswap.org/code-contracts/contract-addresses',
    addresses: {
      alfajores: null, // No Alfajores address published; hackathon runs on Sepolia/mainnet
      mainnet: '0xE3D8bd6Aed4F159bc8000a9cD47CffDb95F96121',
    },
  },
  {
    alias: 'MENTO_BROKER',
    description: 'Mento Broker v2 — Celo stability protocol swap broker.',
    source: 'https://docs.mento.org/mento-v3/build/deployments/addresses',
    addresses: {
      alfajores: null,
      mainnet: '0x777A8255cA72412f0d706dc03C9D1987306B4CaD',
    },
  },
  {
    alias: 'MENTO_ROUTER',
    description: 'Mento Router v3 — entry point for Mento integrations.',
    source: 'https://docs.mento.org/mento-v3/build/deployments/addresses',
    addresses: {
      alfajores: null,
      mainnet: '0x4861840C2EfB2b98312B0aE34d86fD73E8f9B6f6',
    },
  },
  {
    alias: 'STAKING_REWARD_DISTRIBUTOR',
    description:
      'Celo validator-group epoch rewards distributor. TODO: no canonical ' +
      'address published. Affects yield.small_periodic_staking@v1 (no-op today).',
    addresses: {
      alfajores: null,
      mainnet: null,
    },
  },
  {
    alias: 'CELO_NATIVE_BRIDGE',
    description:
      'Celo ↔ Ethereum Optics bridge (pre-Plume/L2 migration). Deprecated ' +
      'after 2024 L2 migration; mainnet address no longer canonical.',
    addresses: {
      alfajores: null,
      mainnet: null,
    },
  },
  {
    alias: 'PORTAL_BRIDGE',
    description: 'Wormhole Portal token bridge on Celo (TokenBridge contract).',
    source: 'https://wormhole.com/docs/products/reference/contract-addresses',
    addresses: {
      alfajores: null,
      mainnet: '0x796Dff6D74F3E27060B71255Fe517BFb23C93eed',
    },
  },
  {
    alias: 'GOOD_DOLLAR_RESERVE',
    description:
      'GoodDollar V4 MentoReserve (G$ UBI backing reserve on Celo).',
    source: 'https://docs.gooddollar.org/for-developers/core-contracts',
    addresses: {
      alfajores: null,
      mainnet: '0x94A3240f484A04F5e3d524f528d02694c109463b',
    },
  },
  {
    alias: 'CELO_REGISTRY',
    description: 'Celo core registry (validators, accounts). TODO: address TBD.',
    addresses: {
      alfajores: null,
      mainnet: null,
    },
  },
  {
    alias: 'UNTANGLED_USDY_VAULT',
    description: 'Untangled USDy — ERC-4626 vault wrapping USDC on Celo mainnet.',
    source: 'verified on-chain 2026-06-12 via eth_call on 0x2a68…1343f; name=USDy symbol=USDy decimals=6 asset()=0xcebA9300…',
    addresses: {
      alfajores: null,
      mainnet: '0x2a68c98bd43aa24331396f29166aef2bfd51343f',
    },
  },
];

/**
 * Lookup interface consumed by the classifier's PredicateContext.
 * Resolves a contract alias → Address for the active network, or returns
 * `undefined` if the address is not yet populated.
 */
export interface ContractLookup {
  resolve(alias: ContractAlias): Address | undefined;
  /** True when this alias has an address registered for the given network. */
  has(alias: ContractAlias, network?: Network): boolean;
  /** All aliases known (regardless of network). */
  aliases(): ContractAlias[];
  /**
   * True when `address` is one of the well-known Celo native token contracts
   * (CELO, cUSD, cEUR, cREAL, USDC, USDT). Used by the protocol-aware
   * classifier path to recognize a token contract without going through the
   * rule table. Case-insensitive.
   */
  isNativeToken(address: string): boolean;
}

class ContractRegistry implements ContractLookup {
  constructor(private readonly network: Network) {}

  private contractFor(alias: ContractAlias): NamedContract | undefined {
    return NAMED_CONTRACTS.find((c) => c.alias === alias);
  }

  resolve(alias: ContractAlias): Address | undefined {
    const c = this.contractFor(alias);
    if (!c) return undefined;
    const addr = c.addresses[this.network];
    return addr ?? undefined;
  }

  has(alias: ContractAlias, network: Network = this.network): boolean {
    return Boolean(this.contractFor(alias)?.addresses[network]);
  }

  aliases(): ContractAlias[] {
    return NAMED_CONTRACTS.map((c) => c.alias);
  }

  isNativeToken(address: string): boolean {
    return CELO_NATIVE_TOKENS.has(address.toLowerCase());
  }
}

/** Build a contract lookup for the given network. */
export function makeContractLookup(network: Network): ContractLookup {
  return new ContractRegistry(network);
}

/** Convenience: build a lookup for the active viem chain. */
export function makeContractLookupForChain(chainId: number): ContractLookup {
  if (chainId === celoAlfajores.id) return makeContractLookup('alfajores');
  if (chainId === celo.id) return makeContractLookup('mainnet');
  throw new Error(`makeContractLookupForChain: unknown chainId ${chainId}`);
}
