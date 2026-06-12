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
      return classifyWithDeps({ fetched, network }, classifierDeps);
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
