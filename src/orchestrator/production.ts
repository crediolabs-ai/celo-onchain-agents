/**
 * Production wiring — `makeProductionDeps(input)`.
 *
 * Owner: Credio (orchestrator).
 *
 * Wires the real sub-agents (Celoscan client, classifier, PNL calculator,
 * CSV exporter, NL query interface, onchain log emitter) into a
 * `PipelineDeps` for production use. The wiring layer is the only place
 * that knows about the sub-agent module paths; the pipeline itself
 * remains decoupled.
 *
 * Stages 1, 4, 6 are placeholders pending the Tx Fetcher / CSV Exporter /
 * Onchain Log Emitter sub-agents. The demo can run today against the
 * fixtures; the production wiring fills in piecewise as each sub-agent
 * lands.
 */

import {
  classifyWithDeps,
  type ClassifyDeps,
  type LlmFallbackDeps,
} from '../sub-agents/tx-classifier/index.js';
import { makeContractLookup, type Network } from '../shared/contracts.js';
import { computePnl } from '../sub-agents/pnl-calculator/index.js';
import { answerQueryWithDeps, type AnswerQueryDeps } from '../sub-agents/nl-query/index.js';
import { exportCsvAsync } from '../sub-agents/csv-exporter/index.js';
import { fetchTxs } from '../sub-agents/tx-fetcher/index.js';
import { createAgentWallet } from '../infra/wallet.js';
import { createLogEmitter } from '../infra/log-emitter.js';
import { DefiLlamaOracle } from '../shared/price-oracle/defillama.js';
import { VaultOracle } from '../infra/vault-oracle.js';
import { VAULT_UNDERLYING_BY_ADDRESS } from '../shared/contracts.js';
import type { Timestamp } from '../shared/types.js';
import type { AppConfig } from '../shared/config.js';
import type { PipelineDeps } from './types.js';
import type {
  PipelineRequest,
  ClassifiedTx,
  ClassifyOutput,
  CsvExportInput,
  CsvExportResult,
  FetchedTxData,
  Jurisdiction,
  PnlOutput,
  QueryInput,
  QueryOutput,
  TxHash,
  Address,
  CostBasisMethod,
  TokenTransfer,
} from '../shared/types.js';

/** Inputs needed for the production wiring beyond the AppConfig. */
export interface ProductionDepsInput {
  config: AppConfig;
  /**
   * LLM dependencies for the classifier's fallback path. Same shape the
   * classifier takes in its own test seam.
   */
  classifierLlmDeps?: LlmFallbackDeps;
  /** NL query deps — the Anthropic client + tool schema, etc. */
  nlQueryDeps: AnswerQueryDeps;
  /**
   * When true, the tx-fetcher skips the local cache and re-fetches from
   * Celoscan. Surfaced by the CLI as `--refresh`. Defaults to `false`.
   */
  refresh?: boolean;
}

/**
 * Resolve the orchestrator's `Network` literal from the env config.
 * Currently an identity pass-through; will translate the Celo Sepolia
 * chainId once the pilot green-lights the network swap.
 */
export function resolveNetwork(network: AppConfig['network']): Network {
  return network;
}

