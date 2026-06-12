/**
 * Integration test for get_token_price_history — raw JSON-RPC 2.0 over stdio.
 * Skips gracefully if COINGECKO_API_KEY is not set (free tier still works).
 */

import { spawn } from 'child_process';

let idCounter = 1;

function jsonRequest(method: string, params: object = {}): string {
  return JSON.stringify({ jsonrpc: '2.0', id: idCounter++, method, params }) + '\n';
}

async function main() {
  console.log('=== get_token_price_history Integration Test ===\n');

  if (!process.env.COINGECKO_API_KEY) {
    console.log('⚠ COINGECKO_API_KEY not set — skipping live test (tool works on free tier)');
    console.log('  Set COINGECKO_API_KEY to run against real CoinGecko data.');
    process.exit(0);
  }

  const proc = spawn('npx', ['tsx', 'src/server.ts'], {
    cwd: process.cwd(),
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const stdoutBuffer: string[] = [];
  const stderrLines: string[] = [];

  proc.stdout?.on('data', (d: Buffer) => stdoutBuffer.push(d.toString()));
  proc.stderr?.on('data', (d: Buffer) => stderrLines.push(d.toString()));
  await new Promise<void>((r) => setTimeout(r, 4000));

  if (proc.exitCode !== null) {
    console.error('Server exited early:', proc.exitCode, stderrLines.join(''));
    process.exit(1);
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
      } catch {
        // Not a JSON line
      }
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

  async function sendRaw(req: string): Promise<void> {
    proc.stdin?.write(req + '\n');
  }

  try {
    // Initialize
    await sendRaw(jsonRequest('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      clientInfo: { name: 'test', version: '0.1.0' },
    }));
    await recvJson(6000);
    await sendRaw(jsonRequest('notifications/initialized', {}));

    // Call get_token_price_history with a 31-day range on 2 tokens
    console.log('Calling get_token_price_history (fromDate=2025-01-01, toDate=2025-01-31, tokens=[CELO,cUSD])...');
    await sendRaw(jsonRequest('tools/call', {
      name: 'get_token_price_history',
      arguments: { fromDate: '2025-01-01', toDate: '2025-01-31', tokens: ['CELO', 'cUSD'] },
    }));

    const res = await recvJson(20000);

    if (res?.error) {
      console.error('JSON-RPC error:', JSON.stringify(res.error));
      process.exit(1);
    }

    const result = res?.result as { content?: Array<{ text: string }> } | undefined;
    const text = result?.content?.[0]?.text;
    if (!text) {
      console.error('No response text received');
      process.exit(1);
    }

    const data = JSON.parse(text);

    let passed = 0;
    let failed = 0;

    function assert(condition: boolean, msg: string) {
      if (condition) { console.log(`  ✓ ${msg}`); passed++; }
      else { console.error(`  ✗ FAILED: ${msg}`); failed++; }
    }

    assert(data.series?.CELO != null, 'series.CELO exists');
    assert(data.series?.cUSD != null, 'series.cUSD exists');
    assert(Array.isArray(data.series?.CELO), 'series.CELO is an array');
    assert(Array.isArray(data.series?.cUSD), 'series.cUSD is an array');
    assert(data.fetchedAt != null, 'fetchedAt is present');
    assert(data.fromDate === '2025-01-01', 'fromDate matches');
    assert(data.toDate === '2025-01-31', 'toDate matches');

    const celoPrices = data.series?.CELO as Array<{ date: string; priceUsd: number | null }>;
    const celoNonNull = celoPrices?.filter((p) => p.priceUsd !== null) ?? [];
    assert(celoNonNull.length > 0, `CELO has real data (${celoNonNull.length}/${celoPrices?.length ?? 0} non-null)`);

    console.log(`\n=== ${passed} passed, ${failed} failed ===`);
    if (failed > 0) process.exit(1);
  } finally {
    proc.kill();
    await new Promise((r) => setTimeout(r, 500));
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
