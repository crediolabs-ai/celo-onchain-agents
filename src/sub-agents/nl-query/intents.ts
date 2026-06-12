/**
 * Structured-query intent vocabulary for the NL query interface.
 *
 * Owner: Tuan (nl-query sub-agent).
 *
 * The LLM is constrained to emit exactly one of these intents (plus a
 * short rationale). All execution is routed through this enum — the LLM
 * never produces code or free-form query strings. This is the safety
 * boundary that prevents prompt-injection from steering computation.
 *
 * The vocabulary is intentionally small and stable: 8 intents cover the
 * realistic user questions for a tax & portfolio agent. Adding a new
 * intent requires adding (1) a Zod arm here, (2) a tool-property in
 * `llm-translator.ts`, (3) an execution function in `execute.ts`, and
 * (4) a test in `tests/unit/nl-query.test.ts`.
 */

import { z } from 'zod';

// TxType mirror — the canonical enum lives in shared/types.ts as a TypeScript
// union. We re-declare the literal-constant list here to keep this module
// self-contained for the LLM tool definition (which needs the string[] for
// the JSON schema enum).
export const NL_TX_TYPES = [
  'INCOME',
  'SWAP',
  'TRANSFER_IN',
  'TRANSFER_OUT',
  'YIELD',
  'GAS',
  'MINT',
  'BURN',
  'BRIDGE',
  'MENTO_STABILITY',
  'UNKNOWN',
] as const;

export const NL_COST_METHODS = ['FIFO', 'LIFO', 'WAC'] as const;
export const NL_JURISDICTIONS = ['NG', 'KE', 'OTHER'] as const;
export const NL_AGGREGATIONS = ['sum', 'count', 'list'] as const;
export const NL_ASSET_KINDS = ['realized', 'unrealized', 'income', 'yield', 'all'] as const;
export const NL_TX_FILTER_SOURCES = ['rule', 'llm', 'flagged', 'any'] as const;

// ─── Zod schemas for each intent arm ──────────────────────────────────────
//
// All schemas use `.strict()` so unknown fields (e.g. LLM-injected
// `target: 'wallet'`) are rejected at parse time rather than silently
// stripped. Defense-in-depth on top of the discriminated-union discrimination.

const YearSummary = z
  .object({
    kind: z.literal('year_summary'),
    taxYear: z.number().int().min(2009).max(2100),
  })
  .strict();

const TxTypeBreakdown = z
  .object({
    kind: z.literal('tx_type_breakdown'),
    type: z.enum(NL_TX_TYPES),
    aggregation: z.enum(NL_AGGREGATIONS).default('sum'),
    taxYear: z.number().int().min(2009).max(2100).optional(),
  })
  .strict();

const AssetPnl = z
  .object({
    kind: z.literal('asset_pnl'),
    asset: z.string().min(1).max(16),
    metric: z.enum(NL_ASSET_KINDS),
  })
  .strict();

const JurisdictionCompat = z
  .object({
    kind: z.literal('jurisdiction_compat'),
    method: z.enum(NL_COST_METHODS),
    jurisdiction: z.enum(NL_JURISDICTIONS),
  })
  .strict();

const TopAssets = z
  .object({
    kind: z.literal('top_assets'),
    n: z.number().int().min(1).max(20),
    by: z.enum(['income', 'yield', 'realizedPnl']),
  })
  .strict();

const ListTransactions = z
  .object({
    kind: z.literal('list_transactions'),
    type: z.enum(NL_TX_TYPES).optional(),
    source: z.enum(NL_TX_FILTER_SOURCES).default('any'),
    taxYear: z.number().int().min(2009).max(2100).optional(),
    limit: z.number().int().min(1).max(200).default(20),
  })
  .strict();

const PriceGaps = z
  .object({
    kind: z.literal('price_gaps'),
    taxYear: z.number().int().min(2009).max(2100).optional(),
  })
  .strict();

const Unknown = z
  .object({
    kind: z.literal('unknown'),
  })
  .strict();

export const QueryIntentSchema = z.discriminatedUnion('kind', [
  YearSummary,
  TxTypeBreakdown,
  AssetPnl,
  JurisdictionCompat,
  TopAssets,
  ListTransactions,
  PriceGaps,
  Unknown,
]);

export type QueryIntent = z.infer<typeof QueryIntentSchema>;
export type QueryIntentKind = QueryIntent['kind'];

/** TxType union as a Zod enum — exported for other modules in this sub-agent. */
export const TxTypeSchema = z.enum(NL_TX_TYPES);
