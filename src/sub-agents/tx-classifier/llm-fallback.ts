/**
 * LLM fallback for the tx classifier.
 *
 * Owner: Tuan (tx-classifier sub-agent).
 *
 * Called from `./index.ts` only when no declarative rule in `./rules.ts` matched.
 * The fallback is per-tx: pass in the predicate context, get back a single
 * validated `ClassifiedTx` (or throw). All orchestration lives upstream.
 *
 * SDK version note: this project pins `@anthropic-ai/sdk@^0.40.0`, which
 * predates `client.messages.parse()`, the `output_config` field, and the
 * `adaptive` thinking type (Opus 4.6's only valid thinking mode on later
 * SDKs). We force structured output via the `tool_use` pattern (custom tool
 * with hand-rolled JSON schema) and omit the `thinking` field for now.
 * When the SDK is bumped to ^0.50+ this can be simplified to:
 *   1. `messages.parse({ output_format: ClassifiedTxSchema })` for output
 *   2. `thinking: { type: 'adaptive' }` for reasoning
 *
 * Model: `claude-opus-4-6` per project default.
 */

import Anthropic from '@anthropic-ai/sdk';
import { ClassifiedTxSchema, type ClassifiedTx } from '../../shared/types.js';
import { NetworkError, RateLimitError } from '../../shared/errors.js';
import { findMatchingRule } from './rules.js';
import type { PredicateContext } from './predicates.js';

// ─── Public surface ────────────────────────────────────────────────────────

/** Required dependencies; injected so the function is testable. */
export interface LlmFallbackDeps {
  /** Anthropic client. Production passes a real `new Anthropic()`; tests pass a stub. */
  client: Pick<Anthropic, 'messages'>;
  /** Override the model (mostly for tests). Default: 'claude-opus-4-6'. */
  model?: string;
  /**
   * Cap on output tokens for the LLM response. Classification is short, so
   * 1024 is plenty. Per Anthropic guidance for non-streaming requests, this
   * leaves headroom for tool calls.
   */
  maxTokens?: number;
  /**
   * Optional abort signal — lets the orchestrator cancel a long LLM run.
   * Wired through to `client.messages.create`.
   */
  signal?: AbortSignal;
}

const DEFAULT_MODEL = 'claude-opus-4-6';
const DEFAULT_MAX_TOKENS = 1024;
const CLASSIFY_TOOL_NAME = 'emit_classification';

// ─── Tool definition (hand-rolled JSON schema) ────────────────────────────
//
// Mirrors `ClassifiedTxSchema` from `src/shared/types.ts`. The schema is small
// and stable — hand-rolling avoids the dependency on Zod's `toJSONSchema()`,
// which is unavailable in `zod@3.25.x`. Post-response validation via
// `ClassifiedTxSchema.parse()` is the actual safety net.
//
// Keep in sync with `ClassifiedTxSchema` when adding fields.

const CLASSIFY_TOOL: Anthropic.Tool = {
  name: CLASSIFY_TOOL_NAME,
  description:
    'Emit a single classified transaction. Use this exactly once per request. ' +
    'Do not produce any text outside this tool call.',
  input_schema: {
    type: 'object',
    properties: {
      hash: {
        type: 'string',
        description: 'The transaction hash, copied verbatim from the user message.',
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
        description: 'The transaction category. UNKNOWN when no category fits.',
      },
      timestamp: {
        type: 'integer',
        description: 'Unix timestamp in seconds. Copied from the user message.',
      },
      assetIn: {
        type: 'object',
        properties: {
          symbol: { type: 'string', description: 'Token symbol, e.g. CELO, cUSD, USDC.' },
          amount: {
            type: 'string',
            description: 'Decimal-string amount in token units. Preserve full precision.',
          },
          priceUsd: {
            type: 'number',
            description:
              'Spot price in USD at tx time. 0 when not known — PNL stage fills this in later.',
          },
        },
        required: ['symbol', 'amount', 'priceUsd'],
        additionalProperties: false,
      },
      assetOut: {
        type: 'object',
        properties: {
          symbol: { type: 'string' },
          amount: { type: 'string' },
          priceUsd: { type: 'number' },
        },
        required: ['symbol', 'amount', 'priceUsd'],
        additionalProperties: false,
      },
      classifierSource: {
        type: 'string',
        enum: ['rule', 'llm', 'flagged'],
        description: 'Always "llm" from this fallback.',
      },
      confidence: {
        type: 'number',
        minimum: 0,
        maximum: 1,
        description: 'Your confidence in this classification, 0–1.',
      },
      aggregatedFromHashes: {
        type: 'array',
        items: { type: 'string' },
        description: 'Only set for YIELD/INCOME grouping; otherwise omit.',
      },
      notes: {
        type: 'string',
        description: 'Optional: short justification shown in the audit trail.',
      },
    },
    required: ['hash', 'type', 'timestamp', 'classifierSource', 'confidence'],
    additionalProperties: false,
  },
};

