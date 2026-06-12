/**
 * LLM translator: natural language question → structured `QueryIntent`.
 *
 * Owner: Tuan (nl-query sub-agent).
 *
 * The LLM is constrained to emit a single tool call (`emit_intent`) whose
 * schema mirrors `QueryIntentSchema` in `./intents.ts`. Hand-rolled JSON
 * schema (the SDK 0.40.1 pin predates `output_config` / `parse()`), then
 * re-validated with Zod as the actual safety net.
 *
 * SDK version note (mirrors the tx-classifier's llm-fallback.ts):
 *   - `client.messages.parse()` not available in 0.40.x — we use the
 *     `tool_use` pattern with `tool_choice: { type: 'tool', name: ... }`.
 *   - `thinking.type: 'adaptive'` not in the union — left off with a
 *     TSDoc note to re-enable on SDK `^0.50+` bump.
 *   - Model: `claude-sonnet-4-6` per project default.
 *
 * The system prompt contains the schema in plain text so the LLM can
 * reason about which intent to pick, even though the API also enforces
 * it structurally.
 */

import Anthropic from '@anthropic-ai/sdk';
import { NetworkError, RateLimitError } from '../../shared/errors.js';
import { QueryIntentSchema, type QueryIntent } from './intents.js';
import { SKILLS } from '../../shared/skills.js';

// ─── Public surface ────────────────────────────────────────────────────────

/** Required dependencies; injected so the function is testable. */
export interface LlmTranslatorDeps {
  /** Anthropic client. Production passes a real `new Anthropic()`; tests pass a stub. */
  client: Pick<Anthropic, 'messages'>;
  /** Override the model (mostly for tests). Default: 'claude-sonnet-4-6'. */
  model?: string;
  /**
   * Cap on output tokens. Intent selection is short, so 512 is plenty.
   * Per Anthropic guidance for non-streaming requests, leaves headroom.
   */
  maxTokens?: number;
  /**
   * Optional abort signal — lets the orchestrator cancel a long LLM run.
   * Wired through to `client.messages.create`.
   */
  signal?: AbortSignal;
}

const DEFAULT_MODEL = 'claude-sonnet-4-6';
const DEFAULT_MAX_TOKENS = 512;
const INTENT_TOOL_NAME = 'emit_intent';

// ─── Tool definition (hand-rolled JSON schema) ────────────────────────────
//
// Mirrors `QueryIntentSchema` from `./intents.ts`. Schema is small and stable
// — hand-rolling avoids the dependency on Zod's `toJSONSchema()` (unavailable
// in `zod@3.25.x`). Post-response validation via `QueryIntentSchema.parse()`
// is the actual safety net. Keep in sync when adding intents.

