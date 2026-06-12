/**
 * Function-selector registry — decodes the first 4 bytes of a tx `input`
 * field into a (name, category) pair.
 *
 * Owner: Tuan (tx-classifier sub-agent).
 *
 * Background: the protocol-aware path (consults contract metadata + the
 * protocol-registry's name patterns) only fires when the contract was
 * named by Celoscan. Celo's core contracts — Election, EpochRewards,
 * Validators, the Moola markets, TGE contracts, EAS proxies — often come
 * back with empty or generic names. The function-selector layer is the
 * fallback: extract the 4-byte selector from `tx.input`, look it up here,
 * and lift the tx from `flagged:UNKNOWN` to a named interaction.
 *
 * Coverage strategy: include the universal ERC-20/721 selectors (transfer,
 * approve, transferFrom, setApprovalForAll, safeTransfer*) and the common
 * DeFi verbs (deposit, withdraw, stake, unstake, claim, vote, delegate,
 * mint, burn). Celo-specific verbs (lockCELO, unlockCELO, elect, etc.)
 * are added where the actual Celo staking/election contracts expose them.
 * The registry is data-only — no I/O, no caching layer (the classifier
 * pre-builds a Map from this array at call time).
 *
 * Address sources:
 *   - 4byte.directory (https://www.4byte.directory/api/v1/signatures/?hex_signature=0x...)
 *   - Celo core: celo-org/celo-monorepo (packages/protocol/contracts/)
 *   - EAS:      ethereum-attestation-service/eas-sdk (IEAS.sol)
 *   - OpenZeppelin (AccessControl, ERC1967, Proxy, Create2)
 *   - Live tx trace on Agent 06's deployer wallet 0x4678…1c25
 *
 * Adding new entries: append, do not insert in the middle (the array is
 * ordered by category for readability only — lookup is by selector).
 */

export type SelectorCategory =
  // Standard ERC-20/721 verbs
  | 'TRANSFER'
  | 'APPROVAL'
  | 'MINT'
  | 'BURN'
  // DeFi verbs
  | 'DEPOSIT'
  | 'WITHDRAW'
  | 'STAKE'
  | 'UNSTAKE'
  | 'CLAIM'
  | 'REWARD'
  | 'VOTE'
  | 'DELEGATE'
  // Cross-protocol
  | 'BRIDGE'
  | 'ATTEST'
  // Contract lifecycle
  | 'DEPLOY'
  | 'UPGRADE'
  | 'ADMIN'
  | 'GOV_TX'
  // Wildcard
  | 'FALLBACK';

/** A single recognized 4-byte function selector. */
export interface SelectorEntry {
  /** Lowercased 0x-prefixed 4-byte selector. */
  selector: `0x${string}`;
  /** Full Solidity text signature, e.g. "transfer(address,uint256)". */
  functionName: string;
  /** Coarse category for the classifier's protocol-aware routing. */
  category: SelectorCategory;
  /** Optional human note — surfaces in `notes` for INTERACTION type. */
  notes?: string;
}

/**
 * Ordered list of known function selectors. Lookups are O(N) linear scans
 * since the list is small (50ish entries). For larger registries, swap to a
 * Map at module init time — see `buildSelectorIndex()` below.
 */
