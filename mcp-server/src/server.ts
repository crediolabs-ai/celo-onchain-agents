/**
 * MCP server entry point — Celo Tax & Portfolio Agent (Phase B foundation).
 *
 * Raw JSON-RPC 2.0 over stdio. No SDK dependency to avoid version-compat bugs.
 * Exposes 2 tools:
 *   - get_celo_portfolio     (P0)
 *   - get_celo_transaction_history (P0)
 *
 * Full 7-tool inventory is post-hackathon.
 *
 * Protocol (per MCP spec):
 *   - Server reads one JSON-RPC message per line from stdin
 *   - Server writes one JSON-RPC message per line to stdout
 *   - Server logs go to stderr
 *   - Notifications (no `id`) get no response
 *   - Requests (have `id`) get a response (result or error)
 *
 * Methods handled:
 *   - initialize                  → return serverInfo + capabilities
 *   - notifications/initialized   → no-op
 *   - tools/list                  → return registered tools
 *   - tools/call                  → dispatch to tool handler
 *   - ping                        → return empty result
 */

import 'dotenv/config';

import { getCeloPortfolio } from './tools/get-celo-portfolio.js';
import { getCeloTransactionHistory } from './tools/get-celo-transaction-history.js';

// ─── Logging (stderr only — stdout is the protocol channel) ──────────────────

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

function log(level: LogLevel, msg: string, ...meta: unknown[]): void {
  const ns = process.env.LOG_LEVEL ?? 'info';
  const levels: LogLevel[] = ['debug', 'info', 'warn', 'error'];
  if (levels.indexOf(level) < levels.indexOf(ns as LogLevel)) return;
  const prefix = `[${new Date().toISOString()}] [${level.toUpperCase()}]`;
  // eslint-disable-next-line no-console
  console.error(prefix, msg, ...meta);
}

// ─── Tool registry ───────────────────────────────────────────────────────────

type ToolHandler = (args: Record<string, unknown>) => Promise<Record<string, unknown>>;

interface ToolDescription {
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

const TOOL_HANDLERS: Record<string, ToolHandler> = {
  get_celo_portfolio: getCeloPortfolio,
  get_celo_transaction_history: getCeloTransactionHistory,
};

const TOOL_DESCRIPTIONS: Record<string, ToolDescription> = {
  get_celo_portfolio: {
    description:
      'Retrieve Celo wallet holdings and balances. Returns native CELO balance plus all known ERC-20 token balances (cUSD, cEUR, cREAL, USDC, USDT) with current USD valuations.',
    inputSchema: {
      type: 'object',
      properties: {
        address: {
          type: 'string',
          description: 'Celo wallet address (0x... 40 hex characters)',
          pattern: '^0x[0-9a-fA-F]{40}$',
        },
        network: {
          type: 'string',
          enum: ['mainnet', 'alfajores'],
          default: 'mainnet',
          description: 'Celo network to query',
        },
      },
      required: ['address'],
    },
  },
  get_celo_transaction_history: {
    description:
      'Retrieve full transaction history for a Celo address from Celoscan. Supports pagination, block range filtering.',
    inputSchema: {
      type: 'object',
      properties: {
        address: { type: 'string', description: 'Celo wallet address' },
        network: {
          type: 'string',
          enum: ['mainnet', 'alfajores'],
          default: 'mainnet',
          description: 'Celo network to query',
        },
        fromBlock: { type: 'number', description: 'Starting block number (inclusive)' },
        toBlock: { type: 'number', description: 'Ending block number (inclusive)' },
        page: { type: 'number', minimum: 1, maximum: 10, default: 1, description: 'Page number' },
        offset: {
          type: 'number',
          minimum: 1,
          maximum: 100,
          default: 100,
          description: 'Number of transactions per page',
        },
      },
      required: ['address'],
    },
  },
};

// ─── JSON-RPC server core ─────────────────────────────────────────────────────

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: number | string;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

function ok(id: number | string, result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result };
}

function err(
  id: number | string,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message, ...(data !== undefined && { data }) } };
}

// Standard JSON-RPC 2.0 error codes
const ERR_INVALID_REQUEST = -32600;
const ERR_METHOD_NOT_FOUND = -32601;
const ERR_INVALID_PARAMS = -32602;
const ERR_INTERNAL = -32603;