const INTENT_TOOL: Anthropic.Tool = {
  name: INTENT_TOOL_NAME,
  description:
    'Emit a single structured query intent for the tax & portfolio agent. ' +
    'Use this exactly once per request. Do not produce any text outside this ' +
    'tool call.',
  input_schema: {
    type: 'object',
    properties: {
      kind: {
        type: 'string',
        enum: [
          'year_summary',
          'tx_type_breakdown',
          'asset_pnl',
          'jurisdiction_compat',
          'top_assets',
          'list_transactions',
          'price_gaps',
          'unknown',
        ],
        description: 'Which intent best matches the user question.',
      },
      taxYear: {
        type: 'integer',
        description: 'Tax year as a 4-digit integer. Required for year_summary; optional for several others.',
      },
      type: {
        type: 'string',
        enum: [
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
        ],
        description: 'Tx type filter. For tx_type_breakdown (required) and list_transactions (optional).',
      },
      aggregation: {
        type: 'string',
        enum: ['sum', 'count', 'list'],
        description: 'For tx_type_breakdown: how to aggregate. Default sum.',
      },
      asset: {
        type: 'string',
        description: 'Token symbol (CELO, cUSD, USDC, etc.). Required for asset_pnl.',
      },
      metric: {
        type: 'string',
        enum: ['realized', 'unrealized', 'income', 'yield', 'all'],
        description: 'For asset_pnl: which PNL metric.',
      },
      method: {
        type: 'string',
        enum: ['FIFO', 'LIFO', 'WAC'],
        description: 'For jurisdiction_compat: cost basis method.',
      },
      jurisdiction: {
        type: 'string',
        enum: ['NG', 'KE', 'OTHER'],
        description: 'For jurisdiction_compat: tax jurisdiction.',
      },
      n: {
        type: 'integer',
        description: 'For top_assets: how many assets to return (1–20).',
      },
      by: {
        type: 'string',
        enum: ['income', 'yield', 'realizedPnl'],
        description: 'For top_assets: which metric to rank by.',
      },
      source: {
        type: 'string',
        enum: ['rule', 'llm', 'flagged', 'any'],
        description: 'For list_transactions: classifier source filter. Default any.',
      },
      limit: {
        type: 'integer',
        description: 'For list_transactions: max transactions to return (1–200). Default 20.',
      },
      rationale: {
        type: 'string',
        description: 'Optional: one-sentence explanation of why you picked this intent.',
      },
    },
    required: ['kind'],
    additionalProperties: false,
  },
};

// ─── System prompt ─────────────────────────────────────────────────────────

const SYSTEM_PROMPT = [
  'You are the intent classifier for Agent 06 — a Celo on-chain tax & portfolio',
  'agent. The user asks a natural-language question about their classified',
  'transactions and computed PNL. Your job: pick exactly one of the eight',
  'structured intents below, fill in the relevant fields, and emit it via the',
  'emit_intent tool — no prose.',
  '',
  'Intents (each is a flat object with `kind` and the relevant fields):',
  '',
  '1. year_summary',
  '   - fields: kind, taxYear (4-digit int)',
  '   - use: "What was my 2024 taxable income?" / "Show my 2023 summary" / "Tax owed in 2025"',
  '',
  '2. tx_type_breakdown',
  '   - fields: kind, type (INCOME/SWAP/.../UNKNOWN), aggregation (sum|count|list, default sum), taxYear?',
  '   - use: "How many SWAPs did I do?" / "Total income in 2024" / "List my YIELD transactions"',
  '',
  '3. asset_pnl',
  '   - fields: kind, asset (symbol), metric (realized|unrealized|income|yield|all)',
  '   - use: "How much did I make on CELO?" / "USDC unrealized gain" / "All metrics for cUSD"',
  '',
  '4. jurisdiction_compat',
  '   - fields: kind, method (FIFO/LIFO/WAC), jurisdiction (NG/KE/OTHER)',
  '   - use: "Is LIFO allowed in Nigeria?" / "Can I use WAC in Kenya?"',
  '',
  '5. top_assets',
  '   - fields: kind, n (1–20), by (income|yield|realizedPnl)',
  '   - use: "My top 3 income sources" / "Top 5 by realized PNL"',
  '',
  '6. list_transactions',
  '   - fields: kind, type? (filter), source (rule|llm|flagged|any, default any), taxYear?, limit (1–200, default 20)',
  '   - use: "Show me my flagged transactions" / "List 50 SWAPs" / "Rule-classified transactions in 2024"',
  '',
  '7. price_gaps',
  '   - fields: kind, taxYear?',
  '   - use: "Did I have any price gaps?" / "Missing prices in 2024"',
  '',
  '8. unknown',
  '   - fields: kind only',
  '   - use: When the question does not match any of the above (chitchat, off-topic, ambiguous across many intents)',
  '',
  'Disambiguation tips:',
  '  - "taxable income", "tax summary", "year summary" → year_summary (with year).',
  '  - "did I make money on X" → asset_pnl with metric=realized.',
  '  - "how much X" + asset → asset_pnl, not tx_type_breakdown.',
  '  - "is X legal in Y" → jurisdiction_compat.',
  '  - "top N" → top_assets (requires a metric to rank by).',
  '  - "show me transactions" / "list transactions" → list_transactions.',
  '  - Currency / network / "how does this work" → unknown.',
  '  - When multiple intents could fit, prefer the more specific one (e.g. "CELO income 2024" → tx_type_breakdown with type=INCOME over asset_pnl).',
  '',
  'Network: Celo. Native asset is CELO. Common tokens: cUSD, cEUR, cREAL, USDC, USDT, G$.',
  '',
  '## Tax rules reference (for jurisdiction_compat intent)',
  'When the user asks a jurisdiction_compat question (e.g. "Is LIFO allowed in',
  'Nigeria?"), use the canonical reference below as the source of truth for',
  'rates, methods, and reporting rules. Cite the source in `rationale` using',
  'the format `[src: ' + SKILLS.regulatory.source + ']` so downstream code can',
  'surface the citation. Do not invent rates or rules not in the reference.',
  '',
  SKILLS.regulatory.body,
].join('\n');

