/**
 * Integration test: generate_tax_report tool on demo wallet 0x4678…1c25.
 *
 * Run: cd mcp-server && node test/test-generate-tax-report.ts
 * Skip: if CELOSCAN_API_KEY is not set.
 *
 * Pattern: JSON-RPC 2.0 client over stdio — mirrors test-tools-direct.ts.
 */

import 'dotenv/config';
import { spawn } from 'child_process';

const DEMO_ADDRESS = '0x46788b60daf46448668c7abaeea4ac8745451c25';
const TAX_YEAR = 2025;

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
  const res = await recvJson(20000);
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
    clientInfo: { name: 'test-generate-tax-report', version: '0.1.0' },
  }));
  await recvJson(6000);
  await sendRaw(jsonRequest('notifications/initialized', {}));

  console.log('\n=== generate_tax_report integration test ===');
  console.log(`Wallet: ${DEMO_ADDRESS}`);
  console.log(`Tax year: ${TAX_YEAR}\n`);

  // ── NG FIFO ────────────────────────────────────────────────────────────────
  console.log('[Test 1] NG FIFO + format=both...');
  const ngResult = await toolsCall('generate_tax_report', {
    address: DEMO_ADDRESS,
    taxYear: TAX_YEAR,
    jurisdiction: 'NG',
    method: 'FIFO',
    outputFormat: 'both',
  }) as Record<string, unknown>;

  if ('error' in ngResult) {
    console.error('[FAIL] NG result returned error:', ngResult.error, (ngResult as { message?: string }).message);
    process.exit(1);
  }

  console.log(`  schema:      ${ngResult.schema}`);
  console.log(`  rowCount:   ${ngResult.rowCount}`);
  console.log(`  filename:   ${ngResult.filename}`);
  console.log(`  has csv:    ${Boolean(ngResult.csv)}`);
  console.log(`  has csvBase64: ${Boolean(ngResult.csvBase64)}`);
  console.log(`  has report: ${Boolean(ngResult.report)}`);
  console.log(`  has summary: ${Boolean(ngResult.summary)}`);
  console.log(`  has taxDue: ${Boolean(ngResult.taxDue)}`);
  console.log(`  disclaimer: ${String(ngResult.disclaimer ?? '').slice(0, 60)}…`);

  if (typeof ngResult.csv !== 'string' || !ngResult.csv.length) {
    console.error('[FAIL] csv is empty');
    process.exit(1);
  }

  const firstLine = (ngResult.csv as string).split('\n')[0]!;
  const expectedHeaders = ['tx_date', 'type', 'asset', 'amount', 'price_ngn'];
  for (const h of expectedHeaders) {
    if (!firstLine.includes(h)) {
      console.error(`[FAIL] CSV header missing expected column "${h}": ${firstLine}`);
      process.exit(1);
    }
  }
  console.log(`  CSV header OK: ${firstLine}`);

  // Base64 round-trip
  const decoded = Buffer.from(ngResult.csvBase64 as string, 'base64').toString('utf-8');
  if (decoded !== ngResult.csv) {
    console.error('[FAIL] csvBase64 does not round-trip to csv');
    process.exit(1);
  }
  console.log('  Base64 round-trip OK');

  // ── KE ─────────────────────────────────────────────────────────────────────
  console.log('\n[Test 2] KE FIFO...');
  const keResult = await toolsCall('generate_tax_report', {
    address: DEMO_ADDRESS,
    taxYear: TAX_YEAR,
    jurisdiction: 'KE',
    method: 'FIFO',
    outputFormat: 'csv',
  }) as Record<string, unknown>;

  if ('error' in keResult) {
    console.error('[FAIL] KE result returned error:', keResult.error);
    process.exit(1);
  }
  console.log(`  schema:   ${keResult.schema}`);
  console.log(`  rowCount: ${keResult.rowCount}`);
  if (typeof keResult.csv !== 'string' || !keResult.csv.includes('dat_due_kes')) {
    console.error('[FAIL] KE CSV missing dat_due_kes column');
    process.exit(1);
  }
  console.log('  KE CSV OK (has dat_due_kes column)');

  // ── OTHER / CARF ────────────────────────────────────────────────────────────
  console.log('\n[Test 3] OTHER (CARF)...');
  const otherResult = await toolsCall('generate_tax_report', {
    address: DEMO_ADDRESS,
    taxYear: TAX_YEAR,
    jurisdiction: 'OTHER',
    method: 'FIFO',
    outputFormat: 'csv',
  }) as Record<string, unknown>;

  if ('error' in otherResult) {
    console.error('[FAIL] OTHER result returned error:', otherResult.error);
    process.exit(1);
  }
  console.log(`  schema: ${otherResult.schema}`);
  if (typeof otherResult.csv !== 'string' || !otherResult.csv.includes('reporting_period')) {
    console.error('[FAIL] OTHER CSV missing reporting_period column');
    process.exit(1);
  }
  console.log('  OTHER/CARF CSV OK');

  // ── Invalid input ───────────────────────────────────────────────────────────
  console.log('\n[Test 4] Invalid input...');
  const invalidResult = await toolsCall('generate_tax_report', {
    address: 'not-an-address',
    taxYear: TAX_YEAR,
  }) as Record<string, unknown>;

  if (!('error' in invalidResult) || invalidResult.error !== 'INVALID_INPUT') {
    console.error('[FAIL] Expected INVALID_INPUT for bad address, got:', invalidResult);
    process.exit(1);
  }
  console.log('  INVALID_INPUT correctly returned for bad address');

  console.log('\n[PASS] All tests passed');
  cp.kill();
  process.exit(0);
}

run().catch((e) => {
  console.error('[FAIL]', e);
  cp.kill();
  process.exit(1);
});
