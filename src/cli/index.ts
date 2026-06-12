/**
 * Agent 06 CLI — real-wallet entrypoint (`pnpm dev`).
 *
 * Owner: Credio (cli).
 *
 * Runs the full production pipeline against a live Celo wallet and writes
 * a tax-ready CSV. Replaces the placeholder that the README quickstart
 * referenced.
 *
 * Usage:
 *   pnpm dev -- --address 0xYourWallet --jurisdiction NG --tax-year 2024
 *
 * Flags:
 *   --address <addr>           Wallet to analyze (required)
 *   --jurisdiction <NG|KE|OTHER>  Tax regime (default: NG)
 *   --tax-year <year>          Tax year (default: last calendar year)
 *   --method <FIFO|LIFO|WAC>   Cost-basis method (default: FIFO)
 *   --emit-onchain-log         Broadcast a 0-value self-tx on Celo (Track 2)
 *   --nl-query <question>      Optional natural-language Q&A against the report
 *   --output <file.csv>        Where to write the CSV (default: ./<agent-06>-<year>.csv)
 *   --refresh                  Bypass the tx-fetcher cache
 *
 * Output is markdown on stdout, CSV written to the output path.
 * Exit 0 on success, 1 on any pipeline error.
 */

import { Command } from 'commander';
import Anthropic from '@anthropic-ai/sdk';
import { runPipeline } from '../orchestrator/pipeline.js';
import { makeProductionDeps } from '../orchestrator/production.js';
import { makeContractLookup } from '../shared/contracts.js';
import { loadConfig } from '../shared/config.js';
import { type LlmFallbackDeps } from '../sub-agents/tx-classifier/index.js';
import { type AnswerQueryDeps } from '../sub-agents/nl-query/index.js';
import { AgentError } from '../shared/errors.js';
import type {
  Jurisdiction,
  CostBasisMethod,
  PipelineRequest,
  PipelineResult,
} from '../shared/types.js';

const program = new Command();

program
  .name('agent-06')
  .description('Celo onchain tax & portfolio agent — produces a tax-ready CSV for a Celo wallet.')
  .requiredOption('--address <addr>', 'Celo wallet address to analyze')
  .option('--jurisdiction <NG|KE|OTHER>', 'Tax regime', 'NG')
  .option('--tax-year <year>', 'Tax year', String(new Date().getUTCFullYear() - 1))
  .option('--method <FIFO|LIFO|WAC>', 'Cost-basis method', 'FIFO')
  .option('--emit-onchain-log', 'Broadcast a 0-value self-tx on Celo (Track 2)', false)
  .option('--nl-query <question>', 'Optional natural-language Q&A against the report')
  .option('--output <file>', 'CSV output path', './agent-06-report.csv')
  .option('--refresh', 'Bypass the tx-fetcher cache', false)
  .showHelpAfterError();

interface ParsedArgs {
  address: `0x${string}`;
  jurisdiction: Jurisdiction;
  taxYear: number;
  method: CostBasisMethod;
  emitOnchainLog: boolean;
  nlQuery: string | undefined;
  output: string;
  refresh: boolean;
}

function parseArgs(): ParsedArgs {
  const opts = program.parse(process.argv).opts();
  return {
    address: opts.address as `0x${string}`,
    jurisdiction: opts.jurisdiction as Jurisdiction,
    taxYear: parseInt(opts.taxYear, 10),
    method: opts.method as CostBasisMethod,
    emitOnchainLog: Boolean(opts.emitOnchainLog),
    nlQuery: opts.nlQuery as string | undefined,
    output: opts.output as string,
    refresh: Boolean(opts.refresh),
  };
}

function buildLlmDeps(config: { anthropicModel?: string }): LlmFallbackDeps | undefined {
  // The classifier's LLM fallback is optional — if no key is set, the
  // rule-based path covers everything the registry knows about.
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return undefined;
  const client = new Anthropic({ apiKey: key });
  return {
    client,
    model: config.anthropicModel ?? 'claude-sonnet-4-6',
  };
}

