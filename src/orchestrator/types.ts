/**
 * Orchestrator types — the `PipelineDeps` injection surface.
 *
 * Owner: Credio (orchestrator).
 *
 * The pipeline is a sequence of stage functions. `runPipeline(req, deps)`
 * calls them in order, threading data forward. The `deps` interface is the
 * ONLY seam that lets callers (production wiring, demo, tests) substitute
 * stage implementations without forking the orchestration logic.
 *
 * Design contract:
 *   - Every stage is a pure async function over its declared input shape.
 *   - Stages do not see each other except through the typed input/output.
 *   - No global state, no module-level singletons inside the orchestrator.
 *   - The production wiring (`makeProductionDeps`) and the demo wiring
 *     (`makeFixtureDeps`) are the only two `PipelineDeps` implementations.
 */

import type {
  Address,
  ClassifiedTx,
  ClassifyOutput,
  CostBasisMethod,
  CsvExportInput,
  CsvExportResult,
  FetchedTxData,
  Jurisdiction,
  PnlOutput,
  PipelineRequest,
  PipelineResult,
  QueryInput,
  QueryOutput,
  TxHash,
} from '../shared/types.js';
// Re-use the contracts module's Network/ContractLookup so the orchestrator
// stays in lockstep with the classifier's view of the world.
import type { Network, ContractLookup } from '../shared/contracts.js';

export type { Network, ContractLookup };

/**
 * Pipeline stage dependencies.
 *
 * Every field is an async function so the orchestrator can `await` each
 * stage uniformly. Production wiring implements them with real services
 * (Blockscout, Anthropic SDK, viem, etc.); tests and the demo pass stubs
 * backed by fixtures.
 */
export interface PipelineDeps {
  /**
   * Stage 1: pull raw on-chain data for `req.address` over `req.dateRange`.
   * Required. Failure here is the only "hard" failure of the pipeline —
   * everything downstream is meaningless without a `FetchedTxData`.
   */
  fetchTxs: (req: PipelineRequest) => Promise<FetchedTxData>;

  /**
   * Stage 2: classify the raw txs into the `ClassifiedTx` shape the PNL
   * calculator, CSV exporter, and NL query interface consume.
   */
  classify: (input: {
    fetched: FetchedTxData;
    network: Network;
    contractLookup: ContractLookup;
  }) => Promise<ClassifyOutput>;

  /**
   * Stage 3: compute realized/unrealized PNL, income, yield, and per-year
   * summaries from the classified txs.
   */
  computePnl: (input: {
    classified: ClassifiedTx[];
    address: Address;
    method: CostBasisMethod;
    taxYear: number;
    jurisdiction: Jurisdiction;
  }) => Promise<PnlOutput>;

  /**
   * Stage 4: render the CSV in the jurisdiction-appropriate schema
   * (nigeria-firs / kenya-kra / oecd-carf).
   */
  exportCsv: (input: CsvExportInput) => Promise<CsvExportResult>;

  /**
   * Stage 5: answer a natural-language question against the classified
   * txs + computed PNL. Called only when `req.nlQuery` is set.
   */
  answerQuery: (input: QueryInput) => Promise<QueryOutput>;

  /**
   * Stage 6: emit a log event on Celo for Track 2 (Most Onchain Activity)
   * scoring. Called only when `req.emitOnchainLog` is true.
   *
   * Returns the on-chain tx hash on success, or `undefined` if the
   * emission was skipped / failed (the orchestrator treats this as
   * non-fatal — a failed log doesn't void the tax report).
   */
  emitOnchainLog?: (input: {
    result: Omit<PipelineResult, 'durationMs' | 'onchainLogTxHash'>;
    request: PipelineRequest;
  }) => Promise<TxHash | undefined>;
}

/** Shape of a wallet fixture for the demo. See `tests/fixtures/wallet-fixture.ts`. */
export interface WalletFixture {
  address: Address;
  network: Network;
  fetched: FetchedTxData;
  classified: ClassifyOutput;
  pnl: PnlOutput;
  csv: CsvExportResult;
}
