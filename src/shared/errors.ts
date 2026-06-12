/**
 * Typed errors used across all sub-agents.
 *
 * All catch sites should pattern-match on these. We avoid string-based
 * discrimination in favor of `instanceof` to keep the orchestrator's
 * error-handling logic refactor-safe.
 *
 * Note: `code` is intentionally non-readonly so subclasses (e.g. RateLimitError)
 * can refine the discriminator. Treat it as immutable in practice.
 */

export class AgentError extends Error {
  code: string;
  readonly cause?: unknown;
  constructor(message: string, code: string, cause?: unknown) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.cause = cause;
  }
}

export class ConfigError extends AgentError {
  constructor(message: string, cause?: unknown) {
    super(message, 'CONFIG_ERROR', cause);
  }
}

export class NetworkError extends AgentError {
  readonly status?: number;
  constructor(message: string, status?: number, cause?: unknown) {
    super(message, 'NETWORK_ERROR', cause);
    if (status !== undefined) {
      this.status = status;
    }
  }
}

export class RateLimitError extends NetworkError {
  readonly retryAfterMs?: number;
  constructor(retryAfterMs?: number, cause?: unknown) {
    super('Rate limit hit', 429, cause);
    this.code = 'RATE_LIMIT';
    if (retryAfterMs !== undefined) {
      this.retryAfterMs = retryAfterMs;
    }
  }
}

export class CeloscanError extends AgentError {
  constructor(message: string, cause?: unknown) {
    super(message, 'CELOSCAN_ERROR', cause);
  }
}

export class DefiLlamaError extends AgentError {
  constructor(message: string, cause?: unknown) {
    super(message, 'DEFILLAMA_ERROR', cause);
  }
}

export class WalletError extends AgentError {
  constructor(message: string, cause?: unknown) {
    super(message, 'WALLET_ERROR', cause);
  }
}

export class ValidationError extends AgentError {
  readonly field?: string;
  constructor(message: string, field?: string, cause?: unknown) {
    super(message, 'VALIDATION_ERROR', cause);
    if (field !== undefined) {
      this.field = field;
    }
  }
}

/**
 * Narrow helper: is this error a 429 we should back off and retry?
 * Usage: `if (isRateLimit(err)) await sleep(backoffMs)`
 */
export function isRateLimit(err: unknown): err is RateLimitError {
  return err instanceof RateLimitError;
}
