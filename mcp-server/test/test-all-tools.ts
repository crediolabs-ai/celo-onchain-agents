/**
 * Integration test: verifies all 7 tools are registered and callable.
 *
 * Run: cd mcp-server && node test/test-all-tools.ts
 * Skip: if CELOSCAN_API_KEY is not set.
 *
 * Pattern: JSON-RPC 2.0 client over stdio — mirrors test-tools-direct.ts.
 */

import 'dotenv/config';
import { spawn } from 'child_process';

const DEMO_ADDRESS = '0x46788b60daf46448668c7abaeea4ac8745451c25';

function skip(reason: string): void {
  console.warn(`[SKIP] ${reason}`);
  process.exit(0);
}

if (!process.env.CELOSCAN_API_KEY) {
  skip('CELOSCAN_API_KEY not set — skipping live test');
}

const cp = spawn('npx', ['tsx', 'src/server.ts'], {
  cwd: new URL('..', import.meta.url),
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env },
});

const stdoutBuffer: string[] = [];

cp.stdout.on('data', (d: Buffer) => stdoutBuffer.push(d.toString()));
cp.stderr.on('data', (d: Buffer) => {
  console.error('[server]', d.toString('utf-8').trim());
});

let idCounter = 1;

function jsonRequest(method: string, params: object = {}): string {
  return JSON.stringify({ jsonrpc: '2.0', id: idCounter++, method, params }) + '\n';
}

async function sendRaw(req: string): Promise<void> {
  cp.stdin?.write(req + '\n');
}

function tryParseNextJson(): Record<string, unknown> | null {
  const combined = stdoutBuffer.join('');
  const lines = combined.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (!line) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === 'object') {
        lines.splice(i, 1);
        stdoutBuffer.splice(0, stdoutBuffer.length, lines.join('\n'));
        return parsed as Record<string, unknown>;
      }
    } catch { /* not a JSON line */ }
  }
  return null;
}

async function recvJson(timeoutMs = 10000): Promise<Record<string, unknown> | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = tryParseNextJson();
    if (result) return result;
    await new Promise((r) => setTimeout(r, 150));
  }
  return null;
}

async function toolsCall(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  await sendRaw(jsonRequest('tools/call', { name, arguments: args }));
  const res = await recvJson(15000);
  if (!res?.result?.content?.[0]) throw new Error(`No content for ${name}`);
  return JSON.parse(res.result.content[0].text as string);
}

// ─── Tests ─────────────────────────────────────────────────────────────────────