// ─── System prompt ─────────────────────────────────────────────────────────
//
// Intentionally short. The full rule table is large; we don't paste it. The
// LLM is told what the rule engine already tried, so it can reason from the
// gaps.

const SYSTEM_PROMPT = [
  'You are a Celo on-chain transaction classifier. You only see transactions',
  'that a deterministic rule table could not classify. Your job: make the final',
  'call and emit it via the emit_classification tool — no prose.',
  '',
  'Categories:',
  '  INCOME          — payment / payroll / airdrop into the wallet',
  '  SWAP            — DEX or Mento trade (token in, token out, no value in)',
  '  TRANSFER_IN     — native CELO or token received from an external EOA',
  '  TRANSFER_OUT    — native CELO or token sent to an external EOA',
  '  YIELD           — staking / lending / farming reward',
  '  GAS             — self-send or pure gas-topup',
  '  MINT / BURN     — token supply change touching the wallet',
  '  BRIDGE          — cross-chain bridge (Portal, native Celo bridge)',
  '  MENTO_STABILITY — Mento protocol stability swap (flag for review)',
  '  UNKNOWN         — genuinely none of the above',
  '',
  'Rules of thumb:',
  '  - Native value in with no token out and isError=false → likely INCOME / YIELD.',
  '  - 2+ token transfers in a single tx → likely SWAP.',
  '  - Single ERC-20 transfer() call with no native movement → TRANSFER_IN/OUT.',
  '  - Self-send (from == to == wallet) → GAS.',
  '  - When genuinely uncertain, use UNKNOWN with confidence < 0.5.',
  '',
  'Network: Celo. Native asset is CELO. Common tokens: cUSD, cEUR, cREAL, USDC, USDT, G$ (GoodDollar).',
].join('\n');

// ─── Public entrypoint ─────────────────────────────────────────────────────

/**
 * Classify a single tx via the LLM. Throws on API / network / validation
 * failure — callers (orchestrator) catch and decide whether to surface the
 * error or fall back to `flagged` classification.
 */
