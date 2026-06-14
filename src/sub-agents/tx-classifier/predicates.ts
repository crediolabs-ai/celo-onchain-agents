/**
 * Predicate DSL for the tx classifier.
 *
 * Owner: Tuan (tx-classifier sub-agent).
 * Source-of-truth: Celoscan RawTx + TokenTransfer + InternalTx shapes from
 * `src/shared/types.ts`. The rule table itself lives in `./rules.ts`.
 *
 * Design notes:
 *  - Predicates are pure: a function from PredicateContext → boolean.
 *  - Composition via `allOf` / `anyOf` / `not` only. No `and` / `or` aliases
 *    (one way to express each).
 *  - `knownContracts` is resolved at module init from `src/shared/contracts.ts`
 *    so the same code runs against any Celo network. `toIn(['UBESWAP_V2_ROUTER'])`
 *    returns false when the alias is not yet populated — that is the correct
 *    behaviour (rule simply doesn't match on that network).
 *  - The `Rule` type lives here so the engine, the rule table, and the
 *    LLM-fallback can all share one definition.
 */

import type {
  Address,
  InternalTx,
  Jurisdiction,
  RawTx,
  TokenTransfer,
  TxHash,
  TxType,
} from '../../shared/types.js';
import type { ContractLookup } from '../../shared/contracts.js';

// ─── Context ───────────────────────────────────────────────────────────────

export interface PredicateContext {
  /** The transaction being classified. */
  tx: RawTx;
  /** Token transfers with the same hash, joined from the fetcher. */
  transfers: TokenTransfer[];
  /** Internal transactions with the same hash, joined from the fetcher. */
  internal: InternalTx[];
  /** The wallet under analysis (the "from" or "to" being scanned). */
  address: Address;
  /** Resolved contract alias lookup for the active network. */
  knownContracts: ContractLookup;
  /** Optional jurisdiction hint — rules can filter on this. */
  jurisdiction?: Jurisdiction;
}

// ─── Predicate DSL ─────────────────────────────────────────────────────────

export type Predicate =
  // Composition
  | { kind: 'allOf'; children: Predicate[] }
  | { kind: 'anyOf'; children: Predicate[] }
  | { kind: 'not'; child: Predicate }
  // Calldata
  | { kind: 'hasMethod'; method: string }
  | { kind: 'hasMethodPrefix'; prefix: string }
  // Address matching (refs are ContractAlias names; resolved via knownContracts)
  | { kind: 'toIs'; ref: string }
  | { kind: 'fromIs'; ref: string }
  | { kind: 'toIn'; refs: string[] }
  /**
   * Literal-address match — case-insensitive EQUALS the `from` field of
   * the raw tx. Use this for one-off yield-protocol attributions
   * (`fromAddress: '0x5b7ba647...'` for the BE19 0xBE19 yield path)
   * without registering a full alias in the contract registry.
   */
  | { kind: 'fromAddress'; address: string }
  // Token transfer patterns
  | { kind: 'tokenSymbolIs'; symbol: string }
  | { kind: 'tokenSymbolIn'; symbols: string[] }
  | { kind: 'tokenTransferCount'; op: 'eq' | 'gt' | 'lt'; value: number }
  /**
   * Token transfer direction — counts the net direction of any transfers
   * in the same hash. `'in'` if any transfer is to the wallet, `'out'`
   * if any transfer is from the wallet, `'mixed'` if both directions
   * appear. Use this to attribute a stablecoin IN to income/yield even
   * when the raw tx's native value is 0 (orphan-token-transfer case
   * where the ERC-20 transfer is logged without a corresponding raw
   * tx from Celoscan's txlist endpoint).
   */
  | { kind: 'tokenDirection'; is: 'in' | 'out' | 'mixed' | 'none' }
  // Native CELO movement
  | { kind: 'nativeDirection'; is: 'in' | 'out' | 'self' | 'none' }
  | { kind: 'valueGt'; amount: string }
  | { kind: 'valueLt'; amount: string }
  // Transaction outcomes
  | { kind: 'isError'; is: boolean }
  | { kind: 'isContractCreation'; is: boolean };

// ─── Rule ──────────────────────────────────────────────────────────────────

export interface Rule {
  /** Stable identifier, e.g. `swap.dex_multi_transfer@v1`. Append `@vN` on iteration. */
  id: string;
  /** Human-readable description. Shown in classifier audit trail. */
  description: string;
  matches: Predicate;
  classify: TxType;
  /** When set, rule only applies in these jurisdictions. */
  jurisdiction?: Jurisdiction[];
  /** Base confidence when this rule hits, in [0, 1]. */
  confidence: number;
  notes?: string;
  /** Optional — surfaces this rule's pattern in the LLM fallback's prompt. */
  examples?: { hash: TxHash; reason: string }[];
}

// ─── Engine ────────────────────────────────────────────────────────────────

