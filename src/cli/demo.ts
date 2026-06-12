/**
 * Agent 06 end-to-end demo CLI.
 *
 * Owner: Tuan (demo + writeup).
 *
 * Exercises the 3 shipped sub-agents (tx-classifier, pnl-calculator,
 * nl-query) against the wallet fixture, no network or API keys required.
 *
 * Modes:
 *   --mode=rules   Show tx-classifier output (classified txs, rule hits, flagged)
 *   --mode=pnl     Show pnl-calculator output (tax years, asset PNL, compat)
 *   --mode=ask     Show nl-query answer to a natural-language question
 *   --mode=all     Run all three in sequence
 *
 * Output is markdown on stdout. Exit code is non-zero on pipeline failure.
 *
 * Design:
 *   - Uses `runPipeline` directly with `makeFixtureDeps` so the demo and
 *     orchestrator test suite share 100% of the orchestration code.
 *   - For `ask` mode, builds a custom `PipelineDeps` that uses the real
 *     `answerQueryWithDeps` (the production NL-query path) but with a
 *     deterministic stub LLM. The stub is a small keyword → intent map
 *     so the demo is reproducible without `ANTHROPIC_API_KEY`.
 *   - If `ANTHROPIC_API_KEY` is set, `--mode=ask` uses the real Anthropic
 *     client instead. Same code path, different LLM dep.
 */

import { Command } from 'commander';
import Anthropic from '@anthropic-ai/sdk';
import {
  runPipeline,
  makeFixtureDeps,
  type PipelineDeps,
} from '../orchestrator/index.js';
import { makeContractLookup } from '../shared/contracts.js';
import type {
  ClassifyOutput,
  PnlOutput,
  PipelineRequest,
  PipelineResult,
  QueryInput,
  QueryOutput,
} from '../shared/types.js';
import {
  answerQueryWithDeps,
  type AnswerQueryDeps,
} from '../sub-agents/nl-query/index.js';
import { walletFixture } from '../../tests/fixtures/wallet-fixture.js';

// ─── CLI definition ────────────────────────────────────────────────────────

type Mode = 'rules' | 'pnl' | 'ask' | 'all';

const program = new Command();

program
  .name('agent-06-demo')
  .description(
    'Agent 06 end-to-end demo. Runs the tx-classifier, pnl-calculator, ' +
      'and nl-query sub-agents against the wallet fixture.',
  )
  .version('0.1.0')
  .option('-m, --mode <mode>', 'demo mode: rules | pnl | ask | all', 'all')
  .option('-q, --question <text>', 'question for ask mode', 'What was my 2024 taxable income?')
  .option(
    '-j, --jurisdiction <code>',
    'jurisdiction override: NG | KE | OTHER',
    'NG',
  )
  .option('--method <m>', 'cost basis method: FIFO | LIFO | WAC', 'FIFO')
  .option('--year <yyyy>', 'tax year override (4-digit int)', String(new Date().getUTCFullYear() - 1))
  .option('--real-llm', 'use real Anthropic client if ANTHROPIC_API_KEY is set', false)
  .parse(process.argv);

const opts = program.opts<{
  mode: Mode;
  question: string;
  jurisdiction: 'NG' | 'KE' | 'OTHER';
  method: 'FIFO' | 'LIFO' | 'WAC';
  year: string;
  realLlm: boolean;
}>();

// ─── Stub LLM (deterministic keyword → intent dispatch) ────────────────────

/**
 * Demo LLM stub. Maps common question keywords to one of the 8 NL-query
 * intents, mirrors the production LLM translator's tool_use response shape
 * so `llmTranslateQuestion` accepts the result and Zod-validates the intent.
 *
 * Production note: real Anthropic client emits the intent via the
 * `emit_intent` tool. The stub returns the same `tool_use` content block.
 */
function makeStubLlm(): Pick<Anthropic, 'messages'> {
  // The translator only reads `content` (looking for a tool_use block) and
  // `stop_reason`. The shape below is the minimum needed for the demo.
  // The double cast mirrors the test seam in `tests/unit/nl-query.test.ts`:
  // the SDK's `Messages` class has many methods (batches, stream, _client, ...)
  // we don't need to implement for the stub.
  const stubCreate = async (params: unknown): Promise<unknown> => {
    const question = extractQuestionFromParams(params);
    const intent = pickIntentFromQuestion(question);
    return {
      stop_reason: 'tool_use',
      content: [
        { type: 'tool_use', id: 'tu_stub', name: 'emit_intent', input: intent },
      ],
    };
  };
  const messagesStub = { create: stubCreate };
  return {
    messages: messagesStub as unknown as Anthropic['messages'],
  };
}

