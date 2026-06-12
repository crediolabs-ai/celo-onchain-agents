/**
 * Tx classifier — main entrypoint.
 *
 * Owner: Tuan (tx-classifier sub-agent).
 *
 * Public surface: `classify(input: ClassifyInput): Promise<ClassifyOutput>`.
 *
 * Strategy: try declarative rules first (cheap, deterministic, audit-friendly);
 * fall back to the LLM only when no rule matched. Each un-classified tx is a
 * single LLM call. We cap LLM calls per report to keep cost bounded — once
 * the cap is hit, the remaining txs are emitted as `flagged` so a human can
 * triage them.
 *
 * Protocol-aware path (added 2026-06-11): when no rule matches, the
 * classifier consults `FetchedTxData.contractMetadata` (Celoscan
 * `getsourcecode` payloads) and `src/shared/protocol-registry.ts` to lift
 * named contracts from `flagged:UNKNOWN` to a category hint (DEX/VAULT/
 * LENDING/STABLE/YIELD/BRIDGE/STAKING). Txs with a contract name that has
 * no pattern match but is still recognized are emitted as `INTERACTION`
 * (note-only, not a new TxType) with the contract name in `notes`.
 *
 * Function-selector path (added 2026-06-11): when the protocol-aware path
 * did not produce a hit, the classifier inspects the tx's `input` calldata
 * and looks up the leading 4-byte selector in
 * `src/shared/selector-registry.ts`. Matched selectors lift the tx to a
 * category-specific INTERACTION / SWAP / BRIDGE / MINT / BURN type with
 * the function name in `notes`. Unmatched selectors with non-empty input
 * fall through to INTERACTION with the raw selector in `notes` (so the
 * user sees the unknown call site). This is the surgical change that
 * names Celo core protocol txs whose contracts are unverified (EAS,
 * Moola, TGE, proxy upgrades, etc.).
 *
 * Output: `ClassifyOutput` (see `src/shared/types.ts`) — the contract the
 * orchestrator and PNL agent consume.
 */

import {
  ClassifiedTxSchema,
  type ClassifiedTx,
  type ClassifyOutput,
  type FetchedTxData,
  type TokenTransfer,
  type Jurisdiction,
  type RawTx,
  type TxHash,
  type TxType,
} from '../../shared/types.js';
import { makeContractLookup, type Network, type ContractLookup } from '../../shared/contracts.js';
import {
  buildProtocolIndex,
  matchNameToCategory,
  type ProtocolCategory,
  type ProtocolEntry,
} from '../../shared/protocol-registry.js';
import {
  extractSelector,
  lookupSelector,
  type SelectorCategory,
} from '../../shared/selector-registry.js';
import { findMatchingRule } from './rules.js';
import { llmClassifyTx, type LlmFallbackDeps } from './llm-fallback.js';
import type { PredicateContext } from './predicates.js';
import { decodeProtocolAction, SELECTOR_MAP } from './protocol-decoder.js';
import { protocolActionToTxType } from './protocol-actions.js';

// ─── Public surface ────────────────────────────────────────────────────────

export interface ClassifyInput {
  fetched: FetchedTxData;
  jurisdiction?: Jurisdiction;
  /**
   * Active network for the contract registry. The fetcher returns data
   * from this network; the contract lookup must be built from the same
   * network so the `toIn` / `toIs` predicates resolve correctly.
   * Defaults to 'mainnet'.
   */
  network?: Network;
  /** LLM dependencies. Required only if any txs need the fallback. */
  llm?: LlmFallbackDeps;
  /**
   * Maximum number of LLM fallback calls per `classify()` invocation.
   * After the cap, unmatched txs are emitted as `flagged`. Default: 50.
   * Set to 0 to disable the LLM entirely (rule-only mode).
   */
  maxLlmCallsPerReport?: number;
  /**
   * Minimum rule confidence to accept the classification outright. Below
   * this, we still prefer the rule (it ran first), but we also set
   * `classifierSource: 'flagged'` so the audit trail shows the low
   * confidence. Default: 0.7. Use 0 to accept any rule hit.
   */
  minRuleConfidence?: number;
  /**
   * Minimum LLM confidence to accept a fallback classification. Below
   * this, the LLM result is re-marked as `flagged`. Default: 0.5.
   * (LLM threshold is intentionally lower than the rule threshold because
   * the LLM is the second-pass, lower-confidence signal.)
   */
  minLlmConfidence?: number;
}