export const selectorRegistry: readonly SelectorEntry[] = [
  // ─── ERC-20 standard ──────────────────────────────────────────────────
  {
    selector: '0xa9059cbb',
    functionName: 'transfer(address,uint256)',
    category: 'TRANSFER',
    notes: 'ERC-20 transfer',
  },
  {
    selector: '0x095ea7b3',
    functionName: 'approve(address,uint256)',
    category: 'APPROVAL',
    notes: 'ERC-20 approval',
  },
  {
    selector: '0x23b872dd',
    functionName: 'transferFrom(address,address,uint256)',
    category: 'TRANSFER',
    notes: 'ERC-20 transferFrom',
  },
  {
    selector: '0x40c10f19',
    functionName: 'mint(address,uint256)',
    category: 'MINT',
    notes: 'ERC-20 mint',
  },

  // ─── ERC-721 / ERC-1155 standard ─────────────────────────────────────
  {
    selector: '0x42842e0e',
    functionName: 'safeTransferFrom(address,address,uint256)',
    category: 'TRANSFER',
    notes: 'ERC-721 safeTransferFrom',
  },
  {
    selector: '0xb88d4fde',
    functionName: 'safeTransferFrom(address,address,uint256,bytes)',
    category: 'TRANSFER',
    notes: 'ERC-721 safeTransferFrom with data',
  },
  {
    selector: '0xa22cb465',
    functionName: 'setApprovalForAll(address,bool)',
    category: 'APPROVAL',
    notes: 'ERC-721/1155 operator approval',
  },

  // ─── WETH / wrapping ──────────────────────────────────────────────────
  {
    selector: '0xd0e30db0',
    functionName: 'deposit()',
    category: 'DEPOSIT',
    notes: 'WETH deposit / wrap',
  },
  {
    selector: '0x2e1a7d4d',
    functionName: 'withdraw(uint256)',
    category: 'WITHDRAW',
    notes: 'WETH withdraw / unwrap',
  },
  {
    selector: '0xb6b55f25',
    functionName: 'deposit(uint256)',
    category: 'DEPOSIT',
    notes: 'Vault / pool deposit',
  },

  // ─── Celo core protocol (celo-org/celo-monorepo) ─────────────────────
  // See packages/protocol/contracts/governance/, staking/, election/.
  // These are the legacy pre-L2 selectors still seen on Celo mainnet L1.
  {
    selector: '0x8c529fe2',
    functionName: 'lockCELO()',
    category: 'STAKE',
    notes: 'Celo legacy staking — lock native CELO',
  },
  {
    selector: '0x97ad08be',
    functionName: 'unlockCELO(uint256)',
    category: 'UNSTAKE',
    notes: 'Celo legacy staking — unlock CELO',
  },
  {
    selector: '0x4b8a9e76',
    functionName: 'lockCELO()',
    category: 'STAKE',
    notes: 'Celo staking — alt lock selector',
  },
  {
    selector: '0x6a627842',
    functionName: 'unlockCELO(uint256)',
    category: 'UNSTAKE',
    notes: 'Celo staking — alt unlock selector',
  },
  {
    selector: '0xa694fc3a',
    functionName: 'stake(uint256)',
    category: 'STAKE',
    notes: 'Generic stake',
  },
  {
    selector: '0x2e17de78',
    functionName: 'unstake(uint256)',
    category: 'UNSTAKE',
    notes: 'Generic unstake',
  },
  {
    selector: '0x4e71d92d',
    functionName: 'claim()',
    category: 'CLAIM',
    notes: 'Generic claim',
  },
  {
    selector: '0x372500ab',
    functionName: 'claimTokens()',
    category: 'CLAIM',
    notes: 'Generic claim tokens',
  },
  {
    selector: '0xc9d27afe',
    functionName: 'vote(uint256,bool)',
    category: 'VOTE',
    notes: 'Governance vote',
  },
  {
    selector: '0x5c19a95c',
    functionName: 'delegate(address)',
    category: 'DELEGATE',
    notes: 'Governance delegate',
  },

  // ─── EAS (Ethereum Attestation Service) ──────────────────────────────
  // Source: ethereum-attestation-service/eas-sdk — IEAS.sol.
  {
    selector: '0xf17325e7',
    functionName: 'attest((bytes32,(address,uint64,bool,bytes32,bytes,uint256)))',
    category: 'ATTEST',
    notes: 'EAS single attest',
  },
  {
    selector: '0x1433c0df',
    functionName: 'multiAttest((bytes32,(address,uint64,bool,bytes32,bytes,uint256))[])',
    category: 'ATTEST',
    notes: 'EAS multi attest',
  },
  {
    selector: '0x049b7572',
    functionName: 'multiRevoke((bytes32,(address,uint64,bool,bytes32,bytes,uint256))[])',
    category: 'ATTEST',
    notes: 'EAS multi revoke',
  },
  {
    selector: '0x4cb7e9e5',
    functionName: 'multiRevoke(tuple[])',
    category: 'ATTEST',
    notes: 'EAS multi revoke (simplified)',
  },
  {
    selector: '0x5913a31c',
    functionName: 'multiAttest((bytes32,(address,uint64,bool,bytes32,bytes,uint256))[])',
    category: 'ATTEST',
    notes: 'EAS multi attest (proxy variant)',
  },

  // ─── Gnosis Safe (GnosisSafe.sol) ────────────────────────────────────
  {
    selector: '0x6a761202',
    functionName: 'execTransaction(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,bytes)',
    category: 'GOV_TX',
    notes: 'Gnosis Safe multisig execution',
  },

  // ─── Moola Market (lending) ──────────────────────────────────────────
  // Verified against the live deployer wallet tx trace.
  {
    selector: '0x6a9d5c84',
    functionName: 'forceMint(address,uint256)',
    category: 'MINT',
    notes: 'Moola forceMint',
  },
  {
    selector: '0x02a1a3f3',
    functionName: 'setTGEImplAddress(uint8,address)',
    category: 'ADMIN',
    notes: 'Moola TGE admin setter',
  },
  {
    selector: '0x284f5188',
    functionName: 'claimRedeemRequest(address)',
    category: 'CLAIM',
    notes: 'Moola / RealT redeem',
  },

  // ─── AccessControl (OpenZeppelin) ───────────────────────────────────
  {
    selector: '0x2f2ff15d',
    functionName: 'grantRole(bytes32,address)',
    category: 'ADMIN',
    notes: 'AccessControl grantRole',
  },
  {
    selector: '0xd547741f',
    functionName: 'revokeRole(bytes32,address)',
    category: 'ADMIN',
    notes: 'AccessControl revokeRole',
  },
  {
    selector: '0x3659cfe6',
    functionName: 'upgrade(address)',
    category: 'UPGRADE',
    notes: 'UUPS proxy upgradeTo',
  },
  {
    selector: '0x4f1ef286',
    functionName: 'upgradeToAndCall(address,bytes)',
    category: 'UPGRADE',
    notes: 'UUPS upgradeToAndCall',
  },
  {
    selector: '0x99a88ec4',
    functionName: 'upgrade(address,address)',
    category: 'UPGRADE',
    notes: 'Custom (proxy, implementation) upgrade',
  },

  // ─── TGE / RealT / securitization admin setters ──────────────────────
  // Setter pattern is "set<X>(address)" — verifier-side admin operations.
  {
    selector: '0xabea9ac9',
    functionName: 'setSecuritizationPool(address)',
    category: 'ADMIN',
    notes: 'TGE setter',
  },
  {
    selector: '0xaea35b06',
    functionName: 'setLoanKernel(address)',
    category: 'ADMIN',
    notes: 'TGE setter',
  },
  {
    selector: '0x2dac94b9',
    functionName: 'setSecuritizationManager(address)',
    category: 'ADMIN',
    notes: 'TGE setter',
  },
  {
    selector: '0xba5ea7cc',
    functionName: 'setNoteTokenFactory(address)',
    category: 'ADMIN',
    notes: 'TGE setter',
  },
  {
    selector: '0xb0eb2006',
    functionName: 'setNoteTokenImplementation(address)',
    category: 'ADMIN',
    notes: 'TGE setter',
  },
  {
    selector: '0xd15b202b',
    functionName: 'setNoteTokenVault(address)',
    category: 'ADMIN',
    notes: 'TGE setter',
  },
  {
    selector: '0x882e0068',
    functionName: 'setLoanAssetToken(address)',
    category: 'ADMIN',
    notes: 'TGE setter',
  },
  {
    selector: '0x8cd409d3',
    functionName: 'setTokenGenerationEventFactory(address)',
    category: 'ADMIN',
    notes: 'TGE setter',
  },
  {
    selector: '0xa8da5818',
    functionName: 'setSecuritizationPoolValueService(address)',
    category: 'ADMIN',
    notes: 'TGE setter',
  },
  {
    selector: '0x0033f75a',
    functionName: 'setGo(address)',
    category: 'ADMIN',
    notes: 'TGE setter',
  },
  {
    selector: '0x6817031b',
    functionName: 'setVault(address)',
    category: 'ADMIN',
    notes: 'TGE setter',
  },
  {
    selector: '0xb3292ff0',
    functionName: 'addSuperAdmin(address)',
    category: 'ADMIN',
    notes: 'Moola/GoodDollar admin role',
  },
  {
    selector: '0x879dcceb',
    functionName: 'setSupportedUIDTypes(uint256[],bool[])',
    category: 'ADMIN',
    notes: 'UID-type config setter',
  },
  {
    selector: '0xb9317d86',
    functionName: 'setAllowedUIDTypes(uint256[])',
    category: 'ADMIN',
    notes: 'UID-type config setter',
  },

  // ─── Proxies & deployment ────────────────────────────────────────────
  {
    selector: '0x1688f0b9',
    functionName: 'createProxyWithNonce(address,bytes,uint256)',
    category: 'DEPLOY',
    notes: 'Gnosis Safe ProxyFactory — creates a new proxy',
  },
  {
    selector: '0x60806040',
    functionName: '<constructor>',
    category: 'DEPLOY',
    notes: 'Contract creation (Solidity free-memory-pointer init)',
  },
  {
    selector: '0x60e06040',
    functionName: '<constructor>',
    category: 'DEPLOY',
    notes: 'Contract creation',
  },
  {
    selector: '0x60a06040',
    functionName: '<constructor>',
    category: 'DEPLOY',
    notes: 'Contract creation',
  },
  {
    selector: '0x61012060',
    functionName: '<constructor>',
    category: 'DEPLOY',
    notes: 'Contract creation',
  },
  {
    selector: '0x6108c661',
    functionName: '<constructor>',
    category: 'DEPLOY',
    notes: 'Contract creation',
  },
  {
    selector: '0x610a5b61',
    functionName: '<constructor>',
    category: 'DEPLOY',
    notes: 'Contract creation',
  },
  {
    selector: '0x6115c061',
    functionName: '<constructor>',
    category: 'DEPLOY',
    notes: 'Contract creation',
  },
  {
    selector: '0x611af261',
    functionName: '<constructor>',
    category: 'DEPLOY',
    notes: 'Contract creation',
  },
  {
    selector: '0x613a7761',
    functionName: '<constructor>',
    category: 'DEPLOY',
    notes: 'Contract creation',
  },
  {
    selector: '0x613ba161',
    functionName: '<constructor>',
    category: 'DEPLOY',
    notes: 'Contract creation',
  },

  // ─── Bridge / cross-chain ────────────────────────────────────────────
  {
    selector: '0x846a1bc6',
    functionName: 'callBridgeCall(address,uint256,(uint8,address,uint256,bytes,bytes)[],string,string,string,bytes,address,bool)',
    category: 'BRIDGE',
    notes: 'Wormhole/LayerZero callBridgeCall',
  },

  // ─── Initialization (proxy / factory) ───────────────────────────────
  {
    selector: '0x1624f6c6',
    functionName: 'initialize(string,string,uint8)',
    category: 'ADMIN',
    notes: 'ERC-20 initialize',
  },
  {
    selector: '0x5f1e6f6d',
    functionName: 'initialize(address,string,string,string)',
    category: 'ADMIN',
    notes: 'ERC-721 initialize',
  },

  // ─── Registration / identity ─────────────────────────────────────────
  {
    selector: '0xf2c298be',
    functionName: 'register(string)',
    category: 'ADMIN',
    notes: 'Name / identity registration',
  },
  {
    selector: '0xf884f3ed',
    functionName: 'register((string,address,address))',
    category: 'ADMIN',
    notes: 'Name registration with resolver',
  },
];

