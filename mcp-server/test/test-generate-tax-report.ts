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

const DEMO_ADDRESS = '0x4678ed7b5747c8d033849a6a26ff6b3b1c25c25';
const TAX_YEAR = 2025;

function skip(reason: string): void {
  console.warn(`[SKIP] ${reason}`);
  process.exit(0);
}

if (!process.env.CELOSCAN_API_KEY) {
  skip('CELOSCAN_API_KEY not set — skipping live test');
}

const cp = spawn('npx', ['tsx', '-r', 'dotenv/config', '-'], {
  cwd: new URL('..', import.meta.url),
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env },
});

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: { content?: { text: string }[] };
  error?: { code: number; message: string };
}

let id = 1;
const pending = new Map<number, (r: JsonRpcResponse) => void>();

cp.stdout.on('data', (buf: Buffer) => {
  const lines = buf.toString('utf-8').trim().split('\n');
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const res = JSON.parse(line) as JsonRpcResponse;
      const resolve = pending.get(res.id);
      if (resolve) { pending.delete(res.id); resolve(res); }
    } catch { /* ignore parse errors */ }
  }
});

cp.stderr.on('data', (buf: Buffer) => {
  console.error('[server]', buf.toString('utf-8').trim());
});

function send(method: string, params: Record<string, unknown> = {}): Promise<JsonRpcResponse> {
  return new Promise((resolve) => {
    const req: JsonRpcRequest = { jsonrpc: '2.0', id: id++, method, params };
    pending.set(req.id, resolve);
    cp.stdin.write(JSON.stringify(req) + '\n');
  });
}

async function toolsCall(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await send('tools/call', { name, arguments: args });
  if (!res.result?.content?.[0]) throw new Error('No content in response');
  return JSON.parse(res.result.content[0].text);
}

// ─── Tests ─────────────────────────────────────────────────────────────────────

async function run(): Promise<void> {
  // Init
  await send('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: { tools: {} },
    clientInfo: { name: 'test-generate-tax-report', version: '0.1.0' },
  });
  await send('notifications/initialized');

  console.log('\n=== generate_tax_report integration test ===');
  console.log(`Wallet: ${DEMO_ADDRESS}`);
  console.log(`Tax year: ${TAX_YEAR}`);

  // ── NG FIFO ────────────────────────────────────────────────────────────────
  console.log('\n[Test 1] NG FIFO + format=both...');
  const ngResult = await toolsCall('generate_tax_report', {
    address: DEMO_ADDRESS,
    taxYear: TAX_YEAR,
    jurisdiction: 'NG',
    method: 'FIFO',
    outputFormat: 'both',
  }) as Record<string, unknown>;

  if ('error' in ngResult) {
    console.error('[FAIL] NG result returned error:', ngResult.error);
    process.exit(1);
  }

  console.log(`  schema:      ${ngResult.schema}`);
  console.log(`  rowCount:    ${ngResult.rowCount}`);
  console.log(`  filename:    ${ngResult.filename}`);
  console.log(`  has csv:     ${Boolean(ngResult.csv)}`);
  console.log(`  has csvBase64: ${Boolean(ngResult.csvBase64)}`);
  console.log(`  has report:  ${Boolean(ngResult.report)}`);
  console.log(`  has summary: ${Boolean(ngResult.summary)}`);
  console.log(`  has taxDue:  ${Boolean(ngResult.taxDue)}`);
  console.log(`  disclaimer:  ${String(ngResult.disclaimer ?? '').slice(0, 60)}…`);

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
