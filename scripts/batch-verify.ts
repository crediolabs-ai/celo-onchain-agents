/**
 * Batch verification — incremental, line-buffered. Appends one result
 * line per address to /tmp/batch-results.tsv. Safe to re-run; will
 * re-process only addresses not already in the cache.
 *
 * Usage: npx tsx scripts/batch-verify.ts [outPath]
 */
import { loadConfig } from '../src/shared/config.js';
import { runPipeline } from '../src/orchestrator/pipeline.js';
import { makeProductionDeps, resolveNetwork } from '../src/orchestrator/production.js';
import { makeContractLookup } from '../src/shared/contracts.js';
import { type AnswerQueryDeps } from '../src/sub-agents/nl-query/index.js';
import { type LlmFallbackDeps } from '../src/sub-agents/tx-classifier/index.js';
import Anthropic from '@anthropic-ai/sdk';
import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
loadConfig();

const outPath = process.argv[2] ?? '/tmp/batch-results.tsv';
const config = loadConfig();
const network = resolveNetwork(config.network);

const key = process.env.ANTHROPIC_API_KEY;
const classifierLlmDeps: LlmFallbackDeps | undefined = key
  ? { client: new Anthropic({ apiKey: key }), model: config.anthropicModel ?? 'claude-sonnet-4-6' }
  : undefined;
const nlQueryDeps: AnswerQueryDeps = {
  llm: {
    client: new Anthropic({ apiKey: key ?? 'sk-no-key-set' }),
    model: config.anthropicModel ?? 'claude-sonnet-4-6',
  },
};
const deps = makeProductionDeps({
  config, nlQueryDeps,
  ...(classifierLlmDeps && { classifierLlmDeps }),
});
const contractLookup = makeContractLookup(network);

// CSV → Row
type Row = { address: string; type: string; profile: string; first_seen: string; best_for_testing: string; notes: string };
const csvText = readFileSync('scripts/celo-verification-addresses.csv', 'utf-8');
const lines = csvText.split('\n').filter((l) => l.length > 0);
const header = lines[0]!.split(',');
const rows: Row[] = lines.slice(1).map((l) => {
  const cells = l.split(',');
  return {
    address: cells[header.indexOf('address')]!,
    type: cells[header.indexOf('type')]!,
    profile: cells[header.indexOf('profile')]!,
    first_seen: cells[header.indexOf('first_seen')]!,
    best_for_testing: cells[header.indexOf('best_for_testing')]!,
    notes: cells[header.indexOf('notes')]!,
  };
});

const jurFor = (a: string): 'KE' | 'NG' | 'OTHER' => {
  const al = a.toLowerCase();
  if (al === '0xbe19ff9839f6eee1255f7461443ae7d987d8077c') return 'KE';
  if (al === '0x9b3319a7f1f6a7bc48af14c9b81ba4b41c7c1394') return 'NG';
  if (al === '0x46788b60daf46448668c7abaeea4ac8745451c25') return 'OTHER';
  if (al === '0xac8249fd3d5c83e58ae7b0b2bfededb5cfb0bc96') return 'NG';
  return 'NG';
};
const yearFor = (s: string): number | null => {
  if (!s || s === 'unknown' || s === 'legacy') return null;
  const m = s.match(/^(\d{4})/);
  if (!m) return null;
  const y = parseInt(m[1]!, 10);
  if (y <= 2024) return 2024;
  return y;
};

// Write header if output is new
if (!existsSync(outPath)) {
  writeFileSync(outPath, [
    'address','jur','year','type','profile','raw','token','classified','flagged','ms',
    'realGains','income','yield','interestEarned','taxableIncome','csvRows','status',
  ].join('\t') + '\n');
}

// Build set of already-done addresses
const done = new Set<string>();
if (existsSync(outPath)) {
  for (const line of readFileSync(outPath, 'utf-8').split('\n').slice(1)) {
    if (!line) continue;
    done.add(line.split('\t')[0]!.toLowerCase());
  }
}

let pass = 0, fail = 0, skip = 0;
const flush = (s: string) => process.stdout.write(s);

flush(`# Starting: ${rows.length} addresses, ${done.size} already done\n`);

for (const row of rows) {
  const a = row.address.toLowerCase();
  if (done.has(a)) { skip++; continue; }
  const year = yearFor(row.first_seen);
  if (year === null) {
    appendFileSync(outPath, [row.address,'','','contract','user',0,0,0,0,0,0,0,0,0,0,0,'SKIP-no-first-seen'].join('\t') + '\n');
    skip++;
    flush(`# SKIP ${row.address}  ${row.profile}\n`);
    continue;
  }
  const jurisdiction = jurFor(row.address);
  let cells: (string | number)[] = [];
  try {
    const r = await runPipeline({
      request: { address: row.address as `0x${string}`, jurisdiction, method: 'FIFO', taxYear: year },
      deps, network, contractLookup,
    });
    const yr = r.pnl.taxYears.find((y) => y.year === year);
    cells = [
      row.address, jurisdiction, year, row.type, row.profile,
      r.fetched.rawTxns.length, r.fetched.tokenTransfers.length,
      r.classified.classified.length, r.classified.flaggedForReview.length,
      r.durationMs,
      (yr?.realizedGains ?? 0).toFixed(2),
      (yr?.income ?? 0).toFixed(2),
      (yr?.yield ?? 0).toFixed(2),
      (yr?.interestEarned ?? 0).toFixed(2),
      (yr?.taxableIncome ?? 0).toFixed(2),
      r.csv.rowCount,
      'OK',
    ];
    pass++;
  } catch (e) {
    cells = [row.address, jurisdiction, year, row.type, row.profile,
      0,0,0,0,0,0,0,0,0,0,0, `ERR: ${(e instanceof Error ? e.message : String(e)).slice(0, 80)}`];
    fail++;
  }
  appendFileSync(outPath, cells.join('\t') + '\n');
  flush(`# ${pass+fail+skip}/${rows.length}  ${row.address.slice(0,10)}…  ${cells[cells.length - 1]}\n`);
}

flush(`\n# DONE  pass=${pass}  fail=${fail}  skip=${skip}  total=${rows.length}\n`);