/** Build a `PipelineDeps` that runs the real sub-agents. */
export function makeProductionDeps(input: ProductionDepsInput): PipelineDeps {
  const { config, classifierLlmDeps, nlQueryDeps, refresh = false } = input;
  const network: Network = resolveNetwork(config.network);

  // Construct the agent EOA + log emitter once at wiring time. The wallet
  // is cheap to build (no RPC calls until first use) so eager construction
  // here keeps the emitOnchainLog dep a pure closure.
  const agentWallet = createAgentWallet(config);
  const emitLog = createLogEmitter(agentWallet);

  // Construct the DefiLlama oracle once. The PNL / CSV exporter consume
  // priceUsd from each classified tx's assetIn/assetOut. The classifier
  // emits priceUsd=0 (the price is not its job); the orchestrator must
  // enrich before PNL runs or every year summary collapses to $0 even
  // when the classifier correctly identified income events. DefiLlama
  // is fully public — no API key needed, generous rate limit.
  const priceOracle = new DefiLlamaOracle();
  // Vault oracle computes share-to-USD price for ERC-4626 vault events
  // by reading `convertToAssets` on-chain at the event's block. Falls
  // back to DefiLlama for unknown vaults or RPC failures.
  const vaultOracle = new VaultOracle({ rpcUrl: config.celoRpcUrl, defiLlamaOracle: priceOracle });

  const classifierDeps: ClassifyDeps = {
    makeLookup: makeContractLookup,
    ...(classifierLlmDeps !== undefined && { llm: classifierLlmDeps }),
  };

  return {
    fetchTxs: async (req: PipelineRequest): Promise<FetchedTxData> => {
      return fetchTxs(req, {
        apiUrl: config.celoscanApiUrl,
        ...(config.celoscanApiKey !== '' && { apiKey: config.celoscanApiKey }),
        chainId: config.chainId,
        network: config.network,
        cacheDir: config.cacheDir,
        ...(refresh && { refresh: true }),
      });
    },

    classify: async ({ fetched }): Promise<ClassifyOutput> => {
      const out = await classifyWithDeps({ fetched, network }, classifierDeps);
      // Price enrichment: fill priceUsd on each classified tx's
      // assetIn/assetOut. Vault events go through the on-chain
      // convertToAssets oracle (receipt tokens are synthetic, not on
      // DefiLlama); everything else falls through to DefiLlama. Without
      // this step, every tx leaves the classifier with priceUsd=0 and
      // the PNL engine + CSV exporter read that zero straight into the
      // year summary. The oracles' internal caches dedupe lookups.
      await enrichClassifiedPrices(out.classified, priceOracle, vaultOracle, fetched.rawTxns, fetched.tokenTransfers);
      return out;
    },

    computePnl: async ({
      classified,
      address,
      method,
      taxYear,
    }: {
      classified: ClassifiedTx[];
      address: Address;
      method: CostBasisMethod;
      taxYear: number;
      jurisdiction: Jurisdiction;
    }): Promise<PnlOutput> => {
      return computePnl({ address, classified, method, taxYear });
    },

    exportCsv: async (input: CsvExportInput): Promise<CsvExportResult> => {
      return exportCsvAsync(input);
    },

    answerQuery: async (input: QueryInput): Promise<QueryOutput> => {
      return answerQueryWithDeps(input, nlQueryDeps);
    },

    emitOnchainLog: async (input): Promise<TxHash | undefined> => {
      return await emitLog({ result: input.result, request: input.request });
    },
  };
}

/**
 * Fill `priceUsd` on every classified tx's `assetIn` / `assetOut` that
 * currently has `priceUsd: 0` (the classifier's default for the
 * rule-engine and protocol-decoder paths — pricing is not its job).
 *
 * Priority for each leg:
 *   1. Transfer-ratio for vault events — derives the share-to-underlying
 *      ratio from the tx's own token transfers (underlying out, shares
 *      in). Accurate at event time, no RPC required, works on any
 *      archive (or no archive). Multiplied by the underlying's USD
 *      price from DefiLlama to produce a USD/share figure.
 *   2. DefiLlama fallback for non-vault events and vault events where
 *      the transfer-ratio path couldn't resolve the data.
 *
 * Lookups are deduped per (symbol, timestamp) within this call so a
 * 1,000-tx wallet doesn't issue 1,000 HTTP requests.
 * Failures (unknown symbol, history endpoint out-of-range) are silent
 * — the engine records priceGaps for the CLI to surface.
 */
