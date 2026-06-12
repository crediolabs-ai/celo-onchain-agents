/**
 * Fixture wiring — `makeFixtureDeps(fixture)`.
 *
 * Owner: Credio (orchestrator).
 *
 * Wires the orchestrator's `PipelineDeps` against a `WalletFixture` so
 * the demo and the test suite can exercise the orchestration code
 * without touching the network, the LLM, or the on-chain log emitter.
 *
 * The fixture provides the full pipeline I/O (fetched, classified, pnl,
 * csv) and the orchestrator still does the actual sequencing — only the
 * per-stage computation is replaced with a fixture read. This means the
 * demo exercises the *same* pipeline as production; the only difference
 * is where the data comes from.
 */

import type {
  CsvExportInput,
  CsvExportResult,
  FetchedTxData,
  PipelineRequest,
  QueryInput,
  QueryOutput,
} from '../shared/types.js';
import type { PipelineDeps, WalletFixture } from './types.js';

/** Build a `PipelineDeps` that reads each stage's output from the fixture. */
export function makeFixtureDeps(fixture: WalletFixture): PipelineDeps {
  // `emitOnchainLog` is intentionally omitted (not set to undefined) so the
  // exactOptionalPropertyTypes compiler flag accepts this against
  // `PipelineDeps`. Tests assert it's `undefined` after construction.
  const deps: PipelineDeps = {
    fetchTxs: async (_req: PipelineRequest): Promise<FetchedTxData> => fixture.fetched,

    classify: async () => fixture.classified,

    computePnl: async () => fixture.pnl,

    exportCsv: async (_req: CsvExportInput): Promise<CsvExportResult> => fixture.csv,

    answerQuery: async (input: QueryInput): Promise<QueryOutput> => {
      // In fixture mode, the NL query is a deterministic stub. Real NL
      // query is wired in via `makeProductionDeps`.
      return {
        answer:
          `[fixture-mode] Stub answer for: "${input.question}". ` +
          `Real LLM-backed answers require the production wiring.`,
        supportingNumbers: {},
        citedTxHashes: [],
      };
    },
  };
  return deps;
}
