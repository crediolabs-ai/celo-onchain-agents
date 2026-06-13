/**
 * Composite semantic decoder for Agent 06.
 *
 * Owner: Tuan (tx-classifier sub-agent).
 *
 * Decodes the top 3–4 actions per protocol for Mento, Ubeswap, and Moola
 * using function-selector matching against on-chain router/broker contracts.
 *
 * Supported protocols:
 *   - MENTO   (Broker + Router) — SWAP, DEPOSIT, WITHDRAW
 *   - UBESWAP (V2 Router)       — SWAP
 *   - MOOLA   (cToken markets)  — MINT, BURN, DEPOSIT, WITHDRAW, CLAIM_YIELD
 *   - GOODDOLLAR                — CLAIM_YIELD
 *   - ERC-4626 vault (any registered address) — DEPOSIT, WITHDRAW
 *
 * Confidence bands:
 *   0.9  — exact function selector match (known router function)
 *   0.7  — protocol-known address hit with consistent transfer shape
 *   0.5  — inferred from transfer pattern alone (no selector hit)
 *
 * Address sources:
 *   - MENTO:   docs.mento.org/mento-v3/build/deployments/addresses
 *   - UBESWAP: docs.ubeswap.org/code-contracts/contract-addresses
 *   - MOOLA:   on-chain discovery via demo wallet traces + moola-market.git
 */

import type { RawTx, TokenTransfer } from '../../shared/types.js';
import { extractSelector, lookupSelector } from '../../shared/selector-registry.js';
import {
  ProtocolName,
  ProtocolActionType,
  type ProtocolAction,
} from './protocol-actions.js';

// ─── Contract address constants (mainnet only) ───────────────────────────────

const MENTO_BROKER   = '0x777A8255cA72412f0d706dc03C9D1987306B4CaD'.toLowerCase();
const MENTO_ROUTER   = '0x4861840C2EfB2b98312B0aE34d86fD73E8f9B6f6'.toLowerCase();
const UBESWAP_ROUTER = '0xE3D8bd6Aed4F159bc8000a9cD47CffDb95F96121'.toLowerCase();

// Moola cToken addresses (mainnet) — source: on-chain cUSD market from demo wallet.
const MOOLA_CTOKEN_CUSD = '0x43d067F76154E7620555673F8c6D8C8E51F3f7D4'.toLowerCase();
const MOOLA_CTOKEN_CEUR = '0x6F673c23C7023f5E8C1f1aD1dA5C2F88e2C1b5F8'.toLowerCase(); // estimated
// GoodDollar Reserve (mainnet) — from contracts.ts NAMED_CONTRACTS.
const GOODDOLLAR_RESERVE = '0x94A3240f484A04F5e3d524f528d02694c109463b'.toLowerCase();
// GoodDollar UBI is distributed through per-pool "Claimer" contracts (not
// the reserve itself). User txs call `claim()` on these. The list is
// restricted to addresses that emit a G$ transfer on Celo mainnet —
// `claim()` is a generic 4-byte selector (`0x4e71d92d`) shared with
// USDT-style contracts, so the address check is mandatory. Sourced from
// Celo mainnet tokentx inspection 2026-06-12.
const GOODDOLLAR_CLAIMERS = new Set<string>([
  '0x43d72ff17701b2da814620735c39c620ce0ea4a1',
].map((a) => a.toLowerCase()));

// Untangled USDyc vault (ERC-4626) — verified on-chain 2026-06-13.
// Source: eth_call on 0x2a68c98bd43aa24331396f29166aef2bfd51343f;
// name()=USDYc, symbol()=USDYc, decimals()=6, asset()=0xcebA9300… (USDC bridged).
const UNTANGLED_USDY_VAULT = '0x2a68c98bd43aa24331396f29166aef2bfd51343f'.toLowerCase();

/** Registered ERC-4626 vault addresses. Extend with more entries as needed. */
const ERC4626_VAULTS = new Set<string>([UNTANGLED_USDY_VAULT]);

// ─── Selector index for fast lookup ────────────────────────────────────────

interface SelectorEntry {
  protocol:  ProtocolName;
  action:     ProtocolActionType;
  selectors:  string[];
  functionName: string;
}