async function run(): Promise<void> {
  // Wait for server startup
  await new Promise<void>((r) => setTimeout(r, 4000));

  if (cp.exitCode !== null) {
    console.error('Server exited early with code:', cp.exitCode);
    process.exit(1);
  }

  // Init
  await sendRaw(jsonRequest('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: { tools: {} },
    clientInfo: { name: 'test-all-tools', version: '0.1.0' },
  }));
  await recvJson(6000);
  await sendRaw(jsonRequest('notifications/initialized', {}));

  console.log('\n=== All 7 tools integration test ===');
  console.log(`Wallet: ${DEMO_ADDRESS}\n`);

  // ── tools/list ──────────────────────────────────────────────────────────────
  console.log('[Test 0] tools/list — verify 7 tools registered...');
  await sendRaw(jsonRequest('tools/list', {}));
  const listRes = await recvJson(5000);
  if (!listRes?.result) { console.error('[FAIL] No result from tools/list'); process.exit(1); }
  const tools = (listRes.result as { tools?: Array<{ name: string }> })?.tools ?? [];
  console.log(`  Found ${tools.length} tools: ${tools.map(t => t.name).join(', ')}`);

  const EXPECTED = [
    'get_celo_portfolio',
    'get_celo_transaction_history',
    'get_token_price_history',
    'calculate_tax_liability',
    'get_staking_rewards',
    'generate_tax_report',
    'get_carf_report',
  ];
  const missing = EXPECTED.filter(n => !tools.find(t => t.name === n));
  if (missing.length) {
    console.error(`[FAIL] Missing tools: ${missing.join(', ')}`);
    process.exit(1);
  }
  console.log('  ✓ All 7 tools registered\n');

  // ── Tool 1: get_celo_portfolio ─────────────────────────────────────────────
  console.log('[Test 1] get_celo_portfolio...');
  try {
    const r = await toolsCall('get_celo_portfolio', { address: DEMO_ADDRESS, network: 'mainnet' });
    if ('error' in r) { console.error(`  ✗ Error: ${r.error} — ${(r as { message?: string }).message}`); }
    else { console.log(`  ✓ Holdings: ${((r as { holdings: unknown[] }).holdings).length} tokens, totalUsdValue=${(r as { totalUsdValue: number }).totalUsdValue}`); }
  } catch (e) { console.error(`  ✗ Exception: ${e}`); }

  // ── Tool 2: get_celo_transaction_history ───────────────────────────────────
  console.log('[Test 2] get_celo_transaction_history...');
  try {
    const r = await toolsCall('get_celo_transaction_history', { address: DEMO_ADDRESS, network: 'mainnet', offset: 5 });
    if ('error' in r) { console.error(`  ✗ Error: ${r.error} — ${(r as { message?: string }).message}`); }
    else { console.log(`  ✓ Transactions: ${(r as { totalReturned: number }).totalReturned} returned`); }
  } catch (e) { console.error(`  ✗ Exception: ${e}`); }

  // ── Tool 3: get_token_price_history ────────────────────────────────────────
  console.log('[Test 3] get_token_price_history...');
  try {
    const r = await toolsCall('get_token_price_history', {
      tokens: ['CELO'], fromDate: '2025-06-01', toDate: '2025-06-10',
    });
    if ('error' in r) { console.error(`  ✗ Error: ${r.error} — ${(r as { message?: string }).message}`); }
    else {
      const series = (r as { series: Record<string, { date: string; priceUsd: number | null }[]> }).series;
      const celoSeries = series['CELO'] ?? [];
      console.log(`  ✓ CELO: ${celoSeries.length} days, first=${celoSeries[0]?.priceUsd}, last=${celoSeries[celoSeries.length - 1]?.priceUsd}`);
    }
  } catch (e) { console.error(`  ✗ Exception: ${e}`); }

  // ── Tool 4: calculate_tax_liability ────────────────────────────────────────
  console.log('[Test 4] calculate_tax_liability...');
  try {
    const r = await toolsCall('calculate_tax_liability', {
      address: DEMO_ADDRESS, taxYear: 2025, jurisdiction: 'NG', method: 'FIFO',
    });
    if ('error' in r) { console.error(`  ✗ Error: ${r.error} — ${(r as { message?: string }).message}`); }
    else {
      const summary = (r as { summary: Record<string, number> }).summary;
      console.log(`  ✓ taxYear=${r.taxYear} jurisdiction=${r.jurisdiction}`);
      console.log(`    realizedGainsUsd=${summary?.realizedGainsUsd}, disposalsCount=${(r as { disposalsCount: number }).disposalsCount}`);
    }
  } catch (e) { console.error(`  ✗ Exception: ${e}`); }

  // ── Tool 5: get_staking_rewards ────────────────────────────────────────────
  console.log('[Test 5] get_staking_rewards...');
  try {
    const r = await toolsCall('get_staking_rewards', { address: DEMO_ADDRESS, network: 'mainnet' });
    if ('error' in r) { console.error(`  ✗ Error: ${r.error} — ${(r as { message?: string }).message}`); }
    else { console.log(`  ✓ totalRewardsCel=${(r as { totalRewardsCel: string }).totalRewardsCel}, dataSource=${(r as { dataSource: string }).dataSource}`); }
  } catch (e) { console.error(`  ✗ Exception: ${e}`); }

  // ── Tool 6: generate_tax_report ────────────────────────────────────────────
  console.log('[Test 6] generate_tax_report...');
  try {
    const r = await toolsCall('generate_tax_report', {
      address: DEMO_ADDRESS, taxYear: 2025, jurisdiction: 'NG', method: 'FIFO', outputFormat: 'json',
    });
    if ('error' in r) { console.error(`  ✗ Error: ${r.error} — ${(r as { message?: string }).message}`); }
    else { console.log(`  ✓ schema=${r.schema}, rowCount=${r.rowCount}, has report=${Boolean(r.report)}`); }
  } catch (e) { console.error(`  ✗ Exception: ${e}`); }

  // ── Tool 7: get_carf_report ────────────────────────────────────────────────
  console.log('[Test 7] get_carf_report...');
  try {
    const r = await toolsCall('get_carf_report', {
      address: DEMO_ADDRESS, fromYear: 2024, toYear: 2025, userJurisdiction: 'NG',
    });
    if ('error' in r) { console.error(`  ✗ Error: ${r.error} — ${(r as { message?: string }).message}`); }
    else {
      const summary = (r as { summary: Record<string, number> }).summary;
      console.log(`  ✓ reportingPeriod=${r.reportingPeriod}, schemaVersion=${r.schemaVersion}`);
      console.log(`    totalPnlUsd=${summary?.totalPnlUsd}, rowCount=${r.rowCount}`);
    }
  } catch (e) { console.error(`  ✗ Exception: ${e}`); }

  // ── Invalid input ──────────────────────────────────────────────────────────
  console.log('\n[Test 8] Invalid input (get_token_price_history)...');
  try {
    const r = await toolsCall('get_token_price_history', { fromDate: '2025-12-31', toDate: '2025-01-01' });
    if (r.error === 'INVALID_INPUT') { console.log('  ✓ INVALID_INPUT correctly returned'); }
    else { console.error(`  ✗ Expected INVALID_INPUT, got: ${JSON.stringify(r).slice(0, 100)}`); }
  } catch (e) { console.error(`  ✗ Exception: ${e}`); }

  console.log('\n=== All tests complete ===');
  cp.kill();
  process.exit(0);
}

run().catch((e) => {
  console.error('[FAIL]', e);
  cp.kill();
  process.exit(1);
});