/** Evaluate a predicate against a context. Pure function. */
export function evaluatePredicate(p: Predicate, ctx: PredicateContext): boolean {
  switch (p.kind) {
    case 'allOf':
      return p.children.every((c) => evaluatePredicate(c, ctx));

    case 'anyOf':
      return p.children.some((c) => evaluatePredicate(c, ctx));

    case 'not':
      return !evaluatePredicate(p.child, ctx);

    case 'hasMethod':
      return ctx.tx.methodName === p.method;

    case 'hasMethodPrefix':
      return (ctx.tx.methodName ?? '').startsWith(p.prefix);

    case 'toIs':
      return matchAlias(ctx.tx.to, [p.ref], ctx.knownContracts);

    case 'fromIs':
      return matchAlias(ctx.tx.from, [p.ref], ctx.knownContracts);

    case 'fromAddress':
      // Case-insensitive equality. Use this for one-off yield-protocol
      // attributions without polluting the global alias registry.
      return ctx.tx.from.toLowerCase() === p.address.toLowerCase();

    case 'toIn':
      return matchAlias(ctx.tx.to, p.refs, ctx.knownContracts);

    case 'tokenSymbolIs':
      return ctx.transfers.some((t) => t.tokenSymbol === p.symbol);

    case 'tokenSymbolIn':
      return ctx.transfers.some((t) => p.symbols.includes(t.tokenSymbol));

    case 'tokenTransferCount': {
      const n = ctx.transfers.length;
      switch (p.op) {
        case 'eq': return n === p.value;
        case 'gt': return n > p.value;
        case 'lt': return n < p.value;
      }
    }

    case 'tokenDirection':
      return classifyTokenDirection(ctx) === p.is;

    case 'nativeDirection':
      return classifyNativeDirection(ctx) === p.is;

    case 'valueGt':
      return safeCompare(ctx.tx.value, p.amount) > 0;

    case 'valueLt':
      return safeCompare(ctx.tx.value, p.amount) < 0;

    case 'isError':
      return (ctx.tx.isError === '1') === p.is;

    case 'isContractCreation':
      return (ctx.tx.to === null) === p.is;
  }
}

/** Convenience wrapper. */
export function evaluateRule(rule: Rule, ctx: PredicateContext): boolean {
  // Jurisdiction filter — rules with no jurisdiction set apply everywhere.
  if (rule.jurisdiction && ctx.jurisdiction) {
    if (!rule.jurisdiction.includes(ctx.jurisdiction)) return false;
  }
  return evaluatePredicate(rule.matches, ctx);
}

// ─── Helpers ───────────────────────────────────────────────────────────────

/** Match a tx's address field against a list of contract aliases. */
function matchAlias(
  addr: Address | null,
  aliases: string[],
  lookup: ContractLookup,
): boolean {
  if (!addr) return false;
  const lower = addr.toLowerCase();
  for (const alias of aliases) {
    const resolved = lookup.resolve(alias as Parameters<typeof lookup.resolve>[0]);
    if (resolved && resolved.toLowerCase() === lower) return true;
  }
  return false;
}

/**
 * Classify the native CELO direction relative to the wallet under analysis.
 *  - `in`   : value came in to `address` (tx.to == address, value > 0)
 *  - `out`  : value went out from `address` (tx.from == address, value > 0)
 *  - `self` : self-send (tx.from == tx.to == address)
 *  - `none` : no native movement on this tx (e.g. token-only or zero-value)
 */
function classifyNativeDirection(
  ctx: PredicateContext,
): 'in' | 'out' | 'self' | 'none' {
  const fromMe = ctx.tx.from.toLowerCase() === ctx.address.toLowerCase();
  const toMe = ctx.tx.to?.toLowerCase() === ctx.address.toLowerCase();
  const hasValue = BigInt(ctx.tx.value) > 0n;
  if (!hasValue) return 'none';
  if (fromMe && toMe) return 'self';
  if (toMe) return 'in';
  if (fromMe) return 'out';
  return 'none';
}

/**
 * Token transfer direction — looks at the actual transfer list (NOT the
 * raw tx's native value). 'in' = the wallet received a token; 'out' =
 * the wallet sent a token; 'mixed' = both happened in the same tx
 * (e.g. a swap); 'none' = no transfers matched.
 *
 * This is the orphan-token-transfer case-fixer: when Etherscan V2
 * returns a token IN from a hash that's missing from txlist, the
 * synthesized raw tx has value=0, so `nativeDirection` would be 'none'.
 * `tokenDirection` correctly reads the transfer list and reports 'in'.
 */
function classifyTokenDirection(
  ctx: PredicateContext,
): 'in' | 'out' | 'mixed' | 'none' {
  const me = ctx.address.toLowerCase();
  let hasIn = false;
  let hasOut = false;
  for (const t of ctx.transfers) {
    if (t.to.toLowerCase() === me) hasIn = true;
    if (t.from.toLowerCase() === me) hasOut = true;
  }
  if (hasIn && hasOut) return 'mixed';
  if (hasIn) return 'in';
  if (hasOut) return 'out';
  return 'none';
}

/** Decimal-string big-int comparison without throwing on non-numeric. */
function safeCompare(a: string, b: string): -1 | 0 | 1 {
  try {
    const A = BigInt(a);
    const B = BigInt(b);
    if (A < B) return -1;
    if (A > B) return 1;
    return 0;
  } catch {
    return 0; // malformed → treat as equal
  }
}
