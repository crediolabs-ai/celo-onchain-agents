/**
 * Agent EOA — viem wrapper for the on-chain operations Agent 06 performs
 * (ERC-8004 registration, log emission, future contract writes).
 *
 * Owner: Credio (infra).
 *
 * The agent wallet is a single EOA on the active Celo network. It is
 * configured via `AGENT_WALLET_*` env vars (see `shared/config.ts`) and
 * constructed once at startup by `createAgentWallet(config)`. All later
 * pipeline stages that need to sign or broadcast go through this seam so
 * the private key never escapes the infra layer.
 *
 * Public surface:
 *   - `createAgentWallet(config) → AgentWallet`
 *   - `AgentWallet` interface methods: address, getBalance, hasGas,
 *     signMessage, sendTransaction, writeContract, waitForReceipt.
 *
 * Design:
 *   - viem v2 — `createPublicClient` for reads, `createWalletClient` for writes.
 *   - No I/O happens at construction. The first RPC call is lazy (e.g. on
 *     `getBalance()`). Keeps startup fast and lets tests construct the
 *     wallet without a live RPC.
 *   - All errors thrown here are `WalletError` (or one of the http-side
 *     `NetworkError`/`RateLimitError`) so the orchestrator can pattern-match
 *     and surface them uniformly.
 *
 * Out of scope (other infra modules):
 *   - erc8004.ts — registry contract interaction (will use `writeContract`).
 *   - log-emitter.ts — periodic on-chain log events (will use `sendTransaction`).
 */

import {
  createPublicClient,
  createWalletClient,
  http,
  type Address,
  type Chain,
  type Hash,
  type Hex,
  type PublicClient,
  type WalletClient,
  type WriteContractParameters,
} from 'viem';
import { WalletError } from '../shared/errors.js';
import type { AppConfig } from '../shared/config.js';

// ─── Types ───────────────────────────────────────────────────────────────────

/** Default minimum native CELO balance for a single on-chain operation. */
export const DEFAULT_MIN_GAS_WEI = 100_000_000_000_000_000n; // 0.1 CELO

/** Result of a gas-availability check. */
export interface GasCheck {
  ok: boolean;
  balanceWei: bigint;
  requiredWei: bigint;
  shortfallWei: bigint;
}

/** Transaction request shape accepted by `sendTransaction`. */
export interface TxRequest {
  to: Address;
  value?: bigint;
  data?: Hex;
  gas?: bigint;
}

/** Public surface of an agent wallet. */
export interface AgentWallet {
  /** EOA address (derived from the configured private key, lowercase). */
  readonly address: Address;
  /** viem chain object — useful for callers that need chainId / nativeCurrency. */
  readonly chain: Chain;
  /** Public RPC client. Exposed so log-emitter and erc8004 can do read calls. */
  readonly publicClient: PublicClient;
  /** Wallet RPC client. Pre-bound to the agent account. */
  readonly walletClient: WalletClient;

  /** Native CELO balance in wei. */
  getBalance(): Promise<bigint>;

  /**
   * True iff balance ≥ `requiredWei` (default `DEFAULT_MIN_GAS_WEI`).
   * Returns a structured `GasCheck` so callers can show a friendly message
   * ("need 0.5 CELO, have 0.12") instead of just a boolean.
   */
  hasGas(requiredWei?: bigint): Promise<GasCheck>;

  /**
   * Sign an EIP-191 personal message. Used by ERC-8004 challenges and any
   * future off-chain signature flows. Does not broadcast.
   */
  signMessage(message: string): Promise<Hex>;

  /**
   * Sign and broadcast a transaction. Returns the tx hash. Does NOT wait
   * for the receipt — call `waitForReceipt(hash)` explicitly.
   */
  sendTransaction(tx: TxRequest): Promise<Hash>;

  /**
   * Sign and broadcast a contract function call. Returns the tx hash.
   * Sugar over `sendTransaction` for the common ERC-8004 / log-emitter
   * pattern of calling a single contract function.
   */
  writeContract(args: WriteContractParameters): Promise<Hash>;

