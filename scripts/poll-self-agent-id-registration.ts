/**
 * Poll Self registration status. Reads session token from .env.
 * Usage: npx tsx scripts/poll-self-registration-status.ts
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const ENV_PATH = resolve(process.cwd(), '.env');
const SESSION_TOKEN_KEY = 'SELF_REGISTRATION_SESSION_TOKEN';
const AGENT_ADDRESS_KEY = 'SELF_AGENT_ADDRESS';

function readEnv(): Record<string, string> {
  if (!existsSync(ENV_PATH)) {
    throw new Error(`.env not found at ${ENV_PATH}`);
  }
  const out: Record<string, string> = {};
  for (const line of readFileSync(ENV_PATH, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return out;
}

(async () => {
  const env = readEnv();
  const token = env[SESSION_TOKEN_KEY];
  const agent = env[AGENT_ADDRESS_KEY];
  if (!token) throw new Error(`${SESSION_TOKEN_KEY} not set in .env`);

  const res = await fetch('https://app.ai.self.xyz/api/agent/register/status', {
    headers: { Authorization: `Bearer ${token}` },
  });
  const text = await res.text();
  let json: unknown;
  try { json = JSON.parse(text); } catch { json = text; }
  if (!res.ok) {
    console.error(`HTTP ${res.status}`);
    console.error(typeof json === 'string' ? json : JSON.stringify(json, null, 2));
    process.exit(1);
  }
  const s = json as {
    stage: string;
    agentAddress?: string;
    expiresAt?: string;
    timeRemainingMs?: number;
    humanInstructions?: string[];
    [k: string]: unknown;
  };
  console.log(`Agent:    ${s.agentAddress ?? agent}`);
  console.log(`Stage:    ${s.stage}`);
  if (s.expiresAt) {
    const ms = s.timeRemainingMs ?? new Date(s.expiresAt).getTime() - Date.now();
    console.log(`Expires:  ${s.expiresAt} (${Math.max(0, Math.round(ms / 1000))}s remaining)`);
  }
  if (s.humanInstructions?.length) {
    console.log('Next:');
    for (const line of s.humanInstructions) console.log(`  ${line}`);
  }
  console.log();
  console.log(JSON.stringify(s, null, 2));
})().catch((e) => { console.error('FATAL:', e); process.exit(1); });