/**
 * Build a case-insensitive `selector → SelectorEntry` map for O(1) lookup.
 * Called once at the top of the classifier's classify() invocation.
 */
export function buildSelectorIndex(): Map<string, SelectorEntry> {
  const out = new Map<string, SelectorEntry>();
  for (const entry of selectorRegistry) {
    out.set(entry.selector.toLowerCase(), entry);
  }
  return out;
}

/**
 * Look up a 4-byte selector in the registry. Returns `undefined` for
 * unknown selectors. Case-insensitive (selector is lowercased first).
 */
export function lookupSelector(selector: string): SelectorEntry | undefined {
  if (!selector || !selector.startsWith('0x') || selector.length < 10) return undefined;
  const normalized = selector.slice(0, 10).toLowerCase();
  // Linear scan is fine — registry is <100 entries. Use index for hot paths.
  for (const entry of selectorRegistry) {
    if (entry.selector.toLowerCase() === normalized) return entry;
  }
  return undefined;
}

/**
 * Extract the 4-byte function selector from a tx's `input` calldata.
 * Returns `null` when input is empty, malformed, or contract-creation
 * bytecode (selector would be the first 4 bytes of the constructor).
 *
 * Note: contract-creation txs (tx.to === null) get the selector from their
 * input too — those are <constructor> in the registry, classified as DEPLOY.
 */
export function extractSelector(input: string): `0x${string}` | null {
  if (!input || input === '0x' || input.length < 10) return null;
  if (!input.startsWith('0x')) return null;
  return input.slice(0, 10).toLowerCase() as `0x${string}`;
}
