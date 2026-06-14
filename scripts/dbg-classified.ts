import { loadConfig } from '../src/shared/config.js';
loadConfig();
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
  console.log('Yield line:', r.pnl.taxYears.find(y => y.year === 2024)?.yield);
  console.log('Interest earned:', r.pnl.taxYears.find(y => y.year === 2024)?.interestEarned);
  console.log();
  // For each classified event, show: timestamp, type, assetIn (if any), assetOut (if any), notes
  for (const c of r.classified.classified) {
    const date = new Date(c.timestamp * 1000).toISOString().slice(0, 10);
    const inSym = c.assetIn?.symbol ?? '-';
    const inAmt = c.assetIn?.amount ?? '-';
    const outSym = c.assetOut?.symbol ?? '-';
    const outAmt = c.assetOut?.amount ?? '-';
    console.log(`${date}  ${c.hash.slice(0,8)}…  type=${c.type.padEnd(20)} IN=${inSym}(${inAmt})  OUT=${outSym}(${outAmt})`);
    if (c.notes) console.log(`    notes: ${c.notes.slice(0, 80)}`);
  }
})().catch((e) => { console.error(e); process.exit(1); });