export interface ClassifyDeps {
  /** Build a contract lookup for the active network. */
  makeLookup?: (network: Network) => ContractLookup;
  /** Override the LLM deps (production: real Anthropic client). */
  llm?: LlmFallbackDeps;
}

const DEFAULT_LLM_CAP = 50;
const DEFAULT_MIN_RULE_CONFIDENCE = 0.7;
const DEFAULT_MIN_LLM_CONFIDENCE = 0.5;

/** Convenience overload — `classify(fetched)` works without options. */
export async function classify(
  input: FetchedTxData,
  options: {
    jurisdiction?: Jurisdiction;
    network?: Network;
    llm?: LlmFallbackDeps;
  } = {},
): Promise<ClassifyOutput> {
  return classifyWithDeps(
    {
      fetched: input,
      ...(options.jurisdiction !== undefined && { jurisdiction: options.jurisdiction }),
      ...(options.network !== undefined && { network: options.network }),
      ...(options.llm !== undefined && { llm: options.llm }),
    },
    {},
  );
}

/**
 * Main entrypoint. Iterates fetched txs, runs the rule engine, falls back to
 * the LLM when needed, and assembles the audit trail.
 */
export async function classifyWithDeps(
  input: ClassifyInput,
  deps: ClassifyDeps = {},
): Promise<ClassifyOutput> {
  const {
    fetched,
    jurisdiction,
    network = 'mainnet',
    llm,
    maxLlmCallsPerReport = DEFAULT_LLM_CAP,
    minRuleConfidence = DEFAULT_MIN_RULE_CONFIDENCE,
    minLlmConfidence = DEFAULT_MIN_LLM_CONFIDENCE,
  } = input;
  const makeLookup = deps.makeLookup ?? makeContractLookup;
  // Build the contract lookup for the network the fetcher returned data from.
  // Mainnet addresses and testnet addresses are different worlds — using the
  // wrong network silently turns every contract-matching rule into a no-op.
  const knownContracts = makeLookup(network);

  // Pre-bucket transfers / internals by hash for O(1) lookup per tx.
  const transfersByHash = groupBy(fetched.tokenTransfers, (t) => t.hash);
  const internalByHash = groupBy(fetched.internalTxns, (t) => t.hash);

  // Per-address protocol hints from the fetcher's contract-metadata map.
  // Empty Map when the fetcher was run with `fetchContractMetadata: false`
  // (or in test fixtures that predate the metadata pass).
  const contractMetadata = fetched.contractMetadata ?? new Map();
  // Native-token index (CELO, cUSD, USDC, …) for token-address → name lookups.
  const protocolIndex = buildProtocolIndex();
  // Reverse index from contract name → entry, populated as we see new names.
  // The breakdown counter is keyed by canonical contract name.
  const interactionBreakdown: Record<string, number> = {};

  const classified: ClassifiedTx[] = [];
  const flaggedForReview: TxHash[] = [];
  let ruleHits = 0;
  let protocolDecoderHits = 0;
  let llmFallbacks = 0;
  let llmCallsRemaining = maxLlmCallsPerReport;

  for (const tx of fetched.rawTxns) {
    const ctx: PredicateContext = {
      tx,
      transfers: transfersByHash.get(tx.hash) ?? [],
      internal: internalByHash.get(tx.hash) ?? [],
      address: fetched.address,
      knownContracts,
      ...(jurisdiction !== undefined && { jurisdiction }),
    };

    // 1. Try the rule table.
    const rule = findMatchingRule(ctx);
    if (rule) {
      ruleHits += 1;
      const belowThreshold = rule.confidence < minRuleConfidence;
      const txOut: ClassifiedTx = {
        hash: tx.hash,
        type: rule.classify,
        timestamp: tx.timestamp,
        classifierSource: belowThreshold ? 'flagged' : 'rule',
        confidence: rule.confidence,
        ...(rule.notes && {
          notes: `${rule.notes} (rule: ${rule.id}@${rule.confidence.toFixed(2)})`,
        }),
      };
      classified.push(txOut);
      if (belowThreshold) flaggedForReview.push(tx.hash);
      continue;
    }

    // 2. No rule matched. Try the protocol-aware path using contract metadata
    //    + protocol-registry. This is the surgical change for Agent 06's
    //    161/194 "flagged" problem: a contract with a recognized name gets
    //    lifted from `flagged:UNKNOWN` to a named category.
    const protocolHit = lookupProtocol(tx, contractMetadata, protocolIndex);
    if (protocolHit) {
      const categoryType = categoryToTxType(protocolHit.category, ctx, protocolHit);
      if (categoryType !== null) {
        const txOut: ClassifiedTx = {
          hash: tx.hash,
          type: categoryType,
          timestamp: tx.timestamp,
          classifierSource: 'rule', // rule-derived; doesn't need LLM review
          confidence: 0.7, // baseline for protocol-name matches
          notes: `Protocol-aware: ${protocolHit.name} (${protocolHit.category})`,
        };
        classified.push(txOut);
        interactionBreakdown[protocolHit.name] =
          (interactionBreakdown[protocolHit.name] ?? 0) + 1;
        continue;
      }
      // Category matched but didn't produce a TxType (shouldn't happen with
      // current mapping) — fall through.
    }

    // 2.5. No protocol hit. Try the function-selector path: extract the
    //      leading 4-byte selector from `tx.input` and look it up in the
    //      selector-registry. Matched selectors lift the tx to a
    //      category-specific type; unmatched selectors with non-empty
    //      input fall through as INTERACTION with the raw selector in
    //      notes (so the user sees the unknown call site).
    //
    // Guard: if the selector is in the protocol-decoder's SELECTOR_MAP,
    // skip the selector-registry path so the decoder (step 2.7) can handle
    // it. This avoids the case where a selector in both maps (e.g.
    // 0x4e71d92d = GoodDollar claim) is captured by the generic
    // selector-registry path as INTERACTION before the specific
    // GOODDOLLAR:CLAIM_YIELD decoding can run.
    const selector = extractSelector(tx.input);
    if (!selector || !SELECTOR_MAP.has(selector)) {
      const selectorHit = classifyBySelector(tx, ctx);
      if (selectorHit) {
        classified.push(selectorHit.tx);
        interactionBreakdown[selectorHit.breakdownKey] =
          (interactionBreakdown[selectorHit.breakdownKey] ?? 0) + 1;
        continue;
      }
    }

    // 2.7. Protocol-decoder path (Agent 06 Phase A): decode protocol semantics
    //      from function selector + known router/broker addresses. This lifts
    //      vault deposits / Moola mints / GoodDollar claims from UNKNOWN to
    //      named actions. Complementary to the rule table — rule table fires
    //      first; decoder fires only when rule + protocol-name paths missed.
    const protocolDecoded = decodeProtocolAction(tx, ctx.transfers);
    if (protocolDecoded) {
      protocolDecoderHits += 1;
      const txType = protocolActionToTxType(protocolDecoded.protocol, protocolDecoded.action);
      const belowThreshold = protocolDecoded.confidence < minRuleConfidence;
      const txOut: ClassifiedTx = {
        hash: tx.hash,
        type: txType,
        timestamp: tx.timestamp,
        classifierSource: belowThreshold ? 'flagged' : 'rule-protocol',
        confidence: protocolDecoded.confidence,
        notes: `${protocolDecoded.protocol}:${protocolDecoded.action} (${protocolDecoded.functionName})`,
      };
      classified.push(txOut);
      if (belowThreshold) flaggedForReview.push(tx.hash);
      continue;
    }

    // 3. No rule and no protocol hit. Decide between LLM fallback and flag.
    if (llm && llmCallsRemaining > 0) {
      llmCallsRemaining -= 1;
      try {
        const llmOut = await llmClassifyTx(ctx, llm);
        llmFallbacks += 1;
        // Low LLM confidence → flag for human review too.
        if (typeof llmOut.confidence === 'number' && llmOut.confidence < minLlmConfidence) {
          llmOut.classifierSource = 'flagged';
          flaggedForReview.push(tx.hash);
        }
        classified.push(llmOut);
        continue;
      } catch (err) {
        // LLM call failed — flag the tx, do not re-throw (partial result is
        // more useful than a hard fail mid-report). The error is attached to
        // the tx's `notes` for the audit trail.
        flaggedForReview.push(tx.hash);
        classified.push(buildFlaggedTx(tx, formatError(err)));
        continue;
      }
    }

    // 4. Either LLM is disabled or the cap is hit — flag it.
    flaggedForReview.push(tx.hash);
    classified.push(
      buildFlaggedTx(
        tx,
        llm
          ? `LLM fallback cap (${maxLlmCallsPerReport}) reached`
          : 'No LLM deps provided; no rule matched',
      ),
    );
  }

  // Defensive: re-validate the full batch against the schema. The
  // ClassifiedTxSchema is the contract — if any item drifted, we want to
  // fail loudly at this seam, not silently downstream. The Zod output adds
  // `| undefined` on optional fields (incompatible with our interface under
  // `exactOptionalPropertyTypes: true`); cast through `unknown`.
  const validated: ClassifiedTx[] = classified.map(
    (c) => ClassifiedTxSchema.parse(c) as unknown as ClassifiedTx,
  );

  // Fill in assetIn/assetOut from the tx's token transfers for any
  // classified tx that didn't set them. The LLM path sets them from its
  // own response, but the rule path and protocol-decoder path (Agent 06
  // Phase A) historically emitted txs with no asset legs — leaving
  // downstream FIFO / LIFO / NL-query / CSV exporter reading
  // asset=UNKNOWN and amount=0, which collapsed every year summary to
  // $0.00 even when the classifier correctly identified income events.
  enrichClassifiedWithAssetLegs(validated, transfersByHash, fetched.address);

  return {
    classified: validated,
    flaggedForReview,
    ruleHits,
    protocolDecoderHits,
    llmFallbacks,
    interactionBreakdown,
  };
}

