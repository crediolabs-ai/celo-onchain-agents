/**
 * HTTP-to-stdio bridge for the celo-tax-portfolio-mcp server.
 *
 * The MCP server (`server.ts`) speaks raw JSON-RPC 2.0 over stdio. This bridge
 * wraps it as an HTTP service so that the endpoints declared in the agent's
 * 8004scan IPFS metadata are actually reachable:
 *
 *   POST /mcp   → JSON-RPC over HTTP (MCP transport)
 *   POST /a2a   → JSON-RPC over HTTP (A2A transport; same wire format)
 *   GET  /health              → 200 + tool inventory
 *   GET  /                    → 200 + tool inventory (alias)
 *   GET  /a2a                 → A2A-spec AgentCard JSON (for 8004scan discovery)
 *   GET  /.well-known/agent.json → A2A-standard discovery path
 *
 * Architecture: long-lived stdio child process. Each HTTP request writes one
 * JSON-RPC line to the child's stdin and reads one response line from stdout.
 * The child is auto-restarted if it dies.
 *
 * Configuration via env:
 *   PORT       (default 3000)
 *   HOST       (default 127.0.0.1)
 *   PUBLIC_URL  (default https://api.crediolabs.ai) — used in AgentCard
 */
import 'dotenv/config';
import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HERE = resolve(__dirname, '..'); // mcp-server/

const PORT = parseInt(process.env.PORT ?? '3000', 10);
const HOST = process.env.HOST ?? '127.0.0.1';
const PUBLIC_URL = process.env.PUBLIC_URL ?? 'https://api.crediolabs.ai';

// Try compiled dist/server.js first, then fall back to tsx for dev
const STDIO_CANDIDATES = [
  resolve(HERE, 'dist/server.js'),   // compiled output
  resolve(HERE, 'src/server.ts'),   // tsx fallback
];
const STDIO_TARGET = STDIO_CANDIDATES.find((p) => existsSync(p)) ?? STDIO_CANDIDATES[0];

// ─── A2A AgentCard (served on GET /a2a and /.well-known/agent.json) ──────────
// Spec: https://a2a-protocol.org/ — 8004scan health-checks for `name` field.
const AGENT_CARD = {
  name: 'Credio onchain tax and portfolio agent',
  description:
    'L3 onchain tax & portfolio agent for Celo. Reads a Celo wallet, classifies ' +
    'every transaction by protocol semantics (not just transfer in/out), and ' +
    'produces jurisdiction-specific tax reports (Nigeria FIRS, Kenya KRA, ' +
    'OECD CARF) plus natural-language queries.',
  url: `${PUBLIC_URL}/a2a`,
  version: '0.1.0',
  provider: {
    organization: 'CredioLabs',
    url: 'https://crediolabs.ai',
  },
  capabilities: {
    streaming: false,
    pushNotifications: false,
    stateTransitionHistory: false,
  },
  defaultInputModes: ['text/plain', 'application/json'],
  defaultOutputModes: ['text/plain', 'application/json'],
  skills: [
    { id: 'get_celo_portfolio', name: 'get_celo_portfolio',
      description: 'Read Celo wallet holdings and balances (native + ERC-20s).',
      tags: ['celo', 'portfolio', 'wallet', 'balance'] },
    { id: 'get_celo_transaction_history', name: 'get_celo_transaction_history',
      description: 'Fetch full Celo transaction history from Celoscan with pagination.',
      tags: ['celo', 'transactions', 'history', 'celoscan'] },
    { id: 'get_token_price_history', name: 'get_token_price_history',
      description: 'Historical USD prices for CELO, cUSD, cEUR, cREAL, USDC, USDT.',
      tags: ['celo', 'prices', 'coingecko', 'historical'] },
    { id: 'calculate_tax_liability', name: 'calculate_tax_liability',
      description: 'Compute realized gains, income, yield, tax owed for NG/KE/OTHER.',
      tags: ['tax', 'fifo', 'lifo', 'wac', 'nigeria', 'kenya'] },
    { id: 'get_staking_rewards', name: 'get_staking_rewards',
      description: 'Celo validator/epoch staking rewards via transfer-heuristic.',
      tags: ['celo', 'staking', 'rewards', 'validators'] },
    { id: 'generate_tax_report', name: 'generate_tax_report',
      description: 'Full tax report (NG/KE/OTHER CSV schemas) for a wallet + year.',
      tags: ['tax', 'report', 'csv', 'nigeria', 'kenya', 'carf'] },
    { id: 'get_carf_report', name: 'get_carf_report',
      description: 'OECD CARF (Crypto-Asset Reporting Framework) report for a date range.',
      tags: ['carf', 'oecd', 'cross-border', 'compliance'] },
  ],
  // 8004scan-friendly extensions (EIP-8004 v2.0 + A2A v0.2 overlap)
  x402Support: true,
  supportedJurisdictions: ['NG', 'KE', 'OTHER'],
};

function stdioCommand(): { cmd: string; args: string[] } {
  // Use the same node binary that's running this bridge (process.execPath).
  // Bare 'node' fails under systemd because its PATH doesn't include nvm.
  const nodeBin = process.execPath;
  if (STDIO_TARGET.endsWith('.ts')) {
    return { cmd: nodeBin, args: ['--import', 'tsx', STDIO_TARGET] };
  }
  return { cmd: nodeBin, args: [STDIO_TARGET] };
}

// ─── Stdio child process management ───────────────────────────────────────────

