/**
 * Integration test for calculate_tax_liability tool.
 * Tests against demo wallet 0x4678…1c25, jurisdiction=NG, taxYear=2025.
 * Skips if CELOSCAN_API_KEY is not set.
 */

import { spawn } from 'child_process';

const DEMO = '0x46788b60daf46448668c7abaeea4ac8745451c25';
let id = 1;
const req = (m: string, p: object) => JSON.stringify({ jsonrpc:'2.0', id: id++, method: m, params: p }) + '\n';

async function main() {
  if (!process.env.CELOSCAN_API_KEY) {
    console.log('SKIP: CELOSCAN_API_KEY not set'); process.exit(0);
  }

  const proc = spawn('npx', ['tsx', 'src/server.ts'], { cwd: process.cwd(), stdio: ['pipe','pipe','pipe'] });
  const buf: string[] = [];
  proc.stdout?.on('data', (d: Buffer) => buf.push(d.toString()));
  proc.stderr?.on('data', (d: Buffer) => console.error('[server]', d.toString()));
  await new Promise<void>(r => setTimeout(r, 4000));

  if (proc.exitCode !== null) { console.error('Server died early'); process.exit(1); }

  function drain() { const s = buf.join(''); buf.splice(0, buf.length); return s; }
  const send = (s: string) => proc.stdin?.write(s);

  // tools/list
  send(req('tools/list', {}));
  await new Promise<void>(r => setTimeout(r, 1000));
  drain(); console.log('[tools/list] OK');

  // calculate_tax_liability
  send(req('tools/call', { name: 'calculate_tax_liability', arguments: { address: DEMO, taxYear: 2025, jurisdiction: 'NG', method: 'FIFO' } }));
  await new Promise<void>(r => setTimeout(r, 10000));

  const raw = drain();
  let result: Record<string, unknown> | null = null;
  let error: Record<string, unknown> | null = null;
  for (const line of raw.trim().split('\n')) {
    try { const p = JSON.parse(line); if (p.result) result = p.result as Record<string, unknown>; if (p.error) error = p.error as Record<string, unknown>; } catch { /* skip */ }
  }

  if (error) { console.error('ERROR:', JSON.stringify(error)); proc.kill(); process.exit(1); }
  if (!result) { console.error('No result. Raw:', raw); proc.kill(); process.exit(1); }

  const s = result.summary as Record<string, unknown>;
  const td = result.taxDue as Record<string, unknown>;
  const pa = result.perAsset as Record<string, unknown>;

  const checks: [string, boolean][] = [
    ['realizedGainsUsd is finite number', typeof s?.realizedGainsUsd === 'number' && Number.isFinite(s?.realizedGainsUsd)],
    ['incomeUsd is finite number', typeof s?.incomeUsd === 'number' && Number.isFinite(s?.incomeUsd)],
    ['taxableIncomeUsd is finite number', typeof s?.taxableIncomeUsd === 'number' && Number.isFinite(s?.taxableIncomeUsd)],
    ['NG cgtUsd is finite number', typeof td?.cgtUsd === 'number' && Number.isFinite(td?.cgtUsd)],
    ['NG cgtNgn is finite number', typeof td?.cgtNgn === 'number' && Number.isFinite(td?.cgtNgn)],
    ['perAsset is non-empty object', !!pa && typeof pa === 'object' && Object.keys(pa).length > 0],
    ['disposalsCount >= 0', typeof result?.disposalsCount === 'number' && result?.disposalsCount >= 0],
    ['methodJurisdictionCompat is array', Array.isArray(result?.methodJurisdictionCompat)],
  ];

  let passed = 0;
  for (const [label, ok] of checks) {
    console.log(`${ok ? '✓' : '✗'} ${label}`);
    if (ok) passed++;
  }

  console.log(`\n${passed}/${checks.length} checks passed`);
  proc.kill();
  process.exit(passed === checks.length ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