export async function llmClassifyTx(
  ctx: PredicateContext,
  deps: LlmFallbackDeps,
): Promise<ClassifiedTx> {
  const model = deps.model ?? DEFAULT_MODEL;
  const maxTokens = deps.maxTokens ?? DEFAULT_MAX_TOKENS;
  const userMessage = buildUserMessage(ctx);

  let response: Anthropic.Message;
  try {
    response = await deps.client.messages.create(
      {
        model,
        max_tokens: maxTokens,
        // SDK 0.40.1: `thinking.type: 'adaptive'` is not yet on the union.
        // Opus 4.6 supports it; SDK 0.50+ exposes it. Re-enable on bump.
        // thinking: { type: 'adaptive' },
        system: SYSTEM_PROMPT,
        tools: [CLASSIFY_TOOL],
        // Force tool use so we get a structured response every time.
        tool_choice: { type: 'tool', name: CLASSIFY_TOOL_NAME },
        messages: [{ role: 'user', content: userMessage }],
      },
      { signal: deps.signal },
    );
  } catch (err) {
    throw mapAnthropicError(err);
  }

  // Pull the tool_use block. With tool_choice forced, there should be exactly
  // one. If not, treat as a malformed response.
  const toolBlock = response.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
  );
  if (!toolBlock) {
    throw new NetworkError(
      `LLM fallback: no tool_use block in response (stop_reason=${response.stop_reason})`,
      undefined,
      { stopReason: response.stop_reason, content: response.content },
    );
  }

  // Coerce into the ClassifiedTx shape the rest of the system expects.
  // ClassifiedTxSchema.parse() is the single point of validation — anything
  // we add here must round-trip through Zod.
  const raw = toolBlock.input as Record<string, unknown>;
  // Build the candidate field-by-field so the spread types don't widen the
  // optional properties to `T | undefined` (which violates
  // `exactOptionalPropertyTypes`). The `NonNullable<...>` strips the
  // `| undefined` from indexed-access lookups on optional fields.
  const candidate: ClassifiedTx = {
    hash: ctx.tx.hash,
    type: raw.type as ClassifiedTx['type'],
    timestamp: ctx.tx.timestamp,
    classifierSource: 'llm',
  };
  if (typeof raw.confidence === 'number') candidate.confidence = raw.confidence;
  if (raw.assetIn) candidate.assetIn = raw.assetIn as NonNullable<ClassifiedTx['assetIn']>;
  if (raw.assetOut) candidate.assetOut = raw.assetOut as NonNullable<ClassifiedTx['assetOut']>;
  if (Array.isArray(raw.aggregatedFromHashes)) {
    candidate.aggregatedFromHashes =
      raw.aggregatedFromHashes as NonNullable<ClassifiedTx['aggregatedFromHashes']>;
  }
  if (typeof raw.notes === 'string') candidate.notes = raw.notes;

  // Zod is the source of truth — re-validate. The parsed type includes
  // `| undefined` on optional fields, which is structurally equivalent to
  // our `ClassifiedTx` at runtime but doesn't typecheck under
  // `exactOptionalPropertyTypes: true`. Cast through `unknown`.
  return ClassifiedTxSchema.parse(candidate) as unknown as ClassifiedTx;
}

// ─── Helpers ───────────────────────────────────────────────────────────────

/**
 * Build the user message — a compact, machine-friendly dump of the tx context.
 * Plain text rather than JSON to keep the prompt readable; the LLM is good at
 * structured prose.
 */
function buildUserMessage(ctx: PredicateContext): string {
  const lines: string[] = [];
  lines.push(`Classify this Celo transaction.`);
  lines.push('');
  lines.push(`Wallet under analysis: ${ctx.address}`);
  lines.push(`Network: ${ctx.knownContracts.aliases().length} known contract aliases loaded`);
  if (ctx.jurisdiction) lines.push(`Jurisdiction: ${ctx.jurisdiction}`);
  lines.push('');
  lines.push(`— Raw tx —`);
  lines.push(`  hash:        ${ctx.tx.hash}`);
  lines.push(`  blockNumber: ${ctx.tx.blockNumber}`);
  lines.push(`  timestamp:   ${ctx.tx.timestamp}`);
  lines.push(`  from:        ${ctx.tx.from}`);
  lines.push(`  to:          ${ctx.tx.to ?? '(contract creation)'}`);
  lines.push(`  value (wei): ${ctx.tx.value}`);
  lines.push(`  methodName:  ${ctx.tx.methodName ?? '(none)'}`);
  lines.push(`  isError:     ${ctx.tx.isError}`);
  lines.push(`  gasUsed:     ${ctx.tx.gasUsed} @ ${ctx.tx.gasPrice}`);

  if (ctx.transfers.length > 0) {
    lines.push('');
    lines.push(`— Token transfers (${ctx.transfers.length}) —`);
    for (const t of ctx.transfers) {
      lines.push(
        `  ${t.tokenSymbol} ${t.value} (decimals=${t.tokenDecimals}) ` +
          `from=${t.from} to=${t.to} contract=${t.contractAddress}`,
      );
    }
  }

  if (ctx.internal.length > 0) {
    lines.push('');
    lines.push(`— Internal txs (${ctx.internal.length}) —`);
    for (const it of ctx.internal) {
      lines.push(
        `  ${it.callType} from=${it.from} to=${it.to} value=${it.value}`,
      );
    }
  }

  // Audit hint — let the LLM know the rule engine's hand was forced.
  const tried = findMatchingRule(ctx);
  lines.push('');
  lines.push(
    tried
      ? `Rule table fallback: no rule matched with confidence >= 0.8. ` +
        `You are the final classifier.`
      : `Rule table fallback: no rule matched. You are the final classifier.`,
  );

  return lines.join('\n');
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
  return new NetworkError('Unknown error in LLM fallback', undefined, err);
}
