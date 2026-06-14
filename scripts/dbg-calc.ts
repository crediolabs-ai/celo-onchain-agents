import { loadConfig } from '../src/shared/config.js';
loadConfig();
import { computeYieldRoundTripAdjustments } from '../src/sub-agents/pnl-calculator/index.js';
import { runPipeline } from '../src/orchestrator/pipeline.js';
import { makeProductionDeps, resolveNetwork } from '../src/orchestrator/production.js';
import { makeContractLookup } from '../src/shared/contracts.js';
import Anthropic from '@anthropic-ai/sdk';
import { type AnswerQueryDeps } from '../src/sub-agents/nl-query/index.js';

(async () => {
  const config = loadConfig();
  const network = resolveNetwork(config.network);
  const deps = makeProductionDeps({
    config, nlQueryDeps: { llm: { client: new Anthropic({ apiKey: 'sk-x' }), model: 'claude-sonnet-4-6' } } as AnswerQueryDeps,
  });
  const r = await runPipeline({
    request: { address: '0xBE19FF9839f6eEe1255F7461443aE7d987D8077c' as `0x${string}`, jurisdiction: 'KE', method: 'FIFO', taxYear: 2024 },
    deps, network, contractLookup: makeContractLookup(network),
  });
  const adjustments = computeYieldRoundTripAdjustments(r.classified.classified);
  console.log('Adjustments:', JSON.stringify({
    yieldReductionByYear: Object.fromEntries(adjustments.yieldReductionByYear),
    interestEarnedByYear: Object.fromEntries(adjustments.interestEarnedByYear),
  }, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });
