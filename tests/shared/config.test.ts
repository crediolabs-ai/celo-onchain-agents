import { describe, it, expect } from 'vitest';
import { generatePrivateKey } from 'viem/accounts';
import { privateKeyToAccount } from 'viem/accounts';
import { ConfigError, loadConfig } from '../../src/index.js';

const RPC = 'https://alfajores-forno.celo-testnet.org';
const SCAN = 'https://api-alfajores.celoscan.io';

function freshKeypair() {
  const pk = generatePrivateKey();
  const address = privateKeyToAccount(pk).address;
  return { pk, address };
}

function envFrom(keypair: { pk: `0x${string}`; address: `0x${string}` }, overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    NETWORK: 'alfajores',
    CELO_RPC_URL: RPC,
    CELOSCAN_API_URL: SCAN,
    CELOSCAN_API_KEY: '',
    COINGECKO_API_KEY: '',
    ANTHROPIC_API_KEY: '',
    AGENT_WALLET_PRIVATE_KEY: keypair.pk,
    AGENT_WALLET_ADDRESS: keypair.address,
    LOG_LEVEL: 'info',
    CACHE_DIR: './.cache',
    ...overrides,
  };
}

describe('loadConfig', () => {
  it('returns a fully-typed config when env is valid', () => {
    const kp = freshKeypair();
    const cfg = loadConfig(envFrom(kp));
    expect(cfg.network).toBe('alfajores');
    expect(cfg.chainId).toBe(44787);
    expect(cfg.celoRpcUrl).toBe(RPC);
    expect(cfg.celoscanApiUrl).toBe(SCAN);
    expect(cfg.agentWallet!.address.toLowerCase()).toBe(kp.address.toLowerCase());
  });

  it('rejects mismatched address/private key pair', () => {
    const kp = freshKeypair();
    const wrong = freshKeypair();
    expect(() => loadConfig(envFrom({ pk: kp.pk, address: wrong.address }))).toThrow(
      ConfigError,
    );
  });

  it('rejects malformed CELO_RPC_URL', () => {
    const kp = freshKeypair();
    expect(() => loadConfig(envFrom(kp, { CELO_RPC_URL: 'not-a-url' }))).toThrow(/CELO_RPC_URL/);
  });

  it('rejects malformed AGENT_WALLET_PRIVATE_KEY', () => {
    const kp = freshKeypair();
    expect(() =>
      loadConfig(envFrom(kp, { AGENT_WALLET_PRIVATE_KEY: '0xtooshort' })),
    ).toThrow(/private key/);
  });

  it('rejects malformed AGENT_WALLET_ADDRESS', () => {
    const kp = freshKeypair();
    expect(() => loadConfig(envFrom(kp, { AGENT_WALLET_ADDRESS: '0xnope' }))).toThrow(/address/);
  });

  it('rejects ANTHROPIC_API_KEY that does not start with sk-', () => {
    const kp = freshKeypair();
    expect(() => loadConfig(envFrom(kp, { ANTHROPIC_API_KEY: 'invalid' }))).toThrow(
      /ANTHROPIC_API_KEY/,
    );
  });

  it('accepts sk- prefixed ANTHROPIC_API_KEY', () => {
    const kp = freshKeypair();
    const cfg = loadConfig(envFrom(kp, { ANTHROPIC_API_KEY: 'sk-test-abc' }));
    expect(cfg.anthropicApiKey).toBe('sk-test-abc');
  });

  it('accepts mainnet network and selects Celo mainnet chain', () => {
    const kp = freshKeypair();
    const cfg = loadConfig(envFrom(kp, { NETWORK: 'mainnet' }));
    expect(cfg.network).toBe('mainnet');
    expect(cfg.chainId).toBe(42220);
  });
});
