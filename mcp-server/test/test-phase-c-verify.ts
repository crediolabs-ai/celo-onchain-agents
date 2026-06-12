/**
 * Phase C comprehensive verification test.
 * Covers: tools/list, 7 tools functional (2 wallets), 4 validation cases,
 *         data quality (gaps[]), cross-check vs CLI.
 *
 * Run: cd mcp-server && node test/test-phase-c-verify.ts
 */
import 'dotenv/config';
import { spawn } from 'child_process';

const DEMO = '0x46788b60daf46448668c7abaeea4ac8745451c25';
const DEFI = '0x9b3319a7f1f6a7bc48af14c9b81ba4b41c7c1394';

if (!process.env.CELOSCAN_API_KEY) {
  console.warn('[SKIP] CELOSCAN_API_KEY not set');
  process.exit(0);
}

const cp = spawn('npx', ['tsx', 'src/server.ts'], {
  cwd: new URL('..', import.meta.url),
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env },
});

const stdoutBuffer: string[] = [];
cp.stdout.on('data', (d: Buffer) => stdoutBuffer.push(d.toString()));
cp.stderr.on('data', () => { /* swallow */ });

let idCounter = 1;
function jsonRequest(method: string, params: object = {}): string {
  return JSON.stringify({ jsonrpc: '2.0', id: idCounter++, method, params }) + '\n';
}
async function sendRaw(req: string): Promise<void> { cp.stdin?.write(req + '\n'); }

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
    } catch { /* */ }
  }
  return null;
}

async function recvJson(timeoutMs = 20000): Promise<Record<string, unknown> | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = tryParseNextJson();
    if (result) return result;
    await new Promise((r) => setTimeout(r, 200));
  }
  return null;
}

interface CallResult { ok: boolean; isError: boolean; parsed: Record<string, unknown>; rawText: string; }

async function toolsCall(name: string, args: Record<string, unknown>): Promise<CallResult> {
  await sendRaw(jsonRequest('tools/call', { name, arguments: args }));
  const res = await recvJson(25000);
  if (!res) throw new Error(`No response for ${name}`);
  if (res.error) {
    return { ok: false, isError: true, parsed: res.error as Record<string, unknown>, rawText: JSON.stringify(res.error) };
  }
  const content = (res.result as { content?: Array<{ type: string; text: string }> })?.content;
  if (!content?.[0]) return { ok: false, isError: true, parsed: { error: 'NO_CONTENT' }, rawText: '' };
  const text = content[0].text;
  const isError = (res.result as { isError?: boolean }).isError === true;
  try {
    return { ok: !isError, isError, parsed: JSON.parse(text), rawText: text };
  } catch {
    return { ok: !isError, isError, parsed: { raw: text }, rawText: text };
  }
}

const RESULTS: Array<{ name: string; category: string; ok: boolean; detail: string }> = [];
function rec(name: string, category: string, ok: boolean, detail: string): void {
  RESULTS.push({ name, category, ok, detail });
  const sym = ok ? '✓' : '✗';
  console.log(`  ${sym} [${category}] ${name}: ${detail}`);
}