/**
 * For any classified tx missing assetIn/assetOut, derive them from the
 * matching token transfers on that hash. Mutates the array in place.
 *
 * Direction convention matches the rest of the pipeline:
 *   - `assetIn`  = token received (to == address). Used by YIELD, TRANSFER_IN,
 *                  and the buy-side of SWAP. Symbol + amount populated here;
 *                  `priceUsd` is 0 and filled in by the PNL price-enrichment
 *                  stage downstream.
 *   - `assetOut` = token sent (from == address). Used by TRANSFER_OUT and
 *                  the sell-side of SWAP.
 */
function enrichClassifiedWithAssetLegs(
  classified: readonly ClassifiedTx[],
  transfersByHash: ReadonlyMap<string, readonly TokenTransfer[]>,
  address: string,
): void {
  const addrLower = address.toLowerCase();
  for (const cls of classified) {
    const txTransfers = transfersByHash.get(cls.hash);
    if (!txTransfers || txTransfers.length === 0) continue;

    if (!cls.assetIn) {
      // Pick the LARGEST incoming transfer by base-unit value. GoodDollar
      // claim() txs, for example, fan out into multiple Transfer events
      // (intermediate path tokens + the actual G$ claim); the first one
      // alphabetically/by-hash is usually a small path token, not the
      // yield itself. Largest-by-value reliably picks the G$ over USDT-
      // and-cUSD-paths in the same tx.
      let incoming: TokenTransfer | undefined;
      for (const t of txTransfers) {
        if (t.to.toLowerCase() !== addrLower) continue;
        if (!incoming) { incoming = t; continue; }
        try {
          if (BigInt(t.value) > BigInt(incoming.value)) incoming = t;
        } catch { /* keep current on parse error */ }
      }
      if (incoming) {
        cls.assetIn = {
          symbol: incoming.tokenSymbol,
          // Preserve the raw base-unit (wei) integer string — downstream
          // PNL stages call `BigInt(amount)` and will throw on any decimal
          // point. Human-readable formatting happens at the CSV / display
          // edge, not here.
          amount: incoming.value,
          priceUsd: 0,
        };
      }
    }
    if (!cls.assetOut) {
      let outgoing: TokenTransfer | undefined;
      for (const t of txTransfers) {
        if (t.from.toLowerCase() !== addrLower) continue;
        if (!outgoing) { outgoing = t; continue; }
        try {
          if (BigInt(t.value) > BigInt(outgoing.value)) outgoing = t;
        } catch { /* keep current on parse error */ }
      }
      if (outgoing) {
        cls.assetOut = {
          symbol: outgoing.tokenSymbol,
          amount: outgoing.value,
          priceUsd: 0,
        };
      }
    }
  }
}

