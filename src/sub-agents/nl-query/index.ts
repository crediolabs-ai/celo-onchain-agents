/**
 * Natural-language query interface — the user-facing Q&A layer of Agent 06.
 *
 * Owner: Tuan (nl-query sub-agent).
 *
 * Pipeline: question → `llmTranslateQuestion` (one LLM call) → `executeQuery`
 * (deterministic) → `QueryOutput`. No second LLM call for answer synthesis —
 * the deterministic formatter is what makes the answer auditable and
 * free of LLM hallucination in the final user-visible string.
 *
 * The `answerQuery` entrypoint is the convenience overload used by the
 * orchestrator and tests; `answerQueryWithDeps` is the testable seam.
 */

import type { QueryInput, QueryOutput } from '../../shared/types.js';
import { NetworkError } from '../../shared/errors.js';
import { executeQuery, type QueryExecutionResult } from './execute.js';
import { llmTranslateQuestion, type LlmTranslatorDeps } from './llm-translator.js';
import type { QueryIntent } from './intents.js';

// Re-export sub-modules so callers (orchestrator, tests) have a single import.
export { executeQuery } from './execute.js';
export type { QueryExecutionResult } from './execute.js';
export { llmTranslateQuestion } from './llm-translator.js';
export type { LlmTranslatorDeps } from './llm-translator.js';
export { QueryIntentSchema, NL_TX_TYPES, NL_COST_METHODS, NL_JURISDICTIONS } from './intents.js';
export type { QueryIntent, QueryIntentKind } from './intents.js';

// ─── Public surface ────────────────────────────────────────────────────────

/**
 * Optional dependencies for the convenience `answerQuery` overload.
 * When omitted, the function expects an `ANTHROPIC_API_KEY` env var and
 * constructs a real `Anthropic` client.
 */
export interface AnswerQueryDeps {
  llm: LlmTranslatorDeps;
  /** Optional abort signal — propagated to the LLM call. */
  signal?: AbortSignal;
}

/**
 * Answer a natural-language question about the user's classified transactions
 * and computed PNL.
 *
 * Convenience overload: builds dependencies from environment. Production
 * uses this; tests use `answerQueryWithDeps` instead.
 */
export async function answerQuery(input: QueryInput): Promise<QueryOutput> {
  // Lazy import to avoid a hard `@anthropic-ai/sdk` dependency for callers
  // that only use the deterministic execution path (e.g. CSV exporter).
  const Anthropic = (await import('@anthropic-ai/sdk')).default;
  return answerQueryWithDeps(input, {
    llm: { client: new Anthropic() },
  });
}

/**
 * Testable seam: caller injects the LLM client (real or stub). The
 * orchestrator and tests both use this entrypoint.
 */
export async function answerQueryWithDeps(
  input: QueryInput,
  deps: AnswerQueryDeps,
): Promise<QueryOutput> {
  let intent: QueryIntent;
  try {
    intent = await llmTranslateQuestion(input.question, {
      ...deps.llm,
      ...(deps.signal !== undefined ? { signal: deps.signal } : {}),
    });
  } catch (err) {
    // If the LLM fails (network, rate-limit, validation), degrade gracefully
    // to the `unknown` intent with a transparent error note. The orchestrator
    // may choose to surface the original error separately.
    const reason = err instanceof NetworkError ? err.message : 'LLM call failed';
    return {
      answer: `I could not reach the language model (${reason}). ` +
        'Try rephrasing, or ask one of the supported question types ' +
        '(year summary, asset PNL, transaction type breakdown, etc).',
      supportingNumbers: {},
      citedTxHashes: [],
    };
  }

  const result: QueryExecutionResult = executeQuery(
    intent,
    input.classified,
    input.pnl,
  );

  return {
    answer: result.answer,
    supportingNumbers: result.numbers,
    citedTxHashes: result.citedTxHashes,
  };
}