// ─── Public entrypoint ─────────────────────────────────────────────────────

/**
 * Translate a natural-language question into a `QueryIntent`.
 *
 * Throws on API / network / validation failure. Callers (orchestrator) catch
 * and decide whether to surface the error or fall back to `unknown` intent.
 */
export async function llmTranslateQuestion(
  question: string,
  deps: LlmTranslatorDeps,
): Promise<QueryIntent> {
  const model = deps.model ?? DEFAULT_MODEL;
  const maxTokens = deps.maxTokens ?? DEFAULT_MAX_TOKENS;

  let response: Anthropic.Message;
  try {
    response = await deps.client.messages.create(
      {
        model,
        max_tokens: maxTokens,
        // SDK 0.40.1: `thinking.type: 'adaptive'` not on the union.
        // Opus 4.6 supports it; SDK 0.50+ exposes it. Re-enable on bump.
        // thinking: { type: 'adaptive' },
        system: SYSTEM_PROMPT,
        tools: [INTENT_TOOL],
        // Force tool use so we get a structured response every time.
        tool_choice: { type: 'tool', name: INTENT_TOOL_NAME },
        messages: [{ role: 'user', content: buildUserMessage(question) }],
      },
      { signal: deps.signal },
    );
  } catch (err) {
    throw mapAnthropicError(err);
  }

  const toolBlock = response.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
  );
  if (!toolBlock) {
    throw new NetworkError(
      `LLM translator: no tool_use block in response (stop_reason=${response.stop_reason})`,
      undefined,
      { stopReason: response.stop_reason, content: response.content },
    );
  }

  // Zod is the source of truth. The parse below is the real safety net —
  // anything we accept must round-trip through QueryIntentSchema.
  return QueryIntentSchema.parse(toolBlock.input);
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function buildUserMessage(question: string): string {
  return [
    'Map the following user question to a structured query intent.',
    'Use the emit_intent tool exactly once. No prose.',
    '',
    `User question: ${question.trim()}`,
  ].join('\n');
}

/** Map Anthropic SDK errors to project-typed errors. */
function mapAnthropicError(err: unknown): Error {
  if (err instanceof Anthropic.RateLimitError) {
    const headers = (err as unknown as { headers?: Headers }).headers;
    const retryAfterRaw =
      headers && typeof (headers as Headers).get === 'function'
        ? (headers as Headers).get('retry-after')
        : undefined;
    const retryAfterMs = retryAfterRaw ? Number(retryAfterRaw) * 1000 : undefined;
    return new RateLimitError(
      Number.isFinite(retryAfterMs) ? retryAfterMs : undefined,
      err,
    );
  }
  if (err instanceof Anthropic.APIError) {
    return new NetworkError(
      `Anthropic API error ${err.status}: ${err.message}`,
      err.status,
      err,
    );
  }
  if (err instanceof Error) return err;
  return new NetworkError('Unknown error in LLM translator', undefined, err);
}