function buildAnswerDeps(config: { anthropicModel?: string }): AnswerQueryDeps {
  // NL-query always needs an LLM. With no key, the orchestrator will still
  // run but answerQueryWithDeps will return a graceful fallback ("could not
  // reach the language model") — surfaced to the user.
  const key = process.env.ANTHROPIC_API_KEY;
  const client = new Anthropic({ apiKey: key ?? 'sk-no-key-set' });
  return { llm: { client, model: config.anthropicModel ?? 'claude-sonnet-4-6' } };
}

function formatResult(r: PipelineResult, args: ParsedArgs): string {
  const lines: string[] = [];
  lines.push(`# Agent 06 — ${args.address}`);
  lines.push('');
  lines.push(`- **Jurisdiction:** ${args.jurisdiction}`);
  lines.push(`- **Tax year:** ${args.taxYear}`);
  lines.push(`- **Method:** ${args.method}`);
  lines.push(`- **Txns (raw):** ${r.fetched.rawTxns.length}`);
  lines.push(`- **Txns (token transfers):** ${r.fetched.tokenTransfers.length}`);
  lines.push(`- **Txns (internal):** ${r.fetched.internalTxns.length}`);
  lines.push(
    `- **Classified:** ${r.classified.classified.length} ` +
      `(${r.classified.ruleHits} rules, ` +
      `${r.classified.protocolDecoderHits ?? 0} rule-protocol, ` +
      `${r.classified.llmFallbacks} LLM)`,
  );
  lines.push(`- **Flagged for review:** ${r.classified.flaggedForReview.length}`);
  if (r.fetched.fetchErrors.length > 0) {
    lines.push(`- **Fetch errors:** ${r.fetched.fetchErrors.length}`);
  }
  lines.push(`- **CSV:** ${r.csv.filename} (${r.csv.rowCount} rows, ${r.csv.schema})`);
  lines.push(`- **Duration:** ${r.durationMs}ms`);
  if (r.onchainLogTxHash) {
    lines.push(`- **Onchain log:** \`${r.onchainLogTxHash}\``);
  }
  // Year summary
  const yr = r.pnl.taxYears.find((y) => y.year === args.taxYear);
  if (yr) {
    lines.push('');
    lines.push(`## ${args.taxYear} tax summary`);
    lines.push(`- **Realized gains:** $${yr.realizedGains.toFixed(2)}`);
    lines.push(`- **Income:** $${yr.income.toFixed(2)}`);
    lines.push(`- **Yield:** $${yr.yield.toFixed(2)}`);
    lines.push(`- **Deductible gas:** $${yr.deductibleGas.toFixed(2)}`);
    lines.push(`- **Taxable income:** $${yr.taxableIncome.toFixed(2)}`);
  }
  if (r.queryAnswer) {
    lines.push('');
    lines.push(`## NL answer`);
    lines.push(r.queryAnswer.answer);
  }
  return lines.join('\n');
}

async function main(): Promise<void> {
  const args = parseArgs();

  const config = loadConfig();
  const network = config.network;

  const request: PipelineRequest = {
    address: args.address,
    jurisdiction: args.jurisdiction,
    method: args.method,
    taxYear: args.taxYear,
    ...(args.emitOnchainLog && { emitOnchainLog: true }),
    ...(args.nlQuery !== undefined && args.nlQuery !== '' && { nlQuery: args.nlQuery }),
  };

  const deps = makeProductionDeps({
    config,
    ...(buildLlmDeps(config) !== undefined && { classifierLlmDeps: buildLlmDeps(config)! }),
    nlQueryDeps: buildAnswerDeps(config),
    refresh: args.refresh,
  });

  try {
    const result = await runPipeline({
      request,
      deps,
      network,
      contractLookup: makeContractLookup(network),
    });

    // Write CSV
    const fs = await import('node:fs/promises');
    await fs.writeFile(args.output, result.csv.csv, 'utf-8');

    // Print markdown summary
    process.stdout.write(formatResult(result, args) + '\n');
    process.stdout.write(`\nCSV written to: ${args.output}\n`);
    process.exit(0);
  } catch (err) {
    if (err instanceof AgentError) {
      process.stderr.write(`[${err.code}] ${err.message}\n`);
    } else {
      process.stderr.write(`[UNEXPECTED] ${err instanceof Error ? err.message : String(err)}\n`);
    }
    process.exit(1);
  }
}

// Silence the unused-import linter for LlmFallbackDeps when the env lacks a key.
void (0 as unknown as LlmFallbackDeps);

void main();
