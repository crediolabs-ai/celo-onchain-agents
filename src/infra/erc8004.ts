/**
 * ERC-8004 agent identity — metadata + registration helpers.
 *
 * Owner: Credio (infra).
 *
 * ERC-8004 is the on-chain agent registry standard (agentscan.info on Celo).
 * Agent 06 is already registered for this hackathon (see
 * `KNOWN_REGISTRATION_TX` below) — the on-chain link to the existing
 * registration tx is the source of truth for "is the agent registered?".
 *
 * This module provides:
 *   - `buildAgentMetadata()` — the JSON metadata blob describing the agent
 *     (name, description, capabilities, supported jurisdictions). Suitable
 *     for both off-chain indexers (Celopedia submission) and any future
 *     re-registration flow.
 *   - `getRegistrationTxUrl()` — Celoscan URL for the existing registration
 *     tx. Used in the hackathon submission narrative + the
 *     agentscan.info verification link.
 *   - `registerAgent()` — STUB. Real contract interaction is deferred until
 *     a future phase (the existing registration suffices for the hackathon).
 *
 * Out of scope:
 *   - Reading the on-chain registry to verify membership (could be added via
 *     `wallet.publicClient.readContract({...})` once the registry ABI is
 *     sourced from agentscan.info).
 *   - Self Agent ID (app.ai.self.xyz) — per the hackathon checklist this
 *     is "beneficial but not required" and the team has not yet pursued it.
 */

import type { Address, Hash } from 'viem';
import type { AgentWallet } from './wallet.js';
import { WalletError } from '../shared/errors.js';

// ─── Constants ────────────────────────────────────────────────────────────────

/** Agent 06's existing ERC-8004 registration tx (hackathon submission link). */
export const KNOWN_REGISTRATION_TX: Hash =
  '0x0fad789eb78d6500ae09eec1c1295ce654cd9277a25289d1cf55de36b8b961a1';

/**
 * Celoscan base URL per network. Build a tx URL via `getRegistrationTxUrl()`.
 */
const CELOSCAN_TX_BASE: Record<string, string> = {
  alfajores: 'https://alfajores.celoscan.io/tx',
  mainnet: 'https://celoscan.io/tx',
};

// ─── Types ───────────────────────────────────────────────────────────────────

/** ERC-8004 agent metadata shape (loose — the standard is still evolving). */
export interface AgentMetadata {
  /** Stable agent identifier (kebab-case). */
  agent: string;
  /** Human-readable display name. */
  name: string;
  /** One-line description (used in Celopedia submission, agentscan.info, etc). */
  description: string;
  /** Agent capability tags. */
  capabilities: string[];
  /** Jurisdiction codes the agent supports natively. */
  supportedJurisdictions: string[];
  /** Hackathon / program this registration belongs to. */
  program: string;
  /** ISO timestamp the metadata was generated. */
  generatedAt: string;
}

// ─── Metadata builder ───────────────────────────────────────────────────────

/**
 * Build the JSON metadata for Agent 06.
 *
 * Single source of truth for the agent's self-description. Used by:
 *   - Celopedia submission (hackathon form)
 *   - Quote-tweet / X thread registration message
 *   - Any future agentscan.info update flow
 */
export function buildAgentMetadata(now: Date = new Date()): AgentMetadata {
  return {
    agent: 'agent-06',
    name: 'Onchain Tax & Portfolio Agent',
    description:
      'Crawls a Celo wallet, classifies every txn, computes FIFO PNL, and ' +
      'exports tax-ready CSV aligned with Nigeria FIRS + Kenya KRA + OECD CARF.',
    capabilities: [
      'tx-classification',
      'fifo-pnl',
      'lifo-pnl',
      'wac-pnl',
      'csv-export-firs',
      'csv-export-kra',
      'csv-export-carf',
      'natural-language-query',
    ],
    supportedJurisdictions: ['NG', 'KE', 'OTHER'],
    program: 'Celo Onchain Agents Hackathon 2026',
    generatedAt: now.toISOString(),
  };
}

// ─── URL helpers ─────────────────────────────────────────────────────────────

/** Build the Celoscan URL for the existing registration tx, per network. */
export function getRegistrationTxUrl(network: 'alfajores' | 'mainnet'): string {
  const base = CELOSCAN_TX_BASE[network];
  if (base === undefined) {
    throw new WalletError(`Unknown network for Celoscan URL: ${network}`);
  }
  return `${base}/${KNOWN_REGISTRATION_TX}`;
}

// ─── Registration (stub) ─────────────────────────────────────────────────────

/**
 * STUB: register (or re-register) Agent 06 on the ERC-8004 registry.
 *
 * The current implementation returns the existing registration tx hash
 * without broadcasting anything. The real flow — read agentscan.info for
 * the registry contract address, build the ABI, call `wallet.writeContract` —
 * is deferred to a post-hackathon phase. For the hackathon, the existing
 * registration tx suffices (see `KNOWN_REGISTRATION_TX`).
 *
 * @param wallet Unused in the stub. Reserved for the real implementation.
 * @param network Network the (re-)registration would target.
 * @returns The existing registration tx hash.
 */
export async function registerAgent(
  _wallet: AgentWallet,
  network: 'alfajores' | 'mainnet',
): Promise<Hash> {
  // Surface the link so the caller can log it / display it.
  const url = getRegistrationTxUrl(network);
  console.info(`[erc8004] Agent 06 already registered. View at: ${url}`);
  return KNOWN_REGISTRATION_TX;
}

/** Lightweight check: is the given address non-empty? Used by future verifiers. */
export function isRegisteredAddress(addr: Address | undefined): addr is Address {
  return addr !== undefined && addr !== '0x0000000000000000000000000000000000000000';
}
