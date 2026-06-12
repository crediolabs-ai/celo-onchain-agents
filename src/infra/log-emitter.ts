/**
 * On-chain log emitter — Track 2 (Most Onchain Activity) scoring.
 *
 * Owner: Credio (infra).
 *
 * For every tax report the agent generates, this module broadcasts a
 * 0-value self-transaction whose `data` field carries an ASCII-encoded
 * summary of the report. The tx is trivially identifiable on Celoscan
 * (sender = recipient = agent wallet), so judges / indexers can count
 * the agent's activity without parsing contract events.
 *
 * Why self-send:
 *   - No recipient coordination needed (no need to deploy a "log hub" contract).
 *   - 0 value → no economic side effects.
 *   - Data field carries the payload; Celoscan renders it as a hex blob
 *     and our `decodeLogPayload()` helper turns it back into a summary.
 *
 * Why ASCII (not ABI-encoded):
 *   - No receiver contract means no one is decoding. ASCII is human-readable
 *     on Celoscan and trivial to grep for ("agent-06:" in tx data).
 *   - For a hackathon the payload is small (<200 bytes) and stable across
 *     schema bumps via the `v1` prefix.
 *
 * Wired into the orchestrator's `emitOnchainLog` dep by `production.ts`.
 */

import type { Hash, Hex } from 'viem';
import { toHex, stringToBytes } from 'viem';
import { WalletError } from '../shared/errors.js';
import type { AgentWallet } from './wallet.js';
import type {
  Jurisdiction,
  PipelineRequest,
  PipelineResult,
} from '../shared/types.js';

// ─── Types ───────────────────────────────────────────────────────────────────

/** Payload version. Bump if the encoding shape changes. */
export const LOG_PAYLOAD_VERSION = 'v1';

/** Prefix that all Agent 06 log txs share. Indexers grep for this. */
export const LOG_PAYLOAD_PREFIX = `agent-06:${LOG_PAYLOAD_VERSION}`;

/** Decoded summary carried in the log tx's data field. */
export interface LogPayload {
  agent: string; // 'agent-06'
  version: string; // 'v1'
  jurisdiction: Jurisdiction;
  taxYear: number;
  /** Taxable income in USD (2 dp, string to avoid float drift). */
  taxableIncomeUsd: string;
  /** Number of classified txs in the report. */
  txCount: number;
  /** Unix timestamp of the report run. */
  emittedAt: number;
}

export type EmitInput = {
  result: Omit<PipelineResult, 'durationMs' | 'onchainLogTxHash'>;
  request: PipelineRequest;
};

export type EmitFn = (input: EmitInput) => Promise<Hash>;

// ─── Encoding ────────────────────────────────────────────────────────────────

/**
 * Build the ASCII payload carried in the log tx's data field.
 *
 * Format: `agent-06:v1:<JURISDICTION>:<YEAR>:<USD>:<TX_COUNT>:<UNIX>`
 * Example: `agent-06:v1:NG:2024:1.25:7:1716662400`
 *
 * USD value is the report's `taxableIncome` for the requested year (or 0
 * if the year summary is missing). 2 dp, never negative, "0.00" if zero.
 */
export function buildLogPayload(input: EmitInput, now: number = Date.now()): string {
  const { request, result } = input;
  const yearSummary = result.pnl.taxYears.find((y) => y.year === request.taxYear);
  const usd = yearSummary?.taxableIncome ?? 0;
  const usdStr = (usd < 0 ? 0 : usd).toFixed(2);
  return [
    LOG_PAYLOAD_PREFIX,
    request.jurisdiction,
    String(request.taxYear),
    usdStr,
    String(result.classified.classified.length),
    String(Math.floor(now / 1000)),
  ].join(':');
}

/** Hex-encode a UTF-8 string. Wraps viem's `stringToBytes` + `toHex`. */
export function asciiToHexData(s: string): Hex {
  return toHex(stringToBytes(s));
}

/** Decode a hex data field back to its ASCII summary. Returns null on bad input. */
export function decodeLogPayload(data: Hex | undefined): string | null {
  if (data === undefined || data === '0x') return null;
  try {
    const hex = data.slice(2);
    if (hex.length % 2 !== 0) return null;
    let out = '';
    for (let i = 0; i < hex.length; i += 2) {
      out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
    }
    return out.startsWith(LOG_PAYLOAD_PREFIX) ? out : null;
  } catch {
    return null;
  }
}

// ─── Factory ─────────────────────────────────────────────────────────────────

/**
 * Build the `emitOnchainLog` pipeline dep.
 *
 * Sends a 0-value self-tx whose data field encodes the report summary.
 * Throws `WalletError` on RPC failure (orchestrator catches + logs).
 */
export function createLogEmitter(wallet: AgentWallet): EmitFn {
  return async (input: EmitInput): Promise<Hash> => {
    const payload = buildLogPayload(input);
    const data = asciiToHexData(payload);
    try {
      return await wallet.sendTransaction({
        to: wallet.address,
        value: 0n,
        data,
      });
    } catch (err) {
      throw new WalletError(
        `log emission failed for ${wallet.address} (payload: ${payload})`,
        err,
      );
    }
  };
}
