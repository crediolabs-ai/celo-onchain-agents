/**
 * Shared types — the cross-agent interface contract for Agent 06.
 *
 * Every sub-agent imports from this file. No cross-imports between sub-agents.
 * This is the source of truth; if you need a new field, add it here first and
 * update both producers and consumers.
 *
 * Approved additions from Tuan on 2026-06-08:
 *  1. ClassifiedTx.confidence?                  (LLM confidence, 0–1)
 *  2. ClassifiedTx.aggregatedFromHashes?        (YIELD/INCOME grouping)
 *  3. FetchedTxData.fetchErrors                 (partial-failure reporting)
 *  4. TaxYearSummary.taxableIncome TSDoc        (formula documentation)
 *  5. PnlOutput.methodJurisdictionCompat[]      (illegal-combo flagging)
 */

import { z } from 'zod';

// ─── Primitives ─────────────────────────────────────────────────────────────

/** EIP-55 checksummed 0x-prefixed EVM address (20 bytes). */
export type Address = `0x${string}`;

/** 0x-prefixed 32-byte transaction hash. */
export type TxHash = `0x${string}`;

/** Unix timestamp in seconds. */
export type Timestamp = number;

/** Transaction type — see architecture.md classification table. */
export type TxType =
  | 'INCOME'
  | 'SWAP'
  | 'TRANSFER_IN'
  | 'TRANSFER_OUT'
  | 'YIELD'
  | 'GAS'
  | 'MINT'
  | 'BURN'
  | 'BRIDGE'
  | 'MENTO_STABILITY'
  /** Protocol-aware classification: contract was named but no category matched.
   *  Surfaces in `notes` with the contract name; counts as classified, not flagged. */
  | 'INTERACTION'
  | 'UNKNOWN';

/** Cost basis methods supported. */
export type CostBasisMethod = 'FIFO' | 'LIFO' | 'WAC';

/** Supported tax jurisdictions. */
export type Jurisdiction = 'NG' | 'KE' | 'OTHER';

// ─── Celoscan raw shapes (1:1 with API responses, names preserved) ─────────

export interface RawTx {
  hash: TxHash;
  blockNumber: number;
  timestamp: Timestamp;
  from: Address;
  to: Address | null;
  /** Wei as decimal string. */
  value: string;
  gasUsed: string;
  gasPrice: string;
  /** Calldata hex (no 0x prefix in some Celoscan responses — coerce upstream). */
  input: string;
  /** Celoscan's decoded method name when available. */
  methodName?: string;
  isError: '0' | '1';
}

export interface TokenTransfer {
  hash: TxHash;
  blockNumber: number;
  timestamp: Timestamp;
  from: Address;
  to: Address;
  contractAddress: Address;
  tokenSymbol: string;
  tokenDecimals: number;
  /** Raw amount in token units, decimal string. */
  value: string;
}

export interface InternalTx {
  hash: TxHash;
  blockNumber: number;
  timestamp: Timestamp;
  from: Address;
  to: Address;
  value: string;
  callType: 'call' | 'delegatecall' | 'staticcall' | 'create';
}

// ─── Sub-agent I/O ──────────────────────────────────────────────────────────

/** Tx Fetcher → Classifier (and all downstream agents). */
/**
 * Celoscan `getsourcecode` payload for one address. The classifier uses the
 * `name` field to detect protocol-category hints (Mento, Moola, Vault, etc.)
 * when no rule-based contract alias matched.
 */
export interface ContractMetadata {
  name: string;
  /** True when Celoscan reports Proxy in the source name (e.g. "FiatTokenProxy"). */
  isProxy: boolean;
  /** Implementation address for proxies; null when not a proxy. */
  impl: Address | null;
  /** ISO date the contract was verified by Celoscan, when reported. */
  verifiedAt: string;
}

export interface FetchedTxData {
  address: Address;
  dateRange: { from: Timestamp; to: Timestamp };
  rawTxns: RawTx[];
  tokenTransfers: TokenTransfer[];
  internalTxns: InternalTx[];
  source: 'celoscan';
  fetchedAt: Timestamp;
  /** False when more pages exist but were not fetched (rate-limited, time-budgeted, etc.). */
  paginationComplete: boolean;
  /**
   * Per-tx fetch failures, empty in the happy path. Lets the orchestrator
   * surface partial failures honestly rather than silently skip.
   * Addition #3 (Tuan, 2026-06-08).
   */
  fetchErrors: { hash: TxHash; reason: string }[];
  /**
   * Per-contract-name lookup populated from Celoscan `getsourcecode`. The
   * classifier consults this when a rule-based contract alias did not match,
   * to lift an interaction from `flagged:UNKNOWN` to a named category.
   * Optional for backward compat — older fixtures/tests supply an empty Map.
   */
  contractMetadata: Map<Address, ContractMetadata>;
}

