/**
 * Shared CSV schema types for mcp-server standalone use.
 * Ported from src/shared/types.ts to avoid importing from ../../src.
 * Keep in sync with src/shared/types.ts.
 */

import type { ClassifiedTx, Disposal } from '../pipeline-core.js';

/** Minimal PNL output shape needed by CSV schemas — only disposals array. */
export interface CsvPnlOutput {
  disposals: Disposal[];
}

export type { ClassifiedTx, Disposal };