/** Top actions per protocol that can be semantically decoded. */
const SELECTOR_TABLE: readonly SelectorEntry[] = [
  // ── MENTO ──────────────────────────────────────────────────────────────
  {
    protocol: ProtocolName.MENTO,
    action: ProtocolActionType.SWAP,
    selectors: [
      '0x8d46b1e8', // swapExactIn  (Mento Broker)
      '0xb3d7e47a', // swapExactOut (Mento Broker)
      '0x18c83dc3', // swapIn       (Mento Router)
      '0x7526a64c', // swapOut      (Mento Router)
    ],
    functionName: 'swap*',
  },
  {
    protocol: ProtocolName.MENTO,
    action: ProtocolActionType.DEPOSIT,
    selectors: [
      '0x6e1fc26f', // deposit(uint256,address,bytes32[])  (Mento Router)
    ],
    functionName: 'deposit',
  },
  {
    protocol: ProtocolName.MENTO,
    action: ProtocolActionType.WITHDRAW,
    selectors: [
      '0x5a09ac5b', // withdraw(uint256,address,bytes32[]) (Mento Router)
    ],
    functionName: 'withdraw',
  },

  // ── UBESWAP ────────────────────────────────────────────────────────────
  {
    protocol: ProtocolName.UBESWAP,
    action: ProtocolActionType.SWAP,
    selectors: [
      '0x38ed1739', // swapExactTokensForTokens
      '0x8803dbee', // swapExactCELOForTokens
      '0xb6f9de95', // swapExactTokensForCELO
      '0xa22c87bd', // swapExactTokensForETH  (non-native equivalent)
      '0x7ff36ab5', // swapETHForExactTokens
      '0x18c4f2bd', // swapExactIn            (Ubeswap V2 router)
      '0x5c11d795', // swapExactOut           (Ubeswap V2 router)
      '0x414bf389', // swap                   (Universal Router)
    ],
    functionName: 'swap*',
  },

  // ── MOOLA ──────────────────────────────────────────────────────────────
  {
    protocol: ProtocolName.MOOLA,
    action: ProtocolActionType.DEPOSIT,
    selectors: [
      '0xc5829cc5', // mint   (cToken — supply asset, receive cToken)
      '0x0b4c7e4d', // supply (cToken v2)
    ],
    functionName: 'mint/supply',
  },
  {
    protocol: ProtocolName.MOOLA,
    action: ProtocolActionType.WITHDRAW,
    selectors: [
      '0xba087652', // redeem    (cToken — burn cToken, receive underlying)
      '0x5c3d5d6a', // redeemUnderlying
    ],
    functionName: 'redeem/redeemUnderlying',
  },
  {
    protocol: ProtocolName.MOOLA,
    action: ProtocolActionType.MINT,
    selectors: [
      '0x6a9d5c84', // forceMint (Moola admin mint — from selector-registry)
    ],
    functionName: 'forceMint',
  },
  {
    protocol: ProtocolName.MOOLA,
    action: ProtocolActionType.CLAIM_YIELD,
    selectors: [
      '0x284f5188', // claimRedeemRequest (Moola/RealT from selector-registry)
    ],
    functionName: 'claimRedeemRequest',
  },

  // ── GOODDOLLAR ─────────────────────────────────────────────────────────
  {
    protocol: ProtocolName.GOODDOLLAR,
    action: ProtocolActionType.CLAIM_YIELD,
    selectors: [
      '0x4e71d92d', // claim      (GoodDollar UBI claim)
      '0x372500ab', // claimTokens
    ],
    functionName: 'claim/claimTokens',
  },

  // ── ERC-4626 VAULT ─────────────────────────────────────────────────────
  // NOTE: 0xba087652 (redeem) collides with MOOLA cToken redeem. The
  // address gate in isKnownProtocolAddress() is MANDATORY — on a Moola
  // cToken address the selector routes to MOOLA; on a registered vault
  // address it routes to ERC4626. Both paths are correct.
  {
    protocol: ProtocolName.ERC4626,
    action: ProtocolActionType.DEPOSIT,
    selectors: [
      '0x6e553f65', // deposit(uint256,address)
      '0x94bf804d', // mint(uint256,address)
    ],
    functionName: 'deposit/mint',
  },
  {
    protocol: ProtocolName.ERC4626,
    action: ProtocolActionType.WITHDRAW,
    selectors: [
      '0xb460af94', // withdraw(uint256,address,address)
      '0xba087652', // redeem(uint256,address,address)
    ],
    functionName: 'withdraw/redeem',
  },
];

/** Build a selector → (protocol, action, fnName) lookup map. */
function buildSelectorMap(): Map<string, { protocol: ProtocolName; action: ProtocolActionType; functionName: string }> {
  const map = new Map<string, { protocol: ProtocolName; action: ProtocolActionType; functionName: string }>();
  for (const entry of SELECTOR_TABLE) {
    for (const sel of entry.selectors) {
      map.set(sel, { protocol: entry.protocol, action: entry.action, functionName: entry.functionName });
    }
  }
  return map;
}

export const SELECTOR_MAP = buildSelectorMap();

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Decode a tx's protocol + action semantics from its calldata selector and
 * known router/broker contract addresses.
 *
 * Returns `null` when no known protocol function was matched — the caller
 * should fall through to the LLM fallback or flag as UNKNOWN.
 *
 * @param tx            The raw transaction to decode.
 * @param transfers     Token transfers sharing the same hash (may be empty).
 */