/** Asset leg of a classified transaction. */
export interface AssetLeg {
  symbol: string;
  /** Decimal string — preserve full precision, format at the edge. */
  amount: string;
  priceUsd: number;
}

/** Classifier → PNL. */
export interface ClassifiedTx {
  hash: TxHash;
  type: TxType;
  timestamp: Timestamp;
  assetIn?: AssetLeg;
  assetOut?: AssetLeg;
  classifierSource: 'rule' | 'rule-protocol' | 'llm' | 'flagged';
  /**
   * LLM confidence in [0, 1]. Only meaningful when classifierSource === 'llm'.
   * Addition #1 (Tuan, 2026-06-08).
   */
  confidence?: number;
  /**
   * For YIELD/INCOME types where one logical event spans many on-chain transfers
   * (e.g., 30 daily staking rewards). PNL must aggregate these to avoid
   * double-counting or skipping. Addition #2 (Tuan, 2026-06-08).
   */
  aggregatedFromHashes?: TxHash[];
  notes?: string;
}

export interface ClassifyOutput {
  classified: ClassifiedTx[];
  flaggedForReview: TxHash[];
  ruleHits: number;
  /** Count of txs classified by the protocol-decoder (rule-protocol path). Added 2026-06-12. */
  protocolDecoderHits: number;
  llmFallbacks: number;
  /**
   * Per-protocol-name count of classified txs (e.g. `{ "Mento Broker": 40,
   * "Vault": 12, "Staking": 5, "Unknown": 30 }`). Populated only when
   * `FetchedTxData.contractMetadata` is non-empty. Empty object otherwise.
   * Added 2026-06-11 as part of the protocol-aware classification pass.
   */
  interactionBreakdown: Record<string, number>;
}

/** PNL input. */
export interface PnlInput {
  address: Address;
  classified: ClassifiedTx[];
  method: CostBasisMethod;
  taxYear: number;
}

/**
 * Per-tax-year summary.
 *
 * `taxableIncome` semantics: `= income + realizedGains - deductibleGas`.
 * NG FIRS and KE KRA both tax income + capital gains; gas is deductible
 * against gains. The CSV exporter relies on this contract. Addition #4.
 */
export interface TaxYearSummary {
  year: number;
  realizedGains: number;
  income: number;
  yield: number;
  deductibleGas: number;
  /** = income + realizedGains - deductibleGas. See interface-contract amendment #4. */
  taxableIncome: number;
}

/** Compat entry for one (method, jurisdiction) pair. Addition #5. */
export interface MethodJurisdictionCompat {
  method: CostBasisMethod;
  jurisdiction: Jurisdiction;
  ok: boolean;
  /** Human-readable explanation when ok is false (e.g., "LIFO not permitted under NG FIRS"). */
  reason?: string;
}

/** PNL output. */
export interface PnlOutput {
  address: Address;
  method: CostBasisMethod;
  taxYears: TaxYearSummary[];
  realizedPnlByAsset: Record<string, number>;
  unrealizedPnlByAsset: Record<string, number>;
  incomeTotal: number;
  yieldTotal: number;
  /** Asset/timestamp pairs where no historical price was available — surfaces in CSV. */
  priceGaps: { asset: string; timestamp: Timestamp }[];
  /** Addition #5: one entry per (method, jurisdiction) the user might pick. */
  methodJurisdictionCompat: MethodJurisdictionCompat[];
  /**
   * Addition #6 (2026-06-10): per-disposal records (proceeds + FIFO cost
   * basis) keyed by source hash. CSV exporter uses these for per-row CGT
   * math (FIRS) and gross transfer value (KRA). May be empty for wallets
   * with no disposals.
   */
  disposals: readonly Disposal[];
}

