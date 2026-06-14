/**
 * Self Agent ID registration for Agent 06 (Celo Onchain Tax).
 *
 * Flow:
 *   1. Generate Ed25519 keypair for the agent
 *   2. Request challenge from Self backend
 *   3. Sign the challenge
 *   4. Submit registration on Celo MAINNET → get QR + deep link
 *   5. Save private key to .env (gitignored)
 *   6. Print QR + deep link for Quan to scan with Self app
 *
 * After scan: poll /api/agent/register/status?sessionToken=... until status
 * is "verified" or "failed".
 */
import crypto from 'node:crypto';
import { writeFileSync, appendFileSync, existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SELF_BASE = 'https://app.ai.self.xyz';
const ENV_PATH = resolve(process.cwd(), '.env');

function hexFromSpki(spkiDer: Buffer): string {
  // SPKI for Ed25519 = 12-byte ASN.1 header + 32-byte raw public key.
  return spkiDer.subarray(-32).toString('hex');
}

function hexFromPkcs8(pkcs8Der: Buffer): string {
  // PKCS8 for Ed25519 = header + 32-byte raw seed.
  return pkcs8Der.subarray(-32).toString('hex');
}

async function postJson(path: string, body: unknown): Promise<unknown> {
  const res = await fetch(`${SELF_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: unknown;
  try { json = JSON.parse(text); } catch { json = text; }
  if (!res.ok) {
    throw new Error(`POST ${path} → ${res.status}\n${typeof json === 'string' ? json : JSON.stringify(json, null, 2)}`);
  }
  return json;
}

(async () => {
  console.log('=== STEP 1: Generate Ed25519 keypair ===');
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const ed25519PublicKeyHex = hexFromSpki(publicKey.export({ format: 'der', type: 'spki' }));
  const ed25519PrivateKeyHex = hexFromPkcs8(privateKey.export({ format: 'der', type: 'pkcs8' }));
  console.log(`Public key (64 hex):  ${ed25519PublicKeyHex}`);
  console.log(`Private key (64 hex): ${ed25519PrivateKeyHex}`);

  console.log('\n=== STEP 2: Request challenge from Self backend ===');
  const challenge = await postJson('/api/agent/register/ed25519-challenge', {
    pubkey: ed25519PublicKeyHex,
    network: 'mainnet',
  }) as { challengeHash: string; nonce: string; [k: string]: unknown };
  console.log(`challengeHash: ${challenge.challengeHash}`);
  console.log(`nonce:         ${challenge.nonce}`);
  if (challenge.challengeMessage) {
    console.log(`message: ${challenge.challengeMessage}`);
  }

  console.log('\n=== STEP 3: Sign the challenge hash ===');
  const hashHex = (challenge.challengeHash ?? '').startsWith('0x')
    ? challenge.challengeHash.slice(2)
    : challenge.challengeHash;
  const sigBuf = crypto.sign(null, Buffer.from(hashHex, 'hex'), privateKey);
  const ed25519SignatureHex = sigBuf.toString('hex');
  console.log(`Hash to sign:     ${hashHex} (${hashHex.length / 2} bytes)`);
  console.log(`Signature (128 hex): ${ed25519SignatureHex}`);

  console.log('\n=== STEP 4: Submit registration (Celo MAINNET, mode=ed25519) ===');
  const reg = await postJson('/api/agent/register', {
    mode: 'ed25519',
    ed25519Pubkey: ed25519PublicKeyHex,
    ed25519Signature: ed25519SignatureHex,
    challengeId: challenge.nonce ?? challenge.challengeHash,
    network: 'mainnet',
  }) as {
    sessionToken: string;
    agentAddress: string;
    network: string;
    mode: string;
    expiresAt: string;
    timeRemainingMs: number;
    deepLink: string;
    qrImageBase64: string;
    humanInstructions: string[];
  };
  console.log(`sessionToken: ${reg.sessionToken}`);
  console.log(`agentAddress: ${reg.agentAddress}`);
  console.log(`network:      ${reg.network}`);
  console.log(`mode:         ${reg.mode}`);
  console.log(`expiresAt:    ${reg.expiresAt} (${Math.round(reg.timeRemainingMs / 1000)}s remaining)`);
  console.log(`deepLink:     ${reg.deepLink}`);

  console.log('\n=== STEP 5: Save private key to .env ===');
  const envLine = `\n# Self Agent ID — Agent 06 (generated 2026-06-14)\nSELF_AGENT_ED25519_PUBLIC_KEY=${ed25519PublicKeyHex}\nSELF_AGENT_ED25519_PRIVATE_KEY=${ed25519PrivateKeyHex}\nSELF_AGENT_ADDRESS=${reg.agentAddress}\nSELF_REGISTRATION_SESSION_TOKEN=${reg.sessionToken}\nSELF_REGISTRATION_EXPIRES_AT=${reg.expiresAt}\n`;
  if (existsSync(ENV_PATH)) {
    const existing = readFileSync(ENV_PATH, 'utf8');
    if (existing.includes('SELF_AGENT_ED25519_PRIVATE_KEY=')) {
      console.log('.env already has SELF_AGENT_* — not overwriting. Edit manually if needed.');
    } else {
      appendFileSync(ENV_PATH, envLine);
      console.log('Appended SELF_AGENT_* lines to .env (gitignored).');
    }
  } else {
    writeFileSync(ENV_PATH, envLine, { mode: 0o600 });
    console.log('Wrote .env (gitignored, mode 0600).');
  }

  console.log('\n=== STEP 6: Save QR for Quan to scan ===');
  const qrPath = resolve(process.cwd(), 'tmp-self-qr.png');
  const qrBuf = Buffer.from(reg.qrImageBase64, 'base64');
  writeFileSync(qrPath, qrBuf);
  console.log(`QR saved: ${qrPath} (${qrBuf.length} bytes)`);

  // Also dump a small JSON for the polling/status script
  const statusJsonPath = resolve(process.cwd(), 'tmp-self-registration.json');
  writeFileSync(statusJsonPath, JSON.stringify({
    sessionToken: reg.sessionToken,
    agentAddress: reg.agentAddress,
    network: reg.network,
    mode: reg.mode,
    expiresAt: reg.expiresAt,
    deepLink: reg.deepLink,
    qrPath,
    humanInstructions: reg.humanInstructions,
  }, null, 2));
  console.log(`Status blob saved: ${statusJsonPath}`);

  console.log('\n========================================');
  console.log('READY FOR QUAN TO SCAN');
  console.log('========================================');
  console.log('\nInstructions for Quan:');
  for (const line of reg.humanInstructions) console.log(`  ${line}`);
  console.log(`\nOr open this deeplink on phone with Self app installed:`);
  console.log(`  ${reg.deepLink}`);
  console.log(`\nQR code: ${qrPath}`);
  console.log(`\nSession expires: ${reg.expiresAt}`);
  console.log(`If expired, rerun this script to generate a new QR.`);
})().catch((e) => { console.error('FATAL:', e); process.exit(1); });
