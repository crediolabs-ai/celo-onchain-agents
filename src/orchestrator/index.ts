/**
 * Orchestrator public surface.
 *
 * Owner: Credio (orchestrator).
 *
 * Re-exports the pipeline entrypoint, the two `PipelineDeps` wirings
 * (production and fixture), and the supporting types. Sub-agents and
 * the CLI import from here; nothing in the orchestrator leaks to
 * sub-agents via the type contracts in `shared/types.ts`.
 */

export { runPipeline, runDemoWithFixtures, type RunPipelineInput } from './pipeline.js';
export {
  type PipelineDeps,
  type Network,
  type ContractLookup,
  type WalletFixture,
} from './types.js';
export { makeProductionDeps, resolveNetwork } from './production.js';
export { makeFixtureDeps } from './fixture.js';