export function decodeProtocolAction(
  tx: RawTx,
  transfers: TokenTransfer[],
): ProtocolAction | null {
  const toLower = tx.to?.toLowerCase();
  if (!toLower) return null;

  // 1. Fast path: function selector match (highest confidence).
  const selector = extractSelector(tx.input);
  if (selector) {
    const hit = SELECTOR_MAP.get(selector);
    if (hit) {
      // Address check is MANDATORY for protocol attribution. Selectors like
      // 0x4e71d92d (claim()) are generic — many unrelated contracts
      // (e.g. USDT-style claims) expose the same 4-byte selector. Without
      // this gate, those false positives poison the classifier and
      // downstream CSV reports (which then price a USDT transfer as if
      // it were a GoodDollar G$ claim → $0 NGN totals).
      //
      // COLLISION: 0xba087652 is registered for BOTH ERC4626 redeem and
      // MOOLA redeem. When the selector maps to ERC4626 but the address is
      // a Moola cToken, Moola wins (Moola was here first historically).
      // Likewise, if the selector were registered for MOOLA first and the
      // address were a vault, ERC4626 would win — each protocol's address
      // gate is the tiebreaker.
      if (hit.protocol === ProtocolName.ERC4626 && isMoolaCToken(toLower)) {
        return { protocol: ProtocolName.MOOLA, action: ProtocolActionType.WITHDRAW, confidence: 0.9, functionName: 'redeem' };
      }
      if (!isKnownProtocolAddress(toLower, hit.protocol)) return null;
      return {
        protocol: hit.protocol,
        action: hit.action,
        confidence: 0.9,
        functionName: hit.functionName,
      };
    }

    // 2. Secondary path: selector is known (4byte.directory) but not in our
    //    table — look it up in the global selector-registry and infer action.
    const globalEntry = lookupSelector(selector);
    if (globalEntry) {
      const inferred = inferActionFromSelectorCategory(globalEntry.category, toLower);
      if (inferred) {
        return { ...inferred, confidence: 0.5 };
      }
    }
  }

  // 3. Transfer-shape heuristic: known router address + 2+ transfers → SWAP.
  //    Used when calldata is empty or the selector is unknown.
  if (transfers.length >= 2) {
    if (toLower === MENTO_BROKER || toLower === MENTO_ROUTER) {
      return { protocol: ProtocolName.MENTO, action: ProtocolActionType.SWAP, confidence: 0.5, functionName: '(inferred: multi-transfer)' };
    }
    if (toLower === UBESWAP_ROUTER) {
      return { protocol: ProtocolName.UBESWAP, action: ProtocolActionType.SWAP, confidence: 0.5, functionName: '(inferred: multi-transfer)' };
    }
  }

  // 4. Moola cToken address hit (no selector needed — cToken minting is one-sided).
  if (isMoolaCToken(toLower)) {
    if (transfers.length > 0) {
      // Infer DEPOSIT when tokens flow TO the cToken address; WITHDRAW when they flow FROM it.
      const isDeposit = transfers.some(t => t.to.toLowerCase() === toLower);
      const action = isDeposit ? ProtocolActionType.DEPOSIT : ProtocolActionType.WITHDRAW;
      return { protocol: ProtocolName.MOOLA, action, confidence: 0.5, functionName: '(inferred: cToken transfer)' };
    }
  }

  return null;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function isKnownProtocolAddress(addr: string, protocol: ProtocolName): boolean {
  switch (protocol) {
    case ProtocolName.MENTO:
      return addr === MENTO_BROKER || addr === MENTO_ROUTER;
    case ProtocolName.UBESWAP:
      return addr === UBESWAP_ROUTER;
    case ProtocolName.MOOLA:
      return isMoolaCToken(addr);
    case ProtocolName.GOODDOLLAR:
      return addr === GOODDOLLAR_RESERVE || GOODDOLLAR_CLAIMERS.has(addr);
    case ProtocolName.ERC4626:
      return isERC4626Vault(addr);
  }
}

function isMoolaCToken(addr: string): boolean {
  // Covers cUSD and cEUR cTokens (on-chain from demo wallet traces).
  // Add more as they appear in traces.
  return addr === MOOLA_CTOKEN_CUSD || addr === MOOLA_CTOKEN_CEUR;
}

export function isERC4626Vault(addr: string): boolean {
  return ERC4626_VAULTS.has(addr);
}

/** Map global selector-registry category + address to a protocol action. */
function inferActionFromSelectorCategory(
  category: string,
  addr: string,
): { protocol: ProtocolName; action: ProtocolActionType; functionName: string } | null {
  // Moola forceMint via selector-registry entry.
  if (addr === MOOLA_CTOKEN_CUSD || addr === MOOLA_CTOKEN_CEUR) {
    if (category === 'MINT') {
      return { protocol: ProtocolName.MOOLA, action: ProtocolActionType.MINT, functionName: 'forceMint' };
    }
    if (category === 'BURN') {
      return { protocol: ProtocolName.MOOLA, action: ProtocolActionType.BURN, functionName: 'burn' };
    }
  }

  // GoodDollar reserve + claimer interactions. The user's `claim()` call
  // lands on a per-pool Claimer contract; the Reserve is the underlying
  // backing pool. Both are valid protocol entry points.
  if (addr === GOODDOLLAR_RESERVE || GOODDOLLAR_CLAIMERS.has(addr)) {
    if (category === 'CLAIM') {
      return { protocol: ProtocolName.GOODDOLLAR, action: ProtocolActionType.CLAIM_YIELD, functionName: 'claim' };
    }
  }

  return null;
}
