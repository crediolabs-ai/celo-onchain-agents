/**
 * Environment loading + validation.
 *
 * Single source of truth for all env-driven config. Every other module imports
 * `loadConfig()` once at startup; the result is the only config surface.
 *
 * Zod-validated at the boundary so downstream code can rely on parsed types.
 */

import { z } from 'zod';
import { config as loadDotenv } from 'dotenv';
import { privateKeyToAccount } from 'viem/accounts';
import { celo, celoAlfajores } from 'viem/chains';
import { ConfigError } from './errors.js';

// Load .env once. dotenv is idempotent.
loadDotenv();

const Url = z.string().url();

const Network = z.enum(['alfajores', 'mainnet']);

const EnvSchema = z
  .object({
    NETWORK: Network.default('alfajores'),
    CELO_RPC_URL: Url,
    CELOSCAN_API_URL: Url,
    CELOSCAN_API_KEY: z.string().default(''),
    ANTHROPIC_API_KEY: z.string().default(''),
    AGENT_LLM_MODEL: z.string().default('claude-sonnet-4-6'),
    // Agent wallet is OPTIONAL — only required for write operations
    // (`--emit-onchain-log` for Track 2 onchain logs). Read-only paths
    // (fetch + classify + PNL + CSV) do not need a funded agent wallet.
    AGENT_WALLET_PRIVATE_KEY: z.string().default(''),
    AGENT_WALLET_ADDRESS: z.string().default(''),
    LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
    CACHE_DIR: z.string().default('./.cache'),
  })
  .superRefine((env, ctx) => {
    if (env.ANTHROPIC_API_KEY !== '' && !env.ANTHROPIC_API_KEY.startsWith('sk-')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ANTHROPIC_API_KEY'],
        message: 'ANTHROPIC_API_KEY must start with "sk-" when set',
      });
    }
    // If the private key is set, the address must also be set and match.
    if (env.AGENT_WALLET_PRIVATE_KEY !== '') {
      if (env.AGENT_WALLET_ADDRESS === '') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['AGENT_WALLET_ADDRESS'],
          message:
            'AGENT_WALLET_ADDRESS is required when AGENT_WALLET_PRIVATE_KEY is set',
        });
      } else {
        const account = privateKeyToAccount(
          env.AGENT_WALLET_PRIVATE_KEY as `0x${string}`,
        );
        if (account.address.toLowerCase() !== env.AGENT_WALLET_ADDRESS.toLowerCase()) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['AGENT_WALLET_ADDRESS'],
            message: `AGENT_WALLET_ADDRESS (${env.AGENT_WALLET_ADDRESS}) does not match the public address derived from AGENT_WALLET_PRIVATE_KEY (${account.address}). Update .env so they agree.`,
          });
        }
      }
    }
  });

export type RawEnv = z.infer<typeof EnvSchema>;

export interface AppConfig {
  network: 'alfajores' | 'mainnet';
  chainId: number;
  chain: typeof celoAlfajores | typeof celo;
  celoRpcUrl: string;
  celoscanApiUrl: string;
  celoscanApiKey: string;
  anthropicApiKey: string;
  anthropicModel?: string;
  /**
   * Optional. Only present when AGENT_WALLET_PRIVATE_KEY is set.
   * Required for write operations (e.g. `--emit-onchain-log` for Track 2).
   * Read-only paths can run without an agent wallet.
   */
  agentWallet?: {
    address: `0x${string}`;
    privateKey: `0x${string}`;
    account: ReturnType<typeof privateKeyToAccount>;
  };
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  cacheDir: string;
}

/** Load and validate the full environment. Throws ConfigError on failure. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new ConfigError(`Invalid environment configuration:\n${issues}`);
  }
  const e = parsed.data;

  const chain = e.NETWORK === 'mainnet' ? celo : celoAlfajores;
  const chainId = chain.id;

  // Build the agent wallet only if a private key is provided.
  const agentWallet =
    e.AGENT_WALLET_PRIVATE_KEY !== ''
      ? {
          address: e.AGENT_WALLET_ADDRESS as `0x${string}`,
          privateKey: e.AGENT_WALLET_PRIVATE_KEY as `0x${string}`,
          account: privateKeyToAccount(e.AGENT_WALLET_PRIVATE_KEY as `0x${string}`),
        }
      : undefined;

  return {
    network: e.NETWORK,
    chainId,
    chain,
    celoRpcUrl: e.CELO_RPC_URL,
    celoscanApiUrl: e.CELOSCAN_API_URL,
    celoscanApiKey: e.CELOSCAN_API_KEY,
    anthropicApiKey: e.ANTHROPIC_API_KEY,
    anthropicModel: e.AGENT_LLM_MODEL,
    ...(agentWallet && { agentWallet }),
    logLevel: e.LOG_LEVEL,
    cacheDir: e.CACHE_DIR,
  };
}
