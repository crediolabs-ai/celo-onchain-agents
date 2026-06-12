/**
 * Direct stdio test using MCP SDK's own StdioClientTransport.
 *
 * The previous test-tools.ts used the SDK Client which has a Zod version
 * incompatibility in SDK 1.29.0. This version bypasses the SDK Client
 * and uses the transport + manual JSON-RPC.
 */

import { spawn } from 'child_process';

const DEMO_ADDRESS = '0x46788b60daf46448668c7abaeea4ac8745451c25';
let idCounter = 1;

function jsonRequest(method: string, params: object = {}): string {
  return JSON.stringify({ jsonrpc: '2.0', id: idCounter++, method, params }) + '\n';
}

async function main() {
  console.log('=== MCP Server Integration Test (direct stdio) ===\n');

  const proc = spawn('npx', ['tsx', 'src/server.ts'], {
    cwd: process.cwd(),
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const stdoutBuffer: string[] = [];
  const stderrLines: string[] = [];

  proc.stdout?.on('data', (d: Buffer) => stdoutBuffer.push(d.toString()));
  proc.stderr?.on('data', (d: Buffer) => stderrLines.push(d.toString()));

  // Wait for server startup
  await new Promise<void>((r) => setTimeout(r, 4000));

  if (proc.exitCode !== null) {
    console.error('Server exited early with code:', proc.exitCode);
    console.error('stderr:', stderrLines.join(''));
    process.exit(1);
  }

  console.log('Server started. stderr:', stderrLines[stderrLines.length - 1] ?? 'none');

  // ── Read helpers ──────────────────────────────────────────────────────────

  function drainUntil(pattern: string): Promise<string> {
    return new Promise((resolve) => {
      const check = () => {
        const combined = stdoutBuffer.join('');
        const idx = combined.indexOf(pattern);
        if (idx !== -1) {
          // Return everything up to and including the pattern line
          const lines = combined.split('\n');
          let acc = '';
          for (const line of lines) {
            acc += line + '\n';
            if (line.includes(pattern)) {
              stdoutBuffer.splice(0, stdoutBuffer.length);
              resolve(acc);
              return;
            }
          }
        }
        // Not found yet, check again soon
        setTimeout(check, 200);
      };
      check();
    });
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
          // Remove this line from buffer
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

  async function recvJson(timeoutMs = 8000): Promise<Record<string, unknown> | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const result = tryParseNextJson();
      if (result) return result;
      await new Promise((r) => setTimeout(r, 150));
    }
    return null;
  }

  async function sendRaw(req: string): Promise<void> {
    proc.stdin?.write(req + '\n');
  }

  // ── Test ───────────────────────────────────────────────────────────────────

  try {
    // Initialize
    console.log('1. Sending initialize...');
    await sendRaw(jsonRequest('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      clientInfo: { name: 'test', version: '0.1.0' },
    }));
    const initRes = await recvJson(6000);
    if (initRes) {
      console.log('   ✓ Received init response:', JSON.stringify(initRes).slice(0, 100));
    } else {
      console.error('   ✗ No init response received');
    }

    // Send initialized notification
    await sendRaw(jsonRequest('notifications/initialized', {}));

    // tools/list
    console.log('\n2. Sending tools/list...');
    await sendRaw(jsonRequest('tools/list', {}));
    const listRes = await recvJson(5000);
    if (listRes) {
      console.log('   Raw listRes:', JSON.stringify(listRes));
      const tools = (listRes.result as { tools?: Array<{ name: string }> })?.tools ?? [];
      console.log(`   ✓ Got ${tools.length} tools: ${tools.map((t) => t.name).join(', ')}`);
    } else {
      console.error('   ✗ No list response received. Buffer:', stdoutBuffer.slice(0, 2));
    }

    // get_celo_transaction_history
    console.log(`\n3. Calling get_celo_transaction_history for ${DEMO_ADDRESS}...`);
    await sendRaw(jsonRequest('tools/call', {
      name: 'get_celo_transaction_history',
      arguments: { address: DEMO_ADDRESS, network: 'mainnet', offset: 5 },
    }));
    const txRes = await recvJson(10000);
    if (txRes && !txRes.error) {
      const result = txRes.result as { content?: Array<{ text: string }> } | undefined;
      const text = result?.content?.[0]?.text;
      if (text) {
        const data = JSON.parse(text);
        if (data.error) {
          console.error(`   ✗ Tool error: ${data.message}`);
        } else {
          console.log(`   ✓ Transactions: ${data.totalReturned} returned, hasMore=${data.hasMore}`);
          if (data.transactions?.[0]) {
            console.log(`     First tx: block=${data.transactions[0].blockNumber} hash=${data.transactions[0].hash.slice(0, 20)}...`);
          }
        }
      }
    } else if (txRes?.error) {
      console.error('   ✗ JSON-RPC error:', txRes.error);
    } else {
      console.error('   ✗ No tx response received. Buffer:', stdoutBuffer.join('').slice(0, 200));
    }

    // get_celo_portfolio
    console.log(`\n4. Calling get_celo_portfolio for ${DEMO_ADDRESS}...`);
    await sendRaw(jsonRequest('tools/call', {
      name: 'get_celo_portfolio',
      arguments: { address: DEMO_ADDRESS, network: 'mainnet' },
    }));
    const portfolioRes = await recvJson(10000);
    if (portfolioRes && !portfolioRes.error) {
      const result = portfolioRes.result as { content?: Array<{ text: string }> } | undefined;
      const text = result?.content?.[0]?.text;
      if (text) {
        const data = JSON.parse(text);
        if (data.error) {
          console.error(`   ✗ Tool error: ${data.message}`);
        } else {
          const holdings = data.holdings ?? [];
          const withUsd = holdings.filter((h: { usdValue: number | null }) => h.usdValue !== null);
          console.log(`   ✓ Holdings: ${holdings.length} tokens, ${withUsd.length} with USD value`);
          console.log(`     Total USD: ${data.totalUsdValue !== null ? '$' + Number(data.totalUsdValue).toFixed(2) : 'N/A'}`);
          for (const h of holdings.slice(0, 5)) {
            console.log(`     ${h.symbol}: balance=${h.balance.slice(0, 12)}... usdValue=${h.usdValue !== null ? '$' + h.usdValue.toFixed(4) : 'null'}`);
          }
        }
      }
    } else if (portfolioRes?.error) {
      console.error('   ✗ JSON-RPC error:', portfolioRes.error);
    } else {
      console.error('   ✗ No portfolio response received');
    }

    console.log('\n=== Done ===');
  } finally {
    proc.kill();
    await new Promise((r) => setTimeout(r, 500));
  }
}

main().catch(console.error);
