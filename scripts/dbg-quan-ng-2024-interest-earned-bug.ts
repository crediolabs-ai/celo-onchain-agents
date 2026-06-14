import { loadConfig } from '../src/shared/config.js';
loadConfig();
import { computeYieldRoundTripAdjustments } from '../src/sub-agents/pnl-calculator/index.js';
import { runPipeline } from '../src/orchestrator/pipeline.js';
import { makeProductionDeps, resolveNetwork } from '../src/orchestrator/production.js';
import { makeContractLookup } from '../src/shared/contracts.js';
import Anthropic from '@anthropic-ai/sdk';
import { type AnswerQueryDeps } from '../src/sub-agents/nl-query/index.js';

const ADDR = '0x4aaa76aB12bA7525C9E488E771C67d0BB99BfF70' as `0x${string}`;

(async () => {
  const config = loadConfig();
  const network = resolveNetwork(config.network);
  const deps = makeProductionDeps({
    config, nlQueryDeps: { llm: { client: new Anthropic({ apiKey: 'sk-x' }), model: 'claude-sonnet-4-6' } } as AnswerQueryDeps,
  });
  const r = await runPipeline({
    request: { address: ADDR, jurisdiction: 'NG', method: 'FIFO', taxYear: 2024 },
    deps, network, contractLookup: makeContractLookup(network),
  });

  const y2024 = r.pnl.taxYears.find((y) => y.year === 2024);
  console.log('=== 2024 SUMMARY ===');
  console.log('Realized:', y2024?.realizedGains);
  console.log('Income:', y2024?.income);
  console.log('Yield:', y2024?.yield);
  console.log('Interest earned:', y2024?.interestEarned);
  console.log('Taxable income:', y2024?.taxableIncome);
  console.log();

  const adjustments = computeYieldRoundTripAdjustments(r.classified.classified);
  console.log('=== ROUND-TRIP ADJUSTMENTS ===');
  console.log('yieldReductionByYear:', Object.fromEntries(adjustments.yieldReductionByYear));
  console.log('interestEarnedByYear:', Object.fromEntries(adjustments.interestEarnedByYear));
  console.log();

  console.log('=== CLASSIFIED EVENTS ===');
  for (const c of r.classified.classified) {
    const date = new Date(c.timestamp * 1000).toISOString().slice(0, 10);
    const inSym = c.assetIn?.symbol ?? '-';
    const inAmt = c.assetIn?.amount ?? '-';
    const inPx = c.assetIn?.priceUsd ?? 0;
    const outSym = c.assetOut?.symbol ?? '-';
    const outAmt = c.assetOut?.amount ?? '-';
    const outPx = c.assetOut?.priceUsd ?? 0;
    console.log(`${date}  ${c.hash.slice(0, 10)}…  type=${c.type.padEnd(15)} vault=${c.vaultAddress?.slice(0,8) ?? '-'}`);
    console.log(`    IN  ${inSym} amt=${inAmt} px=${inPx}`);
    console.log(`    OUT ${outSym} amt=${outAmt} px=${outPx}`);
    if (c.notes) console.log(`    notes: ${c.notes.slice(0, 200)}`);
  }

  console.log();
  console.log('=== DISPOSALS (where interestEarned can leak in) ===');
  for (const d of r.pnl.disposals) {
    const date = new Date(d.timestamp * 1000).toISOString().slice(0, 10);
    console.log(`${date}  category=${d.category ?? '-'}  gain=${d.gainMicroUsd}`);
  }
})().catch((e) => { console.error(e); process.exit(1); });