async function handleRequest(req: JsonRpcRequest): Promise<JsonRpcResponse | null> {
  const isNotification = req.id === undefined;

  switch (req.method) {
    case 'initialize': {
      log('debug', 'initialize');
      const result = {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'celo-tax-portfolio-mcp', version: '0.1.0' },
      };
      return isNotification ? null : ok(req.id!, result);
    }

    case 'notifications/initialized': {
      log('debug', 'initialized notification received');
      return null;
    }

    case 'tools/list': {
      log('debug', 'tools/list');
      const tools = Object.entries(TOOL_DESCRIPTIONS).map(([name, desc]) => ({
        name,
        description: desc.description,
        inputSchema: desc.inputSchema,
      }));
      return isNotification ? null : ok(req.id!, { tools });
    }

    case 'tools/call': {
      if (isNotification) return null;
      const params = (req.params ?? {}) as {
        name?: string;
        arguments?: Record<string, unknown>;
      };
      const { name, arguments: args } = params;
      if (typeof name !== 'string') {
        return err(req.id!, ERR_INVALID_PARAMS, 'tools/call: missing "name"');
      }
      const handler = TOOL_HANDLERS[name];
      if (!handler) {
        return ok(req.id!, {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                error: 'TOOL_NOT_FOUND',
                message: `Tool "${name}" is not implemented. Available: ${Object.keys(TOOL_HANDLERS).join(', ')}`,
              }),
            },
          ],
          isError: true,
        });
      }
      try {
        const result = await handler(args ?? {});
        return ok(req.id!, {
          content: [{ type: 'text', text: JSON.stringify(result) }],
          isError: false,
        });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        log('error', `Tool "${name}" threw:`, message);
        return ok(req.id!, {
          content: [{ type: 'text', text: JSON.stringify({ error: 'TOOL_ERROR', message }) }],
          isError: true,
        });
      }
    }

    case 'ping': {
      return isNotification ? null : ok(req.id!, {});
    }

    default: {
      if (isNotification) return null;
      return err(req.id!, ERR_METHOD_NOT_FOUND, `Method not found: ${req.method}`);
    }
  }
}

// ─── Stdio transport ──────────────────────────────────────────────────────────

function writeResponse(res: JsonRpcResponse): void {
  process.stdout.write(JSON.stringify(res) + '\n');
}

function processLine(line: string): void {
  const trimmed = line.trim();
  if (!trimmed) return;
  let parsed: JsonRpcRequest;
  try {
    parsed = JSON.parse(trimmed);
  } catch (e) {
    log('error', 'JSON parse error:', e instanceof Error ? e.message : String(e));
    return;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    log('error', 'Invalid JSON-RPC envelope');
    return;
  }
  if (parsed.jsonrpc !== '2.0' || typeof parsed.method !== 'string') {
    if (parsed.id !== undefined) {
      writeResponse(err(parsed.id, ERR_INVALID_REQUEST, 'Invalid JSON-RPC 2.0 request'));
    }
    return;
  }
  handleRequest(parsed)
    .then((res) => {
      if (res !== null) writeResponse(res);
    })
    .catch((e) => {
      log('error', 'Handler threw:', e instanceof Error ? e.message : String(e));
      if (parsed.id !== undefined) {
        writeResponse(err(parsed.id, ERR_INTERNAL, 'Internal error'));
      }
    });
}

// ─── Main ─────────────────────────────────────────────────────────────────────

function main(): void {
  log('info', 'Starting celo-tax-portfolio-mcp server (raw JSON-RPC)...');

  let buffer = '';
  process.stdin.setEncoding('utf-8');
  process.stdin.on('data', (chunk: string) => {
    buffer += chunk;
    let newlineIdx: number;
    while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newlineIdx);
      buffer = buffer.slice(newlineIdx + 1);
      processLine(line);
    }
  });
  process.stdin.on('end', () => {
    if (buffer.trim()) processLine(buffer);
    log('info', 'stdin closed, shutting down');
    process.exit(0);
  });

  log('info', 'MCP server started on stdio');
}

main();

// Graceful shutdown
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    log('info', `Received ${sig}, shutting down gracefully...`);
    process.exit(0);
  });
}
