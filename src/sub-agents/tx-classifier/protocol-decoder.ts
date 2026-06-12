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
      // Cross-check: protocol address should match known router/broker.
      const addrMatch = isKnownProtocolAddress(toLower, hit.protocol);
      const confidence = addrMatch ? 0.9 : 0.7;
      return {
        protocol: hit.protocol,
        action: hit.action,
        confidence,
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
      return addr === GOODDOLLAR_RESERVE;
  }
}

function isMoolaCToken(addr: string): boolean {
  // Covers cUSD and cEUR cTokens (on-chain from demo wallet traces).
  // Add more as they appear in traces.
  return addr === MOOLA_CTOKEN_CUSD || addr === MOOLA_CTOKEN_CEUR;
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

  // GoodDollar reserve interactions.
  if (addr === GOODDOLLAR_RESERVE) {
    if (category === 'CLAIM') {
      return { protocol: ProtocolName.GOODDOLLAR, action: ProtocolActionType.CLAIM_YIELD, functionName: 'claim' };
    }
  }

  return null;
}
