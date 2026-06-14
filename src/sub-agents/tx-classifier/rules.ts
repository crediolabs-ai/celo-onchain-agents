/**
 * Rule table for the tx classifier.
 *
 * Owner: Tuan (tx-classifier sub-agent).
 * Each rule is a (id, matches, classify, confidence) tuple. The engine in
 * `./predicates.ts` evaluates them in order; first match wins.
 *
 * Conventions:
 *  - IDs: `<category>.<pattern>[@vN]` — append `@vN` on iteration for audit history.
 *  - Confidence reflects the rule's certainty, not the tx's certainty.
 *  - Jurisdiction: when set, rule only fires for those jurisdictions. Omit for global.
 *  - Notes are surfaced in the classifier audit trail and the LLM fallback prompt.
 *
 * v1 covers the high-value patterns from the architecture classification table.
 * Order matters: more specific rules first, fallthroughs last.
 */

import type { Rule } from './predicates.js';
import { evaluateRule } from './predicates.js';
import { YIELD_PROTOCOL_ADDRESSES } from '../../shared/yield-protocols.js';

export const RULES: readonly Rule[] = [
  // ─── YIELD FROM KNOWN PROTOCOL ─────────────────────────────────────────
  // Must run BEFORE the INCOME rule below so it wins. Quan 2026-06-14:
  // 0xBE19 wallet INs 5,374.90 USDC from 0x5b7ba647 (a yield protocol
  // the user deposited 5,000 USDC into on 2024-05-13). Without this
  // rule, the IN falls into the generic income bucket, mixing
  // principal-return with yield-income. With it, the engine routes
  // the gain (proceeds - cost basis) to interestEarned, separate
  // from regular income.
  //
  // v1 only handles one protocol. As we learn more yield-protocol
  // addresses from user testing, expand this rule's `matches.children`
  // to a disjunction of fromAddress checks (or migrate the set into
  // a proper alias once we have ≥3 entries).
  {
    id: 'yield.known_protocol_in@v1',
    description: 'IN from a known yield-protocol address — yield return (Quan fix 2026-06-14)',
    matches: {
      kind: 'allOf',
      children: [
        // Refactored 2026-06-14: use YIELD_PROTOCOL_ADDRESSES (DRY).
        // Covers the Karmen Mezz Pool and any future yield protocols.
        { kind: 'fromAddress', address: [...YIELD_PROTOCOL_ADDRESSES][0]! },
        { kind: 'tokenDirection', is: 'in' },
        { kind: 'tokenTransferCount', op: 'eq', value: 1 },
        { kind: 'isError', is: false },
      ],
    },
    classify: 'YIELD',
    confidence: 0.92,
    notes:
      'Yield-protocol registry: ' + [...YIELD_PROTOCOL_ADDRESSES].join(', ') + '. ' +
      'Extend YIELD_PROTOCOL_ADDRESSES in src/shared/yield-protocols.ts as more protocols are discovered.',
  },

  // ─── SELF-FUNDING FOR YIELD ────────────────────────────────────────────
  // Must run BEFORE the INCOME rule so it wins on the 0xBE19 funding tx.
  // When a wallet receives a stablecoin and immediately routes it to a known
  // yield-protocol address within the block window, that IN is cost-basis
  // funding (TRANSFER_IN), not employer compensation (INCOME).
  {
    id: 'transfer.self_funding_for_yield@v1',
    description:
      'Stablecoin IN immediately routed to a known yield-protocol — capital funding, not income',
    matches: {
      kind: 'allOf',
      children: [
        { kind: 'tokenSymbolIn', symbols: ['USDC', 'USDT', 'cUSD'] },
        { kind: 'tokenDirection', is: 'in' },
        { kind: 'tokenTransferCount', op: 'eq', value: 1 },
        { kind: 'isError', is: false },
        { kind: 'isInSelfFundingForYieldSet' },
      ],
    },
    classify: 'TRANSFER_IN',
    jurisdiction: ['NG', 'KE'],
    confidence: 0.9,
    notes:
      'Self-funding for a yield position: the stablecoin IN was routed to a ' +
      'known yield-protocol within the funding window. Pre-empts the income ' +
      'rule that would otherwise mis-classify self-funding as employer compensation.',
  },

  // ─── INCOME ────────────────────────────────────────────────────────────
  {
    id: 'income.stablecoin_in_no_native_out@v1',
    description: 'Stablecoin (USDC/cUSD) incoming with no native CELO out — payroll/salary pattern',
    matches: {
      kind: 'allOf',
      children: [
        { kind: 'tokenSymbolIn', symbols: ['USDC', 'cUSD', 'USDT'] },
        // Fix 2026-06-14 (Quan): use tokenDirection instead of
        // nativeDirection. Orphan token transfers (Quan yield
        // case 0xBE19 2024-12-14, 5,374.90 USDC IN from yield
        // protocol) have a synthesized raw tx with value=0, so
        // nativeDirection='none'. tokenDirection inspects the
        // actual transfer list and reports 'in' for "wallet
        // received a token".
        //
        // Restrict to exactly-1-transfer txs so Mento swaps (which
        // have a USDC OUT + cUSD IN) are not classified as
        // INCOME. The orphan yield-return has exactly 1 transfer.
        { kind: 'tokenDirection', is: 'in' },
        { kind: 'tokenTransferCount', op: 'eq', value: 1 },
        { kind: 'isError', is: false },
      ],
    },
    classify: 'INCOME',
    jurisdiction: ['NG', 'KE'],
    confidence: 0.75,
    notes:
      'Address-book match against employer list lifts confidence to 0.95 in v2. For hackathon, base rate is the pre-filter.',
  },

  // ─── SWAP ──────────────────────────────────────────────────────────────
  {
    id: 'swap.dex_multi_transfer@v1',
    description: 'DEX router with 2+ token transfers in one tx — standard swap shape',
    matches: {
      kind: 'allOf',
      children: [
        {
          kind: 'toIn',
          refs: [
            'UBESWAP_V2_ROUTER',
            'MENTO_BROKER',
            'MENTO_ROUTER',
          ],
        },
        { kind: 'tokenTransferCount', op: 'gt', value: 1 },
        { kind: 'isError', is: false },
      ],
    },
    classify: 'SWAP',
    confidence: 0.92,
    notes:
      'When UBESWAP_V2_ROUTER / MENTO_BROKER addresses are not yet populated in the registry, the rule is a no-op (returns false).',
  },

  // ─── TRANSFER (native CELO) ────────────────────────────────────────────
  {
    id: 'transfer.simple_native@v1',
    description: 'Plain native CELO transfer to an external EOA',
    matches: {
      kind: 'allOf',
      children: [
        { kind: 'tokenTransferCount', op: 'eq', value: 0 },
        { kind: 'nativeDirection', is: 'out' },
        { kind: 'valueGt', amount: '0' },
        { kind: 'isError', is: false },
        { kind: 'isContractCreation', is: false },
      ],
    },
    classify: 'TRANSFER_OUT',
    confidence: 0.98,
  },
  {
    id: 'transfer.simple_native_in@v1',
    description: 'Plain native CELO received from an external EOA',
    matches: {
      kind: 'allOf',
      children: [
        { kind: 'tokenTransferCount', op: 'eq', value: 0 },
        { kind: 'nativeDirection', is: 'in' },
        { kind: 'valueGt', amount: '0' },
        { kind: 'isError', is: false },
      ],
    },
    classify: 'TRANSFER_IN',
    confidence: 0.98,
  },

  // ─── TRANSFER (ERC-20-like) ───────────────────────────────────────────
  {
    id: 'transfer.simple_token@v1',
    description: 'Single ERC-20 transfer() call with no native movement',
    matches: {
      kind: 'allOf',
      children: [
        { kind: 'tokenTransferCount', op: 'eq', value: 1 },
        { kind: 'nativeDirection', is: 'none' },
        { kind: 'hasMethod', method: 'transfer' },
        { kind: 'isError', is: false },
      ],
    },
    classify: 'TRANSFER_OUT',
    confidence: 0.97,
  },
  {
    id: 'transfer.simple_token_in@v1',
    description: 'Single ERC-20 transfer received (no native movement, to == address)',
    matches: {
      kind: 'allOf',
      children: [
        { kind: 'tokenTransferCount', op: 'eq', value: 1 },
        { kind: 'nativeDirection', is: 'none' },
        { kind: 'isError', is: false },
      ],
    },
    classify: 'TRANSFER_IN',
    // Lower confidence — the "in" direction requires transfer.to == address,
    // which the predicate doesn't currently check. Keep <1 so the LLM fallback
    // can verify direction.
    confidence: 0.85,
    notes: 'v2: add a token-direction predicate (analogous to nativeDirection) to lift to 0.95.',
  },

  // ─── YIELD ─────────────────────────────────────────────────────────────
  {
    id: 'yield.small_periodic_staking@v1',
    description: 'Small periodic incoming from a known staking reward distributor',
    matches: {
      kind: 'allOf',
      children: [
        { kind: 'toIn', refs: ['STAKING_REWARD_DISTRIBUTOR'] },
        { kind: 'nativeDirection', is: 'in' },
        { kind: 'valueLt', amount: '1000000000000000000' }, // < 1 CELO
        { kind: 'isError', is: false },
      ],
    },
    classify: 'YIELD',
    confidence: 0.88,
    notes: 'Many small YIELD transfers will be aggregated via aggregatedFromHashes at the ClassifyOutput stage.',
  },

  // ─── GAS / self-send ───────────────────────────────────────────────────
  {
    id: 'gas.self_send@v1',
    description: 'Self-send (tx.from == tx.to == wallet, value > 0)',
    matches: {
      kind: 'allOf',
      children: [
        { kind: 'nativeDirection', is: 'self' },
        { kind: 'isError', is: false },
      ],
    },
    classify: 'GAS',
    confidence: 0.85,
    notes:
      'Common pattern when topping up a sub-account or recovering gas. Some self-sends are intentional transfers; LLM fallback handles ambiguity.',
  },

  // ─── FLAGS (manual review) ────────────────────────────────────────────
  {
    id: 'flag.mento_stability@v1',
    description: 'Mento stability protocol interaction — flag for manual review',
    matches: {
      kind: 'toIn',
      refs: ['MENTO_BROKER', 'MENTO_ROUTER'],
    },
    classify: 'MENTO_STABILITY',
    confidence: 0.8,
  },
  {
    id: 'flag.bridge@v1',
    description: 'Known cross-chain bridge — flag for cross-chain reconciliation',
    matches: {
      kind: 'toIn',
      refs: ['CELO_NATIVE_BRIDGE', 'PORTAL_BRIDGE'],
    },
    classify: 'BRIDGE',
    confidence: 0.85,
  },

  // ─── FALLBACK (must be last) ───────────────────────────────────────────
  //   The engine stops at the first match, so any rule after this one is dead.
  //   Keep fallback.last at the end of the array.
];

/** Find the first rule that matches the context. Returns null if none match. */
export function findMatchingRule(
  ctx: import('./predicates.js').PredicateContext,
): Rule | null {
  for (const rule of RULES) {
    if (evaluateRule(rule, ctx)) return rule;
  }
  return null;
}

// Re-export to avoid an extra import in callers.