// Re-exports for callers that want to inspect the rule table or build their
// own predicate contexts.

// ─── Helpers ───────────────────────────────────────────────────────────────

function buildFlaggedTx(tx: RawTx, reason: string): ClassifiedTx {
  return {
    hash: tx.hash,
    type: 'UNKNOWN',
    timestamp: tx.timestamp,
    classifierSource: 'flagged',
    notes: `Flagged for review: ${reason}`,
  };
}

function formatError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function groupBy<T, K>(items: T[], key: (t: T) => K): Map<K, T[]> {
  const out = new Map<K, T[]>();
  for (const item of items) {
    const k = key(item);
    const bucket = out.get(k);
    if (bucket) bucket.push(item);
    else out.set(k, [item]);
  }
  return out;
}

/**
 * Resolve a tx to a protocol hint. The lookup order is:
 *
 *   1. Native token by `tx.to` address (CELO/cUSD/cEUR/cREAL/USDC/USDT).
 *   2. Native token by token-transfer `contractAddress`.
 *   3. Celoscan contract name → match against `namePatterns` in the
 *      protocol-registry. (Uses the to-address's metadata from the fetcher.)
 *
 * Returns `null` when nothing matched.
 */
function lookupProtocol(
  tx: RawTx,
  contractMetadata: ReadonlyMap<string, import('../../shared/types.js').ContractMetadata>,
  protocolIndex: ReadonlyMap<string, ProtocolEntry>,
): ProtocolEntry | { name: string; category: ProtocolCategory } | null {
  if (!tx.to) return null;
  const toKey = tx.to.toLowerCase();

  // 1. Celoscan metadata name first — it's the most specific signal. A
  //    contract like FiatTokenProxy has a more informative name than the
  //    canonical "USDC" we keep in `nativeTokens`.
  const meta = contractMetadata.get(toKey);
  if (meta && meta.name) {
    const category = matchNameToCategory(meta.name);
    if (category) {
      return { name: meta.name, category };
    }
    // Name known but no pattern matched — still useful for INTERACTION.
    return { name: meta.name, category: 'UNKNOWN' };
  }

  // 2. tx.to as a known native token contract (CELO, cUSD, USDC, etc.).
  const native = protocolIndex.get(toKey);
  if (native) return native;

  return null;
}