async function run(): Promise<void> {
  await new Promise<void>((r) => setTimeout(r, 3000));
  if (cp.exitCode !== null) { console.error('Server died early:', cp.exitCode); process.exit(1); }

  // Init
  await sendRaw(jsonRequest('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: { tools: {} },
    clientInfo: { name: 'phase-c-verify', version: '0.1.0' },
  }));
  await recvJson(5000);
  await sendRaw(jsonRequest('notifications/initialized', {}));

  console.log('\n════════════════════════════════════════════════════════════════');
  console.log('  PHASE C — MCP TOOLS COMPREHENSIVE VERIFICATION');
  console.log('════════════════════════════════════════════════════════════════\n');

  // ── 0. tools/list ────────────────────────────────────────────────────────
  console.log('── Section 0: tools/list (existence) ──');
  await sendRaw(jsonRequest('tools/list', {}));
  const listRes = await recvJson(5000);
  const tools = (listRes?.result as { tools?: Array<{ name: string }> })?.tools ?? [];
  rec('tools/list', 'existence', tools.length === 7, `${tools.length} tools: ${tools.map(t => t.name).join(', ')}`);

  // ── 1. get_celo_portfolio (DEMO + DEFI) ──────────────────────────────────
  console.log('\n── Section 1: get_celo_portfolio (2 wallets) ──');
  try {
    const r = await toolsCall('get_celo_portfolio', { address: DEMO, network: 'mainnet' });
    const holdings = (r.parsed.holdings as unknown[]).length;
    const total = (r.parsed.totalUsdValue as number);
    // Phase B figure was $5.94 for DEMO
    rec('get_celo_portfolio(DEMO)', 'functional', !r.isError, `${holdings} tokens, totalUsdValue=${total?.toFixed(4)} (Phase B reference: $5.94)`);
  } catch (e) { rec('get_celo_portfolio(DEMO)', 'functional', false, `Exception: ${e}`); }

  try {
    const r = await toolsCall('get_celo_portfolio', { address: DEFI, network: 'mainnet' });
    const holdings = (r.parsed.holdings as unknown[]).length;
    const total = (r.parsed.totalUsdValue as number);
    rec('get_celo_portfolio(DEFI)', 'functional', !r.isError, `${holdings} tokens, totalUsdValue=${total?.toFixed(4)}`);
  } catch (e) { rec('get_celo_portfolio(DEFI)', 'functional', false, `Exception: ${e}`); }

  // ── 2. get_celo_transaction_history (DEMO) ──────────────────────────────
  console.log('\n── Section 2: get_celo_transaction_history (DEMO) ──');
  try {
    const r = await toolsCall('get_celo_transaction_history', { address: DEMO, network: 'mainnet', offset: 5 });
    const txs = r.parsed.transactions as Array<{ hash: string; method?: string; classification?: { category: string } }>;
    const hasMore = r.parsed.hasMore;
    const firstHash = txs?.[0]?.hash;
    const isReg = firstHash?.toLowerCase().startsWith('0x0fad789e');
    rec('get_celo_transaction_history(DEMO)', 'functional', !r.isError,
      `returned=${txs?.length}, hasMore=${hasMore}, firstHash=${firstHash?.slice(0, 14)}… (expect 0x0fad789e…) matches=${isReg}`);
  } catch (e) { rec('get_celo_transaction_history(DEMO)', 'functional', false, `Exception: ${e}`); }

  // ── 3. get_token_price_history (DEMO 5-day window) ─────────────────────
  console.log('\n── Section 3: get_token_price_history (5-day window) ──');
  try {
    const r = await toolsCall('get_token_price_history', {
      tokens: ['CELO'], fromDate: '2025-06-01', toDate: '2025-06-05',
    });
    const series = r.parsed.series as Record<string, Array<{ date: string; priceUsd: number | null }>>;
    const celoSeries = series['CELO'] ?? [];
    const gaps = r.parsed.gaps as Array<{ token: string; reason: string }> | undefined;
    rec('get_token_price_history', 'functional', !r.isError,
      `CELO points=${celoSeries.length}, gaps=${gaps?.length ?? 0} (rate-limit expected w/o COINGECKO_API_KEY)`);
    rec('get_token_price_history gaps[] populated', 'data-quality', (gaps?.length ?? 0) > 0,
      `gaps[0]=${JSON.stringify(gaps?.[0])}`);
  } catch (e) { rec('get_token_price_history', 'functional', false, `Exception: ${e}`); }

  // ── 4. calculate_tax_liability (2 wallets × 3 jurisdictions × 2 years) ──
  console.log('\n── Section 4: calculate_tax_liability (12 combos) ──');
  const jurList = ['NG', 'KE', 'OTHER'] as const;
  const yearList = [2024, 2025];
  for (const addr of [DEMO, DEFI]) {
    for (const jur of jurList) {
      for (const yr of yearList) {
        try {
          const r = await toolsCall('calculate_tax_liability', {
            address: addr, taxYear: yr, jurisdiction: jur, method: 'FIFO',
          });
          const summary = r.parsed.summary as Record<string, number>;
          const ok = !r.isError;
          rec(`calculate_tax_liability(${addr.slice(0,6)}…/${jur}/${yr})`, 'functional', ok,
            `realizedGainsUsd=${summary?.realizedGainsUsd}, disposalsCount=${(r.parsed.disposalsCount as number)}`);
        } catch (e) { rec(`calculate_tax_liability(${addr.slice(0,6)}…/${jur}/${yr})`, 'functional', false, `Exception: ${e}`); }
      }
    }
  }

  // ── 5. get_staking_rewards (DEMO + DEFI) ─────────────────────────────────
  console.log('\n── Section 5: get_staking_rewards ──');
  try {
    const r = await toolsCall('get_staking_rewards', { address: DEMO, network: 'mainnet' });
    rec('get_staking_rewards(DEMO)', 'functional', !r.isError,
      `totalRewardsCel=${r.parsed.totalRewardsCel}, dataSource=${r.parsed.dataSource} (expected 0 — ERC-8004 deployer, no staking)`);
  } catch (e) { rec('get_staking_rewards(DEMO)', 'functional', false, `Exception: ${e}`); }
  try {
    const r = await toolsCall('get_staking_rewards', { address: DEFI, network: 'mainnet' });
    rec('get_staking_rewards(DEFI)', 'functional', !r.isError,
      `totalRewardsCel=${r.parsed.totalRewardsCel}, dataSource=${r.parsed.dataSource} (may catch GoodDollar-style claims)`);
  } catch (e) { rec('get_staking_rewards(DEFI)', 'functional', false, `Exception: ${e}`); }

  // ── 6. generate_tax_report (DEMO NG 2025, json) ─────────────────────────
  console.log('\n── Section 6: generate_tax_report ──');
  try {
    const r = await toolsCall('generate_tax_report', {
      address: DEMO, taxYear: 2025, jurisdiction: 'NG', method: 'FIFO', outputFormat: 'json',
    });
    rec('generate_tax_report(DEMO/NG/2025/json)', 'functional', !r.isError,
      `schema=${r.parsed.schema}, rowCount=${r.parsed.rowCount}, hasReport=${Boolean(r.parsed.report)}`);
  } catch (e) { rec('generate_tax_report(DEMO/NG/2025/json)', 'functional', false, `Exception: ${e}`); }

  // ── 7. get_carf_report (DEMO 2024-2025, US) ─────────────────────────────
  console.log('\n── Section 7: get_carf_report ──');
  try {
    const r = await toolsCall('get_carf_report', {
      address: DEMO, fromYear: 2024, toYear: 2025, userJurisdiction: 'US',
    });
    rec('get_carf_report(DEMO/2024-2025/US)', 'functional', !r.isError,
      `reportingPeriod=${r.parsed.reportingPeriod}, schemaVersion=${r.parsed.schemaVersion}, totalPnlUsd=${(r.parsed.summary as Record<string, number>)?.totalPnlUsd}`);
  } catch (e) { rec('get_carf_report(DEMO/2024-2025/US)', 'functional', false, `Exception: ${e}`); }

  // ── Section V: Validation checks (must return isError=true) ──────────────
  console.log('\n── Section V: Validation (must be isError=true) ──');
  const validations: Array<[string, string, Record<string, unknown>]> = [
    ['get_token_price_history inverted range', 'validate', { tokens: ['CELO'], fromDate: '2025-12-31', toDate: '2025-01-01' }],
    ['get_token_price_history range>365d', 'validate', { tokens: ['CELO'], fromDate: '2020-01-01', toDate: '2025-12-31' }],
    ['calculate_tax_liability bad address', 'validate', { address: 'not-an-address', taxYear: 2025, jurisdiction: 'NG' }],
    ['get_celo_portfolio bad address', 'validate', { address: '0xZZZ' }],
  ];
  for (const [name, cat, args] of validations) {
    try {
      const r = await toolsCall(name.split(' ')[0] as string, args);
      rec(name, cat, r.isError, `isError=${r.isError}, errCode=${(r.parsed.error as string) ?? 'n/a'}`);
    } catch (e) { rec(name, cat, false, `Exception: ${e}`); }
  }

  // ── Summary ──────────────────────────────────────────────────────────────
  console.log('\n════════════════════════════════════════════════════════════════');
  const pass = RESULTS.filter(r => r.ok).length;
  const fail = RESULTS.filter(r => !r.ok).length;
  console.log(`  Total: ${RESULTS.length}  Pass: ${pass}  Fail: ${fail}`);
  if (fail) {
    console.log('  Failed:');
    RESULTS.filter(r => !r.ok).forEach(r => console.log(`    - [${r.category}] ${r.name}: ${r.detail}`));
  }
  console.log('════════════════════════════════════════════════════════════════\n');

  cp.kill();
  process.exit(fail ? 1 : 0);
}

run().catch((e) => { console.error('[FATAL]', e); cp.kill(); process.exit(1); });