  /**
   * Wait for a transaction receipt with default 1 confirmation.
   * Throws `WalletError` if the tx is reverted or times out.
   *
   * Return type is viem's own (EIP-4844-aware) receipt union — kept as the
   * `Awaited<ReturnType<…>>` so viem's type changes don't require us to
   * mirror them here.
   */
  waitForReceipt(
    hash: Hash,
    confirmations?: number,
  ): Promise<Awaited<ReturnType<PublicClient['waitForTransactionReceipt']>>>;
}

// ─── Factory ─────────────────────────────────────────────────────────────────

/** Build an `AgentWallet` from validated app config. */
export function createAgentWallet(config: AppConfig): AgentWallet | undefined {
  // Agent wallet is optional — only present when AGENT_WALLET_PRIVATE_KEY is set.
  // Read-only paths (fetch, classify, PNL, CSV) work without a wallet; write
  // paths (e.g. --emit-onchain-log) need it.
  if (!config.agentWallet) return undefined;

  const { chain, celoRpcUrl, agentWallet } = config;
  const account = agentWallet.account;
  const address = account.address;

  // The `chain` field on `AppConfig` is a `typeof celoAlfajores | typeof celo`
  // union (pre-L2 + post-L2). viem 2.x's client types don't unify cleanly
  // across these — they ship different `getBlock` schemas. The runtime
  // behaviour is identical for our needs (we only do reads + native sends),
  // so we widen to the common `Chain` base here.
  //
  // Safety: viem's `Chain` interface is structurally compatible with both
  // `celoAlfajores` and `celo` — the union members differ in `block.form`
  // (pre-L2) vs `block.type` (post-L2) but both fields exist in some form
  // on the base. The cast is provably safe today; if viem ever adds a
  // required field that one chain satisfies and the other doesn't, this
  // cast would need re-evaluation.
  const chainForClient = chain as Chain;

  const publicClient: PublicClient = createPublicClient({
    chain: chainForClient,
    transport: http(celoRpcUrl),
  });
  const walletClient: WalletClient = createWalletClient({
    account,
    chain: chainForClient,
    transport: http(celoRpcUrl),
  });

  return {
    address,
    chain,
    publicClient,
    walletClient,

    async getBalance(): Promise<bigint> {
      try {
        return await publicClient.getBalance({ address });
      } catch (err) {
        throw new WalletError(
          `wallet.getBalance failed for ${address} on ${chain.name}`,
          err,
        );
      }
    },

    async hasGas(requiredWei: bigint = DEFAULT_MIN_GAS_WEI): Promise<GasCheck> {
      const balanceWei = await this.getBalance();
      const ok = balanceWei >= requiredWei;
      return {
        ok,
        balanceWei,
        requiredWei,
        shortfallWei: ok ? 0n : requiredWei - balanceWei,
      };
    },

    async signMessage(message: string): Promise<Hex> {
      try {
        return await account.signMessage({ message });
      } catch (err) {
        throw new WalletError('wallet.signMessage failed', err);
      }
    },

    async sendTransaction(tx: TxRequest): Promise<Hash> {
      try {
        return await walletClient.sendTransaction({
          account,
          chain,
          to: tx.to,
          ...(tx.value !== undefined && { value: tx.value }),
          ...(tx.data !== undefined && { data: tx.data }),
          ...(tx.gas !== undefined && { gas: tx.gas }),
        });
      } catch (err) {
        throw new WalletError(
          `wallet.sendTransaction to ${tx.to} failed`,
          err,
        );
      }
    },

    async writeContract(args: WriteContractParameters): Promise<Hash> {
      try {
        return await walletClient.writeContract({
          ...args,
          account,
          chain,
        });
      } catch (err) {
        const target = 'address' in args ? String(args.address) : '<dynamic>';
        throw new WalletError(`wallet.writeContract to ${target} failed`, err);
      }
    },

    async waitForReceipt(
      hash: Hash,
      confirmations = 1,
    ): Promise<Awaited<ReturnType<PublicClient['waitForTransactionReceipt']>>> {
      try {
        return await publicClient.waitForTransactionReceipt({ hash, confirmations });
      } catch (err) {
        throw new WalletError(
          `wallet.waitForReceipt failed for ${hash}`,
          err,
        );
      }
    },
  };
}