/**
 * Pull the user question out of the LLM call params. The translator's
 * `buildUserMessage` formats it as a multi-line string with a `User question:`
 * marker; we extract the trailing line.
 */
function extractQuestionFromParams(params: unknown): string {
  if (!params || typeof params !== 'object') return '';
  const p = params as { messages?: Array<{ content?: unknown }> };
  const first = p.messages?.[0];
  if (!first || typeof first.content !== 'string') return '';
  const lines = first.content.split('\n');
  const last = lines[lines.length - 1] ?? '';
  return last.startsWith('User question:') ? last.slice('User question:'.length).trim() : '';
}

/**
 * Map a user question to a `QueryIntent` (the LLM's job, done deterministically
 * here). Mirrors the SYSTEM_PROMPT in `llm-translator.ts` so the demo's intent
 * matches what the real LLM would pick for these questions.
 */
function pickIntentFromQuestion(question: string): Record<string, unknown> {
  const q = question.toLowerCase();
  // year_summary
  if (/(tax|taxable|income|summary).*(2024|2023|2025|year)|what.*(owe|tax)/.test(q)) {
    const yearMatch = q.match(/20\d{2}/);
    return { kind: 'year_summary', taxYear: yearMatch ? Number(yearMatch[0]) : 2024 };
  }
  // asset_pnl (CELO is the dominant asset in the fixture)
  if (/\bcelo\b.*(pnl|gain|loss|made|earn|profit)|how much.*celo/.test(q)) {
    return { kind: 'asset_pnl', asset: 'CELO', metric: 'realized' };
  }
  if (/\busdc\b/.test(q)) {
    return { kind: 'asset_pnl', asset: 'USDC', metric: 'realized' };
  }
  // tx_type_breakdown
  if (/how many.*(swap|income|yield|transfer|bridge)/.test(q)) {
    const typeMatch = q.match(/(swap|income|yield|transfer|bridge)/i);
    const typeUpper = (typeMatch?.[1] ?? 'INCOME').toUpperCase();
    return { kind: 'tx_type_breakdown', type: typeUpper, aggregation: 'count' };
  }
  if (/(total|sum).*(income|reward|yield)/.test(q)) {
    return { kind: 'tx_type_breakdown', type: 'INCOME', aggregation: 'sum' };
  }
  // jurisdiction_compat — combine method + jurisdiction in one branch
  if (
    /(lifo|wac|fifo).*(ng|ke|kenya|nigeria)/.test(q) ||
    /(legal|allowed|permit).*(ng|nigeria|ke|kenya)/.test(q)
  ) {
    const methodMatch = q.match(/(lifo|wac|fifo)/i);
    const jurMatch = q.match(/(ng|ke|kenya|nigeria)/i);
    return {
      kind: 'jurisdiction_compat',
      method: (methodMatch?.[1] ?? 'FIFO').toUpperCase(),
      jurisdiction: jurMatch?.[1]?.toLowerCase().startsWith('k') ? 'KE' : 'NG',
    };
  }
  // top_assets
  if (/top\s*\d+.*(asset|earn|income|profit|pnl)/.test(q)) {
    const nMatch = q.match(/top\s*(\d+)/);
    return {
      kind: 'top_assets',
      n: nMatch ? Number(nMatch[1]) : 3,
      by: 'realizedPnl',
    };
  }
  // list_transactions — check `flagged` first (more specific)
  if (/flagged/.test(q)) {
    return { kind: 'list_transactions', source: 'flagged', limit: 10 };
  }
  if (/(list|show).*(transaction|swap|income|reward|bridge)/.test(q)) {
    return { kind: 'list_transactions', limit: 10 };
  }
  // price_gaps
  if (/(price gap|missing price|no price|price oracle)/.test(q)) {
    return { kind: 'price_gaps', taxYear: 2024 };
  }
  // unknown fallback
  return { kind: 'unknown' };
}

// ─── Deps construction ─────────────────────────────────────────────────────

function buildDeps(useRealLlm: boolean): PipelineDeps {
  const base = makeFixtureDeps(walletFixture);
  // The real answerQuery path with either the real Anthropic client
  // (if --real-llm and ANTHROPIC_API_KEY is set) or the deterministic stub.
  // The question flows through `QueryInput.question` → LLM translator's
  // `buildUserMessage` → stub extracts it from `params.messages[0].content`.
  const llm: AnswerQueryDeps['llm'] = useRealLlm
    ? { client: new Anthropic() }
    : { client: makeStubLlm() };
  return {
    ...base,
    answerQuery: (input: QueryInput): Promise<QueryOutput> => answerQueryWithDeps(input, { llm }),
  };
}