/**
 * Map a (ProtocolCategory, optional direction/context) pair to a TxType.
 * `null` return means "this category doesn't imply a classification here"
 * (e.g. UNKNOWN with no further signal) — the caller should fall through to
 * the LLM/flag path.
 */
function categoryToTxType(
  category: ProtocolCategory,
  ctx: PredicateContext,
  _hit: ProtocolEntry | { name: string; category: ProtocolCategory },
): TxType | null {
  switch (category) {
    case 'DEX':
      // DEX category: only classify as SWAP if there are token transfers
      // (both in and out). Otherwise the contract is just being touched.
      if (ctx.transfers.length >= 2) return 'SWAP';
      return null;

    case 'VAULT': {
      // VAULT requires at least one token transfer. Direction: more incoming
      // than outgoing → VAULT_SUPPLY uses the existing YIELD label; more
      // outgoing → TRANSFER_OUT. We keep it simple: any transfer with
      // the vault → INTERACTION so the breakdown counter ticks; the
      // downstream PNL engine handles cost basis.
      if (ctx.transfers.length > 0) return 'INTERACTION';
      return null;
    }

    case 'LENDING':
      // LENDING_DEPOSIT falls under the same family as YIELD; existing
      // engine treats both identically. Use YIELD for now.
      if (ctx.transfers.length > 0) return 'YIELD';
      return null;

    case 'YIELD':
      if (ctx.transfers.length > 0) return 'YIELD';
      return null;

    case 'STABLE':
      // Stablecoin broker (Mento): classify as SWAP if there are transfers.
      if (ctx.transfers.length >= 2) return 'SWAP';
      // Single transfer touching a known stable → TRANSFER (direction-agnostic;
      // the rule table's `transfer.simple_token*` would have caught it first).
      if (ctx.transfers.length === 1) return 'TRANSFER_IN';
      return null;

    case 'BRIDGE':
      return 'BRIDGE';

    case 'STAKING':
      // Celo epoch rewards hit the wallet as native CELO; existing rule
      // engine already covers this, but a name match is a strong signal.
      return 'INCOME';

    case 'NATIVE':
      // CELO native — not a meaningful classification on its own; rule
      // table handles native in/out.
      return null;

    case 'UNKNOWN':
    default:
      // We have a name but no category → INTERACTION is the "named
      // but uncategorized" type, so the report shows the contract name
      // instead of just "flagged".
      return 'INTERACTION';
  }
}

/**
 * Result of a function-selector lookup. The caller uses `tx` to push onto
 * the classified list and `breakdownKey` to increment the
 * `interactionBreakdown` counter. The breakdown key is the function
 * signature (e.g. "transfer(address,uint256)") — the user-facing signal.
 */
