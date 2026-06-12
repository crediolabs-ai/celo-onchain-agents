/**
 * CSV exporter — the final stage of the Agent 06 pipeline.
 *
 * Owner: csv-exporter sub-agent.
 *
 * Public surface: `exportCsv(input: CsvExportInput): Promise<CsvExportResult>`.
 *
 * Architecture:
 *   CsvExportInput
 *     → dispatcher (reads jurisdiction)
 *         ├── 'NG'  → buildNigeriaFirsRows + renderNigeriaFirsCsv
 *         ├── 'KE'  → buildKenyaKraRows    + renderKenyaKraCsv
 *         └── 'OTHER' → buildOecdCarfRows  + renderOecdCarfCsv
 *     → CsvExportResult { filename, rowCount, schema, csv }
 *
 * Each schema is isolated in its own file under `schemas/` so the NG / KE /
 * OECD teams can evolve their formats independently.
 *
 * The `exportCsv` function is the seam the orchestrator wires; the schema
 * builders are pure and independently testable.
 */

import type { CsvExportInput, CsvExportResult, Jurisdiction } from '../../shared/types.js';

import {
  buildNigeriaFirsRows,
  renderNigeriaFirsCsv,
} from './schemas/nigeria-firs.js';
import {
  buildKenyaKraRows,
  renderKenyaKraCsv,
} from './schemas/kenya-kra.js';
import {
  buildOecdCarfRows,
  renderOecdCarfCsv,
} from './schemas/oecd-carf.js';

// Re-export row types so callers can inspect the structured rows if needed
// without importing from the schemas sub-path.
export type { NigeriaFirsRow } from './schemas/nigeria-firs.js';
export type { KenyaKraRow } from './schemas/kenya-kra.js';
export type { OecdCarfRow } from './schemas/oecd-carf.js';

/** Filename slug per jurisdiction. */
const SCHEMA_FILENAME: Record<Jurisdiction, string> = {
  NG: 'nigeria-firs',
  KE: 'kenya-kra',
  OTHER: 'oecd-carf',
};

/**
 * Export classified transactions and PNL data as a tax-ready CSV string.
 *
 * Pure function — no I/O, no network, no dependencies on environment.
 * The orchestrator's production wiring calls this directly.
 */
export function exportCsv(input: CsvExportInput): CsvExportResult {
  const { classified, pnl, jurisdiction, taxYear } = input;

  const schema = jurisdictionToSchema(jurisdiction);
  const filename = `agent-06-${taxYear}-${SCHEMA_FILENAME[jurisdiction]}.csv`;

  let csv: string;
  let rowCount: number;

  switch (jurisdiction) {
    case 'NG': {
      const ngRows = buildNigeriaFirsRows(classified, pnl, taxYear);
      csv = renderNigeriaFirsCsv(ngRows);
      rowCount = ngRows.length;
      break;
    }
    case 'KE': {
      const keRows = buildKenyaKraRows(classified);
      csv = renderKenyaKraCsv(keRows);
      rowCount = keRows.length;
      break;
    }
    case 'OTHER': {
      const carfRows = buildOecdCarfRows(classified, pnl, taxYear);
      csv = renderOecdCarfCsv(carfRows);
      rowCount = carfRows.length;
      break;
    }
  }

  return {
    filename,
    rowCount,
    schema,
    csv,
  };
}

/** Map our Jurisdiction union to the CsvExportResult schema literal. */
function jurisdictionToSchema(j: Jurisdiction): CsvExportResult['schema'] {
  switch (j) {
    case 'NG':
      return 'nigeria-firs';
    case 'KE':
      return 'kenya-kra';
    case 'OTHER':
      return 'oecd-carf';
  }
}

/**
 * Async wrapper — exists only to match the `PipelineDeps.exportCsv` signature.
 * Production wiring calls this; fixture wiring stubs it at the orchestrator layer.
 * The underlying `exportCsv` is pure and synchronous so the synchronous code
 * is easy to unit-test without spies.
 */
export async function exportCsvAsync(input: CsvExportInput): Promise<CsvExportResult> {
  return exportCsv(input);
}
