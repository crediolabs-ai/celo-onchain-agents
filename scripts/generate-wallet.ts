import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { writeFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const pk = generatePrivateKey();
const account = privateKeyToAccount(pk);

const generatedAt = new Date().toISOString();

// Public record (committed) — address + metadata, NO private key.
const record = {
  agent: 'agent-06',
  purpose: 'ERC-8004 registration + onchain log emitter',
  network: 'alfajores',
  chainId: 44787,
  address: account.address,
  generatedAt,
  fundingRequired: '0.5 CELO',
  fundingStatus: 'pending — needs funding',
  privateKeyLocation: '.env → AGENT_WALLET_PRIVATE_KEY (gitignored)',
};

// 1. Print full record (including private key) to stdout for human visibility.
console.log(JSON.stringify({ ...record, privateKey: pk }, null, 2));

// 2. Persist public metadata to wallets/agent-06.json (this file is committed).
const walletPath = resolve('wallets/agent-06.json');
await writeFile(walletPath, JSON.stringify(record, null, 2) + '\n', 'utf-8');

// 3. Update .env idempotently: replace AGENT_WALLET_PRIVATE_KEY / AGENT_WALLET_ADDRESS
// lines if present, otherwise append. Preserves all other lines verbatim.
const envPath = resolve('.env');
let envContent: string;
try {
  envContent = await readFile(envPath, 'utf-8');
} catch {
  envContent = '';
}

const setEnvLine = (content: string, key: string, value: string): string => {
  const line = `${key}=${value}`;
  const re = new RegExp(`^${key}=.*$`, 'm');
  if (re.test(content)) return content.replace(re, line);
  const sep = content === '' || content.endsWith('\n') ? '' : '\n';
  return content + sep + line + '\n';
};

envContent = setEnvLine(envContent, 'AGENT_WALLET_PRIVATE_KEY', pk);
envContent = setEnvLine(envContent, 'AGENT_WALLET_ADDRESS', account.address);
await writeFile(envPath, envContent, 'utf-8');

console.error(`\nWrote ${walletPath}`);
console.error(`Updated ${envPath} (AGENT_WALLET_PRIVATE_KEY, AGENT_WALLET_ADDRESS)`);
