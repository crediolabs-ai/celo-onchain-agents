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

const HexAddress = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, 'invalid 0x address')
  .transform((s) => s as `0x${string}`);
const HexPriv = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/, 'invalid 0x private key')
  .transform((s) => s as `0x${string}`);
const Url = z.string().url();

const Network = z.enum(['alfajores', 'mainnet']);

const EnvSchema = z
  .object({
    NETWORK: Network.default('alfajores'),
    CELO_RPC_URL: Url,
    CELOSCAN_API_URL: Url,
    CELOSCAN_API_KEY: z.string().default(''),
    COINGECKO_API_KEY: z.string().default(''),
    ANTHROPIC_API_KEY: z.string().default(''),
    AGENT_WALLET_PRIVATE_KEY: HexPriv,
    AGENT_WALLET_ADDRESS: HexAddress,
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
  });

export type RawEnv = z.infer<typeof EnvSchema>;

export interface AppConfig {
  network: 'alfajores' | 'mainnet';
  chainId: number;
  chain: typeof celoAlfajores | typeof celo;
  celoRpcUrl: string;
  celoscanApiUrl: string;
  celoscanApiKey: string;
  coingeckoApiKey: string;
  anthropicApiKey: string;
  agentWallet: {
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

  const account = privateKeyToAccount(e.AGENT_WALLET_PRIVATE_KEY);
  if (account.address.toLowerCase() !== e.AGENT_WALLET_ADDRESS.toLowerCase()) {
    throw new ConfigError(
      `AGENT_WALLET_ADDRESS (${e.AGENT_WALLET_ADDRESS}) does not match ` +
        `the public address derived from AGENT_WALLET_PRIVATE_KEY ` +
        `(${account.address}). Update .env so they agree.`,
    );
  }

  return {
    network: e.NETWORK,
    chainId,
    chain,
    celoRpcUrl: e.CELO_RPC_URL,
    celoscanApiUrl: e.CELOSCAN_API_URL,
    celoscanApiKey: e.CELOSCAN_API_KEY,
    coingeckoApiKey: e.COINGECKO_API_KEY,
    anthropicApiKey: e.ANTHROPIC_API_KEY,
    agentWallet: {
      address: e.AGENT_WALLET_ADDRESS,
      privateKey: e.AGENT_WALLET_PRIVATE_KEY,
      account,
    },
    logLevel: e.LOG_LEVEL,
    cacheDir: e.CACHE_DIR,
  };
}
