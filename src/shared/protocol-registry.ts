/**
 * Protocol registry — protocol-aware hints for the tx classifier.
 *
 * Owner: Tuan (tx-classifier sub-agent).
 *
 * The classifier's rule table (`src/sub-agents/tx-classifier/rules.ts`) only
 * fires on rule-based contract aliases (UBESWAP_V2_ROUTER, MENTO_BROKER, …)
 * registered in `src/shared/contracts.ts`. Real Celo wallets interact with
 * dozens of contracts per day — most aren't in that registry. To avoid
 * flagging every one as `UNKNOWN`, this file maps:
 *
 *   1. **Native Celo tokens** (CELO, cUSD, cEUR, cREAL, USDC, USDT) by address
 *      — recognized the moment we see their `contractAddress` in a transfer.
 *   2. **Name patterns** matched against the `ContractName` field returned by
 *      Celoscan `getsourcecode`. E.g. any contract whose name starts with
 *      "Mento" → `STABLE` category; any name matching `/Vault/i` → `VAULT`.
 *
 * The classifier's protocol-aware path consults both. When a tx `to` is not
 * a rule-based alias but its contract name matches a `namePatterns` entry, the
 * tx gets re-classified using the pattern's `category` as a hint.
 *
 * Address sources: Celo docs (docs.celo.org, docs.mento.org), Ubeswap docs,
 * Etherscan/Celoscan verifier for ERC-20 tokens, plus in-repo research notes
 * (see `src/sub-agents/tx-classifier/CONTRACT-RESEARCH-NOTES.md`).
 */

export type ProtocolCategory =
  | 'DEX'
  | 'LENDING'
  | 'VAULT'
  | 'STABLE'
  | 'BRIDGE'
  | 'STAKING'
  | 'YIELD'
  | 'NATIVE'
  | 'UNKNOWN';

/** A single recognized Celo contract — address → category lookup. */
export interface ProtocolEntry {
  /** Lowercased 0x-prefixed address. */
  address: `0x${string}`;
  /** Canonical display name, e.g. "Mento Broker". */
  name: string;
  category: ProtocolCategory;
  /** Celo mainnet chainId. Reserved for future multi-chain expansion. */
  chainId: 42220;
  notes?: string;
}

/** Pattern matched against a contract's `ContractName` field (case-insensitive). */
export interface NamePattern {
  pattern: RegExp;
  category: ProtocolCategory;
  /** Short description, surfaced in the classifier audit trail. */
  description: string;
}

/**
 * Name patterns used by the classifier's protocol-aware path. Order matters
 * only for tie-breaking readability — the engine matches all patterns and
 * picks the first hit. Keep specific patterns before generic catch-alls.
 */
export const namePatterns: readonly NamePattern[] = [
  { pattern: /^Mento/i, category: 'STABLE', description: 'Mento stablecoin broker' },
  { pattern: /^FiatTokenProxy|^FiatTokenV2_2/i, category: 'STABLE', description: 'USDC/USDT on Celo' },
  { pattern: /Ubeswap/i, category: 'DEX', description: 'Ubeswap DEX router' },
  { pattern: /Mobius/i, category: 'DEX', description: 'Mobius Money' },
  { pattern: /Curve/i, category: 'DEX', description: 'Curve on Celo' },
  { pattern: /GoodDollar|UBI|GoodReserve/i, category: 'YIELD', description: 'GoodDollar UBI' },
  { pattern: /Moola/i, category: 'LENDING', description: 'Moola Market' },
  { pattern: /Staking|CeloStaking|Election$/i, category: 'STAKING', description: 'Celo staking' },
  { pattern: /Bridge|Optics|Portal/i, category: 'BRIDGE', description: 'Bridge' },
  { pattern: /Vault|ERC-?4626/i, category: 'VAULT', description: 'ERC-4626 vault' },
];

/**
 * Native Celo tokens + bridged stables on Celo mainnet. Used by the
 * classifier as an authoritative name source for `to == address` token
 * transfers that the rule table doesn't explicitly cover.
 *
 * Addresses verified 2026-06-11 against Celo docs / Etherscan.
 */
export const nativeTokens: readonly ProtocolEntry[] = [
  {
    address: '0x471ece3750da237f93b8e339c536989b8978a438',
    name: 'CELO',
    category: 'NATIVE',
    chainId: 42220,
  },
  {
    address: '0x765de816845861e75a25fca122bb6898b8b1282a',
    name: 'cUSD',
    category: 'STABLE',
    chainId: 42220,
  },
  {
    address: '0xd8763cba276a3738e6de85b4b3bf5fded6d6ca73',
    name: 'cEUR',
    category: 'STABLE',
    chainId: 42220,
  },
  {
    address: '0xe8537a3d056da446677b9e9d6c5db704eaab4787',
    name: 'cREAL',
    category: 'STABLE',
    chainId: 42220,
  },
  {
    address: '0xcebA9300f2b948710d2653dD7B07f33A8B32118C'.toLowerCase() as `0x${string}`,
    name: 'USDC',
    category: 'STABLE',
    chainId: 42220,
  },
  {
    address: '0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e'.toLowerCase() as `0x${string}`,
    name: 'USDT',
    category: 'STABLE',
    chainId: 42220,
  },
];

/**
 * Build a fast case-insensitive `address → ProtocolEntry` map from
 * `nativeTokens`. O(N) for one-time use at classifier start.
 */
export function buildProtocolIndex(): Map<string, ProtocolEntry> {
  const out = new Map<string, ProtocolEntry>();
  for (const entry of nativeTokens) {
    out.set(entry.address.toLowerCase(), entry);
  }
  return out;
}

/**
 * Match a contract name (from Celoscan `getsourcecode`) against the pattern
 * table. Returns the first matching `ProtocolCategory`, or `null` if nothing
 * matched. Case-insensitive.
 */
export function matchNameToCategory(name: string): ProtocolCategory | null {
  if (!name) return null;
  for (const p of namePatterns) {
    if (p.pattern.test(name)) return p.category;
  }
  return null;
}
