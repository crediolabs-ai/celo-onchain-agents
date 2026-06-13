/**
 * Orchestrator pipeline — `runPipeline(req, deps)`.
 *
 * Owner: Credio (orchestrator).
 *
 * Sequences the 6 sub-agents in dependency order:
 *   1. fetch  → FetchedTxData       (required; failure halts the pipeline)
 *   2. classify → ClassifyOutput
 *   3. computePnl → PnlOutput
 *   4. exportCsv → CsvExportResult
 *   5. answerQuery → QueryOutput    (only if req.nlQuery)
 *   6. emitOnchainLog → TxHash      (only if req.emitOnchainLog; non-fatal)
 *
 * The pipeline does NOT branch on error mid-run: if any required stage
 * throws, the error propagates. Sub-agents surface partial failures via
 * their own fields (e.g. `FetchedTxData.fetchErrors`) and the orchestrator
 * forwards them as-is. This keeps the failure surface explicit at the
 * contract layer rather than hidden behind try/catch in the orchestrator.
 *
 * Duration is measured around the whole pipeline, not per stage — a
 * sub-agent that needs per-stage timings should add its own instrumentation.
 */

import type {
  ClassifyOutput,
  CsvExportInput,
  CsvExportResult,
  PipelineRequest,
  PipelineResult,
  QueryInput,
  TxHash,
} from '../shared/types.js';
import { makeContractLookup } from '../shared/contracts.js';
import type { PipelineDeps, Network, ContractLookup, WalletFixture } from './types.js';
import { makeFixtureDeps } from './fixture.js';

export interface RunPipelineInput {
  request: PipelineRequest;
  deps: PipelineDeps;
  network: Network;
  /** Resolver for the active named-contract registry. */
  contractLookup: ContractLookup;
}

/**
 * Execute the full Agent 06 pipeline.
 *
 * Pure orchestration: no I/O happens in this function — every byte that
 * crosses the wire, every LLM call, every on-chain tx is performed by a
 * stage function in `deps`. This makes the pipeline trivially testable
 * (the demo and the test suite both stub out `deps`).
 */
export async function runPipeline(input: RunPipelineInput): Promise<PipelineResult> {
  const { request, deps, network, contractLookup } = input;
  const startMs = Date.now();

  const fetched = await deps.fetchTxs(request);

  const classified: ClassifyOutput = await deps.classify({
    fetched,
    network,
    contractLookup,
  });

  const pnl = await deps.computePnl({
    classified: classified.classified,
    address: request.address,
    method: request.method,
    taxYear: request.taxYear,
    jurisdiction: request.jurisdiction,
  });

  // Filter classified txs to the requested tax year so the CSV is a year-scoped
  // report (not a lifetime dump). The PNL engine keeps multi-year totals intact
  // for the summary; only the CSV narrows to the requested year. Year boundary
  // is [Jan 1 00:00:00 UTC, Jan 1 00:00:00 UTC next year).
  const yearStartSec = Math.floor(Date.UTC(request.taxYear, 0, 1) / 1000);
  const yearEndSec = Math.floor(Date.UTC(request.taxYear + 1, 0, 1) / 1000);
  const yearScopedClassified = classified.classified.filter(
    (c) => c.timestamp >= yearStartSec && c.timestamp < yearEndSec,
  );
  const csvInput: CsvExportInput = {
    classified: yearScopedClassified,
    pnl,
    jurisdiction: request.jurisdiction,
    taxYear: request.taxYear,
  };
  const csv: CsvExportResult = await deps.exportCsv(csvInput);

  let queryAnswer: PipelineResult['queryAnswer'];
  if (request.nlQuery !== undefined && request.nlQuery.length > 0) {
    const queryInput: QueryInput = {
      question: request.nlQuery,
      classified: classified.classified,
      pnl,
      jurisdiction: request.jurisdiction,
    };
    queryAnswer = await deps.answerQuery(queryInput);
  }

  // Onchain log emission is best-effort: a failed log must not void the
  // tax report. Caller can re-run with emitOnchainLog=true.
  let onchainLogTxHash: TxHash | undefined;
  if (request.emitOnchainLog === true && deps.emitOnchainLog !== undefined) {
    const partial: Omit<PipelineResult, 'durationMs' | 'onchainLogTxHash'> = {
      fetched,
      classified,
      pnl,
      csv,
      ...(queryAnswer !== undefined ? { queryAnswer } : {}),
    };
    try {
      onchainLogTxHash = await deps.emitOnchainLog({ result: partial, request });
    } catch (err) {
      console.warn('[orchestrator] emitOnchainLog failed; tax report is intact', err);
      onchainLogTxHash = undefined;
    }
  }

  return {
    fetched,
    classified,
    pnl,
    csv,
    ...(queryAnswer !== undefined ? { queryAnswer } : {}),
    ...(onchainLogTxHash !== undefined ? { onchainLogTxHash } : {}),
    durationMs: Date.now() - startMs,
  };
}

/**
 * Run the pipeline against a `WalletFixture`.
 *
 * This is the demo + tests seam Tuan asked for. It composes `runPipeline`
 * with `makeFixtureDeps` so the demo and the test suite share 100% of
 * the orchestration code — only the data source changes.
 *
 * The fixture's `address` is used as the pipeline request's address.
 * The caller is responsible for adding `nlQuery` / `emitOnchainLog` /
 * jurisdiction overrides to the returned `PipelineRequest` shape.
 */
export async function runDemoWithFixtures(
  fixture: WalletFixture,
  requestOverrides: Partial<PipelineRequest> = {},
): Promise<PipelineResult> {
  const request: PipelineRequest = {
    address: fixture.address,
    jurisdiction: 'NG',
    method: 'FIFO',
    taxYear: new Date().getUTCFullYear() - 1,
    ...requestOverrides,
  };
  const deps = makeFixtureDeps(fixture);
  const contractLookup: ContractLookup = makeContractLookup(fixture.network);
  return runPipeline({
    request,
    deps,
    network: fixture.network,
    contractLookup,
  });
}