/** A single asset disposal from the PNL engine. */
export interface Disposal {
  amount: bigint;
  symbol: string;
  /** USD proceeds in micro-USD. */
  proceedsMicroUsd: bigint;
  /** USD cost basis consumed in micro-USD. */
  costBasisMicroUsd: bigint;
  /** Realized gain in micro-USD (proceeds - cost basis). */
  gainMicroUsd: bigint;
  /** Hash of the disposal tx (TRANSFER_OUT / SWAP out / etc). */
  sourceHash: TxHash;
  /** Hash of the lot that was consumed. */
  lotSourceHash: TxHash;
  /** Token's price at disposal time (USD per token, decimal). */
  disposalPriceUsd: number;
  /** Token's price at acquisition time of the consumed lot (USD per token, decimal). */
  lotPriceUsd: number;
  timestamp: Timestamp;
}

/** CSV exporter input. */
export interface CsvExportInput {
  classified: ClassifiedTx[];
  pnl: PnlOutput;
  jurisdiction: Jurisdiction;
  taxYear: number;
}

export interface CsvExportResult {
  filename: string;
  rowCount: number;
  schema: 'nigeria-firs' | 'kenya-kra' | 'oecd-carf';
  /** The actual CSV content. */
  csv: string;
}

/** NL query interface I/O. */
export interface QueryInput {
  question: string;
  classified: ClassifiedTx[];
  pnl: PnlOutput;
  jurisdiction: Jurisdiction;
}

export interface QueryOutput {
  answer: string;
  supportingNumbers: Record<string, number>;
  citedTxHashes: TxHash[];
}

// ─── Orchestrator pipeline ──────────────────────────────────────────────────

export interface PipelineRequest {
  address: Address;
  dateRange?: { from: Timestamp; to: Timestamp };
  jurisdiction: Jurisdiction;
  method: CostBasisMethod;
  taxYear: number;
  nlQuery?: string;
  /** When true, emit a log event on Celo for Track 2 activity scoring. */
  emitOnchainLog?: boolean;
}

export interface PipelineResult {
  fetched: FetchedTxData;
  classified: ClassifyOutput;
  pnl: PnlOutput;
  csv: CsvExportResult;
  queryAnswer?: QueryOutput;
  /** Set when emitOnchainLog was true and the log tx was mined. */
  onchainLogTxHash?: TxHash;
  durationMs: number;
}

// ─── Zod schemas (single source of truth for runtime validation) ────────────
//
// Use these in:
//   - LLM fallback (llm-fallback.ts) → output_config.format = zodOutputFormat(ClassifiedTxSchema)
//   - Celoscan client → validate response shapes
//   - CSV exporter → validate jurisdiction-specific row shapes
// Do not redefine these elsewhere.

// Literal-type-preserving schemas: a bare `z.string().regex(...)` returns
// `string`, losing the `0x${string}` template-literal narrowing. The `literal`
// helper widens the inferred type back to the literal so downstream code
// (which is written against the narrowed `Address` / `TxHash`) can pass these
// schemas' outputs through without casts.
function literal<T extends string>(regex: RegExp) {
  return z.string().regex(regex).transform((s) => s as T);
}

const HexAddressSchema = literal<Address>(/^0x[0-9a-fA-F]{40}$/);
const TxHashSchema = literal<TxHash>(/^0x[a-fA-F0-9]{64}$/);

const AssetLegSchema = z.object({
  symbol: z.string(),
  amount: z.string(), // decimal string — preserve precision
  priceUsd: z.number().nonnegative(),
});

export const ClassifiedTxSchema = z.object({
  hash: TxHashSchema,
  type: z.enum([
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
    'INTERACTION',
    'UNKNOWN',
  ]),
  timestamp: z.number().int().positive(),
  assetIn: AssetLegSchema.optional(),
  assetOut: AssetLegSchema.optional(),
  classifierSource: z.enum(['rule', 'rule-protocol', 'llm', 'flagged']),
  confidence: z.number().min(0).max(1).optional(),
  aggregatedFromHashes: z.array(TxHashSchema).optional(),
  notes: z.string().optional(),
});

export const RawTxSchema = z.object({
  hash: TxHashSchema,
  blockNumber: z.number().int().nonnegative(),
  timestamp: z.number().int().nonnegative(),
  from: HexAddressSchema,
  to: HexAddressSchema.nullable(),
  value: z.string(),
  gasUsed: z.string(),
  gasPrice: z.string(),
  input: z.string(),
  methodName: z.string().optional(),
  isError: z.enum(['0', '1']),
});