// ─── Pipeline run ──────────────────────────────────────────────────────────

async function runOnce(mode: Mode): Promise<PipelineResult> {
  const includeNl = mode === 'ask' || mode === 'all';
  const request: PipelineRequest = {
    address: walletFixture.address,
    jurisdiction: opts.jurisdiction,
    method: opts.method,
    taxYear: Number(opts.year),
    ...(includeNl ? { nlQuery: opts.question } : {}),
  };
  // `rules`/`pnl` modes never reach `answerQuery`; the fixture's stub is fine.
  // `ask`/`all` modes need the real LLM path — real Anthropic client if both
  // `--real-llm` and `ANTHROPIC_API_KEY` are set, else the deterministic stub.
  const useRealLlm = includeNl && opts.realLlm && Boolean(process.env.ANTHROPIC_API_KEY);
  const deps = includeNl ? buildDeps(useRealLlm) : makeFixtureDeps(walletFixture);
  const contractLookup = makeContractLookup(walletFixture.network);
  return runPipeline({
    request,
    deps,
    network: walletFixture.network,
    contractLookup,
  });
}

// ─── Markdown formatters ───────────────────────────────────────────────────

function renderRules(result: PipelineResult): string {
  const c: ClassifyOutput = result.classified;
  const lines: string[] = [];
  lines.push('# Agent 06 Demo — Tx Classifier', '');
  lines.push('**Sub-agent 1/3**: `src/sub-agents/tx-classifier/`', '');
  lines.push(`- Address: \`${result.fetched.address}\``);
  lines.push(`- Network: \`${walletFixture.network}\``);
  lines.push(`- Date range: ${fmtDate(result.fetched.dateRange.from)} → ${fmtDate(result.fetched.dateRange.to)}`);
  lines.push(`- Fetched at: ${fmtDate(result.fetched.fetchedAt)}`);
  lines.push(`- Source: \`${result.fetched.source}\``);
  lines.push(`- Pagination complete: ${result.fetched.paginationComplete}`);
  lines.push(`- Fetch errors: ${result.fetched.fetchErrors.length}`);
  lines.push('');
  lines.push('## Classified transactions', '');
  lines.push('| Hash (short) | Type | Timestamp | Asset In | Asset Out | Source | Confidence |');
  lines.push('|---|---|---|---|---|---|---|');
  for (const tx of c.classified) {
    lines.push(
      `| \`${tx.hash.slice(0, 10)}…\` | \`${tx.type}\` | ${fmtDate(tx.timestamp)} | ` +
        `${fmtLeg(tx.assetIn)} | ${fmtLeg(tx.assetOut)} | \`${tx.classifierSource}\` | ` +
        `${tx.confidence !== undefined ? tx.confidence.toFixed(2) : '—'} |`,
    );
  }
  lines.push('');
  lines.push('## Classifier stats', '');
  lines.push(`- **Total classified**: ${c.classified.length}`);
  lines.push(`- **Rule hits**: ${c.ruleHits}`);
  lines.push(`- **LLM fallbacks**: ${c.llmFallbacks}`);
  lines.push(`- **Flagged for review**: ${c.flaggedForReview.length}`);
  if (c.flaggedForReview.length > 0) {
    for (const h of c.flaggedForReview) {
      lines.push(`  - \`${h}\``);
    }
  }
  lines.push('');
  lines.push(`Pipeline duration: **${result.durationMs} ms**`);
  return lines.join('\n');
}