async function enrichClassifiedPrices(
  classified: readonly ClassifiedTx[],
  oracle: DefiLlamaOracle,
  vaultOracle: VaultOracle,
  rawTxns: readonly { hash: TxHash; blockNumber: number | string }[],
  tokenTransfers: readonly TokenTransfer[],
): Promise<void> {
  const blockByHash = new Map<TxHash, bigint>();
  for (const tx of rawTxns) {
    blockByHash.set(tx.hash, BigInt(tx.blockNumber));
  }

  // 1. Vault events via transfer-ratio (no RPC).
  //    The deposit's own token transfers carry the exact historical
  //    exchange rate: underlying_amount / shares_amount = price/share
  //    in underlying units. Multiply by the underlying's USD price
  //    (DefiLlama — handles stables at $1, real assets at real price).
  for (const cls of classified) {
    if (!cls.vaultAddress) continue;
    const ratio = deriveVaultRatioFromTransfers(cls, tokenTransfers);
    if (ratio === null) continue;
    const underlying = VAULT_UNDERLYING_BY_ADDRESS[cls.vaultAddress.toLowerCase()];
    if (!underlying) continue;
    const underlyingPrice = await oracle.getHistoricalPrice(underlying.symbol, cls.timestamp);
    if (!underlyingPrice) continue;
    const usdPrice = ratio * underlyingPrice.priceUsd;
    for (const leg of [cls.assetIn, cls.assetOut]) {
      if (leg && leg.priceUsd === 0) leg.priceUsd = usdPrice;
    }
  }

  // 2. Vault events that didn't get priced via transfer-ratio fall
  //    back to the on-chain oracle (convertToAssets at the event block).
  for (const cls of classified) {
    if (!cls.vaultAddress) continue;
    let alreadyPriced = false;
    for (const leg of [cls.assetIn, cls.assetOut]) {
      if (leg && leg.priceUsd > 0) { alreadyPriced = true; break; }
    }
    if (alreadyPriced) continue;
    const block = blockByHash.get(cls.hash);
    if (block === undefined) continue;
    const vaultPrice = await vaultOracle.getSharePriceUsd(cls.vaultAddress, block, cls.timestamp);
    if (vaultPrice === null) continue;
    for (const leg of [cls.assetIn, cls.assetOut]) {
      if (leg && leg.priceUsd === 0) leg.priceUsd = vaultPrice;
    }
  }

  // 3. DefiLlama fallback for non-vault events (and any legs still at 0).
  const seen = new Set<string>();
  type Pair = { symbol: string; ts: Timestamp };
  const pairs: Pair[] = [];
  for (const cls of classified) {
    for (const leg of [cls.assetIn, cls.assetOut]) {
      if (!leg || leg.priceUsd > 0) continue;
      const key = `${leg.symbol}:${cls.timestamp}`;
      if (seen.has(key)) continue;
      seen.add(key);
      pairs.push({ symbol: leg.symbol, ts: cls.timestamp });
    }
  }
  const prices = new Map<string, number>();
  await Promise.all(
    pairs.map(async ({ symbol, ts }) => {
      const point = await oracle.getHistoricalPrice(symbol, ts);
      if (point) prices.set(`${symbol}:${ts}`, point.priceUsd);
    }),
  );
  for (const cls of classified) {
    for (const leg of [cls.assetIn, cls.assetOut]) {
      if (!leg || leg.priceUsd > 0) continue;
      const p = prices.get(`${leg.symbol}:${cls.timestamp}`);
      if (p !== undefined) leg.priceUsd = p;
    }
  }
}

/**
 * Derive the share-to-underlying ratio for an ERC-4626 event from the
 * tx's own token transfers.
 *
 * For a deposit: user pays `X` underlying (often via a router/proxy
 * that forwards to the vault — the underlying transfer's counterparty
 * is therefore NOT always the vault), and the vault mints `Y` shares
 * to the user. The share transfer's `contractAddress` IS the vault
 * itself (the vault is the ERC-20 contract for its own receipt token).
 * Ratio = X / Y (in normalized units, i.e. dividing each by its decimals).
 *
 * Returns the ratio in underlying units per 1 share (multiply by
 * underlying's USD price to get USD/share), or null if the data is
 * missing.
 */
function deriveVaultRatioFromTransfers(
  classified: ClassifiedTx,
  tokenTransfers: readonly TokenTransfer[],
): number | null {
  if (!classified.vaultAddress) return null;
  const underlying = VAULT_UNDERLYING_BY_ADDRESS[classified.vaultAddress.toLowerCase()];
  if (!underlying) return null;

  const vault = classified.vaultAddress.toLowerCase();
  const underlyingAddress = underlying.address.toLowerCase();
  const txTransfers = tokenTransfers.filter((t) => t.hash === classified.hash);

  // Share transfer: contractAddress is the vault itself. This is the
  // strong signal that distinguishes a vault event from a coincidental
  // same-tx same-token transfer on a different contract.
  const sharesTransfer = txTransfers.find((t) => t.contractAddress.toLowerCase() === vault);
  if (!sharesTransfer) return null;

  // Underlying transfer: any same-tx transfer of the underlying token
  // (typically 1 per deposit; the counterparty may be a router/proxy
  // instead of the vault, so we don't filter on from/to).
  const underlyingTransfer = txTransfers.find(
    (t) => t.contractAddress.toLowerCase() === underlyingAddress,
  );
  if (!underlyingTransfer) return null;

  const underlyingAmount = BigInt(underlyingTransfer.value);
  const sharesAmount = BigInt(sharesTransfer.value);
  if (sharesAmount === 0n) return null;

  const underlyingUnit = 10n ** BigInt(underlying.decimals);
  const sharesDecimals = sharesTransfer.tokenDecimals;
  const sharesUnit = 10n ** BigInt(sharesDecimals);
  const ratio = Number(underlyingAmount * sharesUnit) / Number(sharesAmount * underlyingUnit);
  if (ratio <= 0 || !Number.isFinite(ratio)) return null;
  return ratio;
}