interface SelectorHit {
  tx: ClassifiedTx;
  breakdownKey: string;
}

/**
 * Try to classify a tx by its leading 4-byte function selector.
 *
 * Returns `null` when the input has no usable selector (empty calldata).
 * Returns a `SelectorHit` with a named INTERACTION/etc. type when the
 * selector matches a known signature, or an INTERACTION with the raw
 * selector hex in notes when the input has a selector but the registry
 * doesn't recognize it.
 *
 * Routing by `SelectorCategory`:
 *   - TRANSFER  → SWAP (2+ transfers) or TRANSFER_OUT
 *   - APPROVAL  → UNKNOWN (per spec; no dedicated TxType yet)
 *   - MINT      → MINT
 *   - BURN      → BURN
 *   - BRIDGE    → BRIDGE
 *   - everything else (DEPOSIT/WITHDRAW/STAKE/UNSTAKE/CLAIM/REWARD/
 *     VOTE/DELEGATE/ATTEST/UPGRADE/ADMIN/GOV_TX/DEPLOY) → INTERACTION
 *   - unmatched selector → INTERACTION with `0x... — unmatched` in notes
 */
function classifyBySelector(tx: RawTx, ctx: PredicateContext): SelectorHit | null {
  const selector = extractSelector(tx.input);
  if (!selector) return null; // empty calldata — not a function call

  const entry = lookupSelector(selector);
  if (!entry) {
    return {
      tx: {
        hash: tx.hash,
        type: 'INTERACTION',
        timestamp: tx.timestamp,
        classifierSource: 'rule',
        confidence: 0.6,
        notes: `Unmatched selector: ${selector}`,
      },
      breakdownKey: `unmatched:${selector}`,
    };
  }

  const type = selectorCategoryToTxType(entry.category, ctx);
  return {
    tx: {
      hash: tx.hash,
      type,
      timestamp: tx.timestamp,
      classifierSource: 'rule',
      confidence: 0.75,
      notes: `Function selector: ${entry.functionName}${
        entry.notes ? ` (${entry.notes})` : ''
      }`,
    },
    breakdownKey: entry.functionName,
  };
}

/**
 * Map a `SelectorCategory` to a `TxType`. Mirrors `categoryToTxType` for
 * the protocol-registry path but covers the selector-registry's wider
 * vocabulary. Returns `INTERACTION` for categories that are "named but
 * uncategorized" (DEPOSIT/WITHDRAW/STAKE/etc. — all surfaced via the
 * function name in `notes`).
 */
function selectorCategoryToTxType(
  category: SelectorCategory,
  ctx: PredicateContext,
): TxType {
  switch (category) {
    case 'TRANSFER':
      // 2+ transfers → swap-like; 1 transfer → out. The rule table
      // typically catches single ERC-20 transfers first; this is the
      // fallback for when it didn't (e.g. unusual fee-on-transfer or
      // non-standard token).
      return ctx.transfers.length >= 2 ? 'SWAP' : 'TRANSFER_OUT';
    case 'APPROVAL':
      // Per spec: keep UNKNOWN. No dedicated APPROVAL TxType yet.
      return 'UNKNOWN';
    case 'MINT':
      return 'MINT';
    case 'BURN':
      return 'BURN';
    case 'BRIDGE':
      return 'BRIDGE';
    // Everything else is "named but uncategorized" — surface the
    // function name in notes and use INTERACTION so the breakdown
    // counter ticks but no PNL-style classification is implied.
    case 'DEPOSIT':
    case 'WITHDRAW':
    case 'STAKE':
    case 'UNSTAKE':
    case 'CLAIM':
    case 'REWARD':
    case 'VOTE':
    case 'DELEGATE':
    case 'ATTEST':
    case 'UPGRADE':
    case 'ADMIN':
    case 'GOV_TX':
    case 'DEPLOY':
    case 'FALLBACK':
    default:
      return 'INTERACTION';
  }
}

// Re-exports for callers that want to inspect the rule table or build their
// own predicate contexts.
export { RULES, findMatchingRule } from './rules.js';
export { evaluatePredicate, evaluateRule } from './predicates.js';
export type { Predicate, Rule, PredicateContext } from './predicates.js';
export { llmClassifyTx, type LlmFallbackDeps } from './llm-fallback.js';