function renderPnl(result: PipelineResult): string {
  const p: PnlOutput = result.pnl;
  const lines: string[] = [];
  lines.push('# Agent 06 Demo — PNL Calculator', '');
  lines.push('**Sub-agent 2/3**: `src/sub-agents/pnl-calculator/`', '');
  lines.push(`- Address: \`${p.address}\``);
  lines.push(`- Cost basis method: \`${p.method}\``);
  lines.push(`- Income total: $${p.incomeTotal.toFixed(2)}`);
  lines.push(`- Yield total: $${p.yieldTotal.toFixed(2)}`);
  lines.push('');
  lines.push('## Per-year summaries', '');
  if (p.taxYears.length === 0) {
    lines.push('_No tax years computed._');
  } else {
    lines.push('| Year | Realized | Income | Yield | Deductible gas | Taxable income |');
    lines.push('|---|---|---|---|---|---|');
    for (const y of p.taxYears) {
      lines.push(
        `| ${y.year} | $${y.realizedGains.toFixed(2)} | $${y.income.toFixed(2)} | ` +
          `$${y.yield.toFixed(2)} | $${y.deductibleGas.toFixed(2)} | ` +
          `**$${y.taxableIncome.toFixed(2)}** |`,
      );
    }
  }
  lines.push('');
  lines.push('## Realized PNL by asset', '');
  lines.push('| Asset | Realized | Unrealized |');
  lines.push('|---|---|---|');
  const allAssets = new Set([
    ...Object.keys(p.realizedPnlByAsset),
    ...Object.keys(p.unrealizedPnlByAsset),
  ]);
  for (const a of [...allAssets].sort()) {
    lines.push(
      `| ${a} | $${(p.realizedPnlByAsset[a] ?? 0).toFixed(2)} | ` +
        `$${(p.unrealizedPnlByAsset[a] ?? 0).toFixed(2)} |`,
    );
  }
  lines.push('');
  lines.push('## Method × Jurisdiction compatibility', '');
  if (p.methodJurisdictionCompat.length === 0) {
    lines.push('_No compat entries._');
  } else {
    lines.push('| Method | Jurisdiction | OK | Reason |');
    lines.push('|---|---|---|---|');
    for (const e of p.methodJurisdictionCompat) {
      lines.push(
        `| \`${e.method}\` | \`${e.jurisdiction}\` | ${e.ok ? '✅' : '❌'} | ${e.reason ?? '—'} |`,
      );
    }
  }
  lines.push('');
  lines.push('## CSV export', '');
  lines.push(`- File: \`${result.csv.filename}\``);
  lines.push(`- Schema: \`${result.csv.schema}\``);
  lines.push(`- Rows: ${result.csv.rowCount}`);
  lines.push('');
  if (p.priceGaps.length > 0) {
    lines.push('## Price gaps (missing historical prices)', '');
    for (const g of p.priceGaps) {
      lines.push(`- ${g.asset} @ ${fmtDate(g.timestamp)}`);
    }
    lines.push('');
  }
  lines.push(`Pipeline duration: **${result.durationMs} ms**`);
  return lines.join('\n');
}

function renderAsk(result: PipelineResult): string {
  const lines: string[] = [];
  lines.push('# Agent 06 Demo — NL Query', '');
  lines.push('**Sub-agent 3/3**: `src/sub-agents/nl-query/`', '');
  if (!result.queryAnswer) {
    lines.push('_No NL query in pipeline request — set `--question`._');
    return lines.join('\n');
  }
  const a = result.queryAnswer;
  lines.push(`**Question:** ${opts.question}`, '');
  lines.push('## Answer', '');
  lines.push(a.answer, '');
  if (Object.keys(a.supportingNumbers).length > 0) {
    lines.push('## Supporting numbers', '');
    lines.push('| Key | Value |');
    lines.push('|---|---|');
    for (const [k, v] of Object.entries(a.supportingNumbers)) {
      lines.push(`| \`${k}\` | ${v} |`);
    }
    lines.push('');
  }
  if (a.citedTxHashes.length > 0) {
    lines.push('## Cited transactions', '');
    for (const h of a.citedTxHashes.slice(0, 10)) {
      lines.push(`- \`${h}\``);
    }
    lines.push('');
  }
  lines.push(`Pipeline duration: **${result.durationMs} ms**`);
  return lines.join('\n');
}

// ─── Tiny helpers ──────────────────────────────────────────────────────────

function fmtDate(ts: number): string {
  return new Date(ts * 1000).toISOString().slice(0, 10);
}

function fmtLeg(leg: { symbol: string; amount: string; priceUsd: number } | undefined): string {
  if (!leg) return '—';
  // Convert decimal-string amount to a human-friendly number (demo only —
  // production code preserves full precision).
  const n = Number(leg.amount) / 1e18;
  return `${n.toFixed(2)} ${leg.symbol} ($${leg.priceUsd.toFixed(2)})`;
}

// ─── Main ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const modes: Mode[] = opts.mode === 'all' ? ['rules', 'pnl', 'ask'] : [opts.mode];
  for (let i = 0; i < modes.length; i++) {
    const mode = modes[i]!;
    const result = await runOnce(mode);
    if (mode === 'rules') {
      console.info(renderRules(result));
    } else if (mode === 'pnl') {
      console.info(renderPnl(result));
    } else {
      console.info(renderAsk(result));
    }
    if (i < modes.length - 1) console.info('\n---\n');
  }
}

main().catch((err) => {
  console.error('Demo failed:', err);
  process.exit(1);
});