interface Pending {
  resolve: (val: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

let child: ChildProcessWithoutNullStreams | null = null;
let nextId = 1;
const pending = new Map<number, Pending>();
let restarting = false;

function startChild(): void {
  const { cmd, args } = stdioCommand();
  process.stderr.write(`[http-bridge] spawning stdio server: ${cmd} ${args.join(' ')}\n`);
  child = spawn(cmd, args, { cwd: HERE, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdout.setEncoding('utf-8');
  child.stderr.setEncoding('utf-8');

  child.stdout.on('data', (chunk: string) => {
    for (const line of chunk.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const msg = JSON.parse(trimmed);
        if (msg && typeof msg === 'object' && msg.id !== undefined && pending.has(msg.id)) {
          const p = pending.get(msg.id)!;
          pending.delete(msg.id);
          clearTimeout(p.timer);
          if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
          else p.resolve(msg.result);
        }
      } catch {
        // Non-JSON stdout from stdio server — ignore (logs should go to stderr)
      }
    }
  });

  child.stderr.on('data', (chunk: string) => {
    process.stderr.write(`[mcp-stdio] ${chunk}`);
  });

  child.on('exit', (code, signal) => {
    process.stderr.write(`[mcp-stdio] exited code=${code} signal=${signal}\n`);
    // Reject all pending
    for (const [id, p] of pending) {
      clearTimeout(p.timer);
      p.reject(new Error('stdio server exited before responding'));
    }
    pending.clear();
    child = null;
    if (!restarting) {
      restarting = true;
      setTimeout(() => {
        restarting = false;
        try {
          startChild();
        } catch (e) {
          process.stderr.write(`[http-bridge] failed to restart: ${e}\n`);
        }
      }, 1000);
    }
  });
}

function callStdio(method: string, params?: unknown, timeoutMs = 30_000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (!child) {
      reject(new Error('stdio server not running'));
      return;
    }
    const id = nextId++;
    const timer = setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`stdio call '${method}' timed out after ${timeoutMs}ms`));
      }
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    const req = JSON.stringify({ jsonrpc: '2.0', id, method, params: params ?? {} });
    child.stdin.write(req + '\n');
  });
}

async function readBody(req: IncomingMessage, max = 1_000_000): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', (c: Buffer) => {
      buf += c.toString('utf-8');
      if (buf.length > max) {
        reject(new Error('body too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(buf));
    req.on('error', reject);
  });
}

function send(res: ServerResponse, status: number, body: unknown, contentType = 'application/json'): void {
  res.statusCode = status;
  res.setHeader('Content-Type', contentType);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

// ─── HTTP server ─────────────────────────────────────────────────────────────

const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  const url = req.url ?? '/';
  const method = req.method ?? 'GET';

  // CORS preflight
  if (method === 'OPTIONS') {
    send(res, 204, '');
    return;
  }

  // A2A AgentCard — served on GET /a2a and the standard discovery path.
  // 8004scan pings these to validate A2A endpoints; expects a JSON object with `name`.
  if (method === 'GET' && (url === '/a2a' || url === '/a2a/' || url === '/.well-known/agent.json')) {
    send(res, 200, AGENT_CARD);
    return;
  }

  // Health + tool inventory
  if (method === 'GET' && (url === '/health' || url === '/' || url === '/mcp')) {
    try {
      const result = (await callStdio('tools/list')) as { tools: Array<{ name: string; description: string }> };
      send(res, 200, {
        status: 'ok',
        server: 'celo-tax-portfolio-mcp',
        version: '0.1.0',
        transport: 'http-bridge (stdio backend)',
        endpoints: { mcp: '/mcp', a2a: '/a2a', health: '/health' },
        tools: result.tools.map((t) => ({ name: t.name, description: t.description })),
        childPid: child?.pid ?? null,
      });
      return;
    } catch (e) {
      send(res, 503, { status: 'degraded', error: String(e) });
      return;
    }
  }

  // JSON-RPC endpoint (MCP + A2A — same wire format)
  if (method === 'POST' && (url === '/mcp' || url === '/a2a' || url === '/')) {
    try {
      const body = await readBody(req);
      const parsed = JSON.parse(body || '{}');
      if (parsed.jsonrpc !== '2.0' || typeof parsed.method !== 'string') {
        send(res, 400, {
          jsonrpc: '2.0',
          id: parsed.id ?? null,
          error: { code: -32600, message: 'Invalid Request: must be JSON-RPC 2.0 with method' },
        });
        return;
      }
      const result = await callStdio(parsed.method, parsed.params);
      send(res, 200, { jsonrpc: '2.0', id: parsed.id, result });
    } catch (e) {
      const err = e as Error;
      send(res, 500, {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32603, message: err?.message ?? 'Internal error' },
      });
    }
    return;
  }

  send(res, 404, { error: 'Not Found', hint: 'POST JSON-RPC to /mcp or /a2a; GET /health for tool list' });
});

server.listen(PORT, HOST, () => {
  process.stderr.write(`[http-bridge] listening on http://${HOST}:${PORT}\n`);
  process.stderr.write(`[http-bridge] stdio backend: ${stdioCommand().cmd} ${stdioCommand().args.join(' ')}\n`);
  startChild();
});

// Graceful shutdown
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    process.stderr.write(`[http-bridge] received ${sig}, shutting down...\n`);
    if (child) {
      try { child.kill(); } catch { /* ignore */ }
    }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
