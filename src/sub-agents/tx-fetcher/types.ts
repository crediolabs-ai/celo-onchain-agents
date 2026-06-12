/**
 * Celoscan API response types.
 *
 * Owner: Credio (tx-fetcher sub-agent).
 *
 * Loose typing — the Celoscan API is Etherscan-compatible and not strictly
 * typed. We parse just enough to extract `result` and the per-row fields the
 * orchestrator cares about. Anything else is opaque.
 *
 * Reference: https://celoscan.io/apis (Etherscan-compatible schema).
 */

import type {
  Address,
  RawTx,
  TokenTransfer,
  InternalTx,
  Timestamp,
  TxHash,
} from '../../shared/types.js';

/** Generic Celoscan JSON-RPC response wrapper. */
export interface CeloscanResponse<T> {
  status: '0' | '1';
  message: string;
  result: T;
}

/** Cached view of one Celoscan `account/txlist` row. */
export interface CeloscanNormalTx {
  hash: TxHash;
  blockNumber: string;
  timeStamp: string; // unix seconds
  from: Address;
  to: Address | null;
  value: string; // wei, decimal
  gasUsed: string;
  gasPrice: string;
  input: string; // calldata hex
  methodName?: string;
  isError: '0' | '1';
  txreceipt_status?: '0' | '1';
}

/** Cached view of one Celoscan `account/tokentx` row. */
export interface CeloscanTokenTx {
  hash: TxHash;
  blockNumber: string;
  timeStamp: string; // unix seconds
  from: Address;
  to: Address;
  contractAddress: Address;
  tokenSymbol: string;
  tokenDecimal: string; // NOTE: Etherscan uses singular `tokenDecimal`, not `tokenDecimals`
  value: string; // raw amount, decimal
}

/** Cached view of one Celoscan `account/txlistinternal` row. */
export interface CeloscanInternalTx {
  hash: TxHash;
  blockNumber: string;
  timeStamp: string; // unix seconds
  from: Address;
  to: Address;
  value: string;
  callType: 'call' | 'delegatecall' | 'staticcall' | 'create';
}

/** Endpoint names. */
export type CeloscanEndpoint = 'txlist' | 'tokentx' | 'txlistinternal';

/** Per-page size. Celoscan max is 10_000 but 100 is the documented safe default. */
export const CELOSCAN_PAGE_SIZE = 100;

/** Normalize a Celoscan normal-tx row into the project's `RawTx` shape. */
export function toRawTx(r: CeloscanNormalTx): RawTx {
  const base = {
    hash: r.hash,
    blockNumber: parseInt(r.blockNumber, 10) || 0,
    timestamp: parseInt(r.timeStamp, 10) as Timestamp,
    from: r.from,
    to: r.to,
    value: r.value,
    gasUsed: r.gasUsed,
    gasPrice: r.gasPrice,
    input: r.input,
    isError: r.isError,
  };
  return r.methodName !== undefined ? { ...base, methodName: r.methodName } : base;
}

/** Normalize a Celoscan token-tx row into the project's `TokenTransfer` shape. */
export function toTokenTransfer(r: CeloscanTokenTx): TokenTransfer {
  return {
    hash: r.hash,
    blockNumber: parseInt(r.blockNumber, 10) || 0,
    timestamp: parseInt(r.timeStamp, 10) as Timestamp,
    from: r.from,
    to: r.to,
    contractAddress: r.contractAddress,
    tokenSymbol: r.tokenSymbol,
    tokenDecimals: parseInt(r.tokenDecimal, 10) || 18,
    value: r.value,
  };
}

/** Normalize a Celoscan internal-tx row into the project's `InternalTx` shape. */
export function toInternalTx(r: CeloscanInternalTx): InternalTx {
  return {
    hash: r.hash,
    blockNumber: parseInt(r.blockNumber, 10) || 0,
    timestamp: parseInt(r.timeStamp, 10) as Timestamp,
    from: r.from,
    to: r.to,
    value: r.value,
    callType: r.callType,
  };
}
