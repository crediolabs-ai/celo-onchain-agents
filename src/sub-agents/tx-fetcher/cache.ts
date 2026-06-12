/**
 * Local file cache for fetched tx history.
 *
 * Owner: Credio (tx-fetcher sub-agent).
 *
 * Hackathon-scale cache: one JSON file per (address, network), containing
 * the full `FetchedTxData`. Misses fall through to Celoscan; hits short-
 * circuit pagination entirely. No TTL — re-fetching is the user's call
 * (`--refresh` CLI flag, future).
 *
 * Storage layout:
 *   - tx history:    `<cacheDir>/tx-fetcher/<network>/<address-lowercase>.json`
 *   - contract meta: `<cacheDir>/contracts/<network>/<address-lowercase>.json`
 * Writes are atomic (write to `.tmp` then rename) so a crashed process
 * can't leave a half-written file.
 */

import { promises as fs } from 'node:fs';
import { join, dirname } from 'node:path';
import type { Address, ContractMetadata, FetchedTxData } from '../../shared/types.js';
import type { Network } from '../../shared/contracts.js';

export interface TxCache {
  read(address: Address): Promise<FetchedTxData | null>;
  write(address: Address, data: FetchedTxData): Promise<void>;
  clear(address: Address): Promise<void>;
}

export interface TxCacheOptions {
  cacheDir: string;
  network: Network;
}

const SUBDIR = 'tx-fetcher';

function filePath(opts: TxCacheOptions, address: Address): string {
  return join(opts.cacheDir, SUBDIR, opts.network, `${address.toLowerCase()}.json`);
}

export function createTxCache(opts: TxCacheOptions): TxCache {
  async function read(address: Address): Promise<FetchedTxData | null> {
    try {
      const raw = await fs.readFile(filePath(opts, address), 'utf-8');
      const parsed = JSON.parse(raw) as FetchedTxData;
      // `contractMetadata` is a Map in memory; JSON round-trips it as a plain
      // object. Re-hydrate so consumers can call `.get()` / `.has()`.
      if (parsed && parsed.contractMetadata && !(parsed.contractMetadata instanceof Map)) {
        const obj = parsed.contractMetadata as Record<string, ContractMetadata>;
        const entries: [Address, ContractMetadata][] = Object.keys(obj).map(
          (k) => [k as Address, obj[k]!] as [Address, ContractMetadata],
        );
        parsed.contractMetadata = new Map<Address, ContractMetadata>(entries);
      }
      return parsed;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  async function write(address: Address, data: FetchedTxData): Promise<void> {
    const target = filePath(opts, address);
    const tmp = `${target}.tmp`;
    await fs.mkdir(dirname(target), { recursive: true });
    // Convert Map to a plain object for JSON serialization. Mirrored in `read`.
    const serializable: FetchedTxData = {
      ...data,
      contractMetadata: data.contractMetadata
        ? (Object.fromEntries(data.contractMetadata) as unknown as Map<Address, ContractMetadata>)
        : data.contractMetadata,
    };
    await fs.writeFile(tmp, JSON.stringify(serializable, null, 2), 'utf-8');
    await fs.rename(tmp, target);
  }

  async function clear(address: Address): Promise<void> {
    try {
      await fs.unlink(filePath(opts, address));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }

  return { read, write, clear };
}

// ─── Contract metadata cache ──────────────────────────────────────────────

/** Per-(address, network) cache for Celoscan `getsourcecode` results. */
export interface ContractCache {
  /** Returns the cached metadata, or `null` on miss. */
  read(address: Address): Promise<ContractMetadata | null>;
  /** Atomic write of one entry. */
  write(address: Address, data: ContractMetadata): Promise<void>;
  /** Read many — used by the fetcher to seed its in-memory map. */
  readMany(addresses: readonly Address[]): Promise<Map<Address, ContractMetadata>>;
}

export interface ContractCacheOptions {
  cacheDir: string;
  network: Network;
}

const CONTRACT_SUBDIR = 'contracts';

function contractFilePath(opts: ContractCacheOptions, address: Address): string {
  return join(opts.cacheDir, CONTRACT_SUBDIR, opts.network, `${address.toLowerCase()}.json`);
}

export function createContractCache(opts: ContractCacheOptions): ContractCache {
  async function read(address: Address): Promise<ContractMetadata | null> {
    try {
      const raw = await fs.readFile(contractFilePath(opts, address), 'utf-8');
      return JSON.parse(raw) as ContractMetadata;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  async function write(address: Address, data: ContractMetadata): Promise<void> {
    const target = contractFilePath(opts, address);
    const tmp = `${target}.tmp`;
    await fs.mkdir(dirname(target), { recursive: true });
    await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf-8');
    await fs.rename(tmp, target);
  }

  async function readMany(addresses: readonly Address[]): Promise<Map<Address, ContractMetadata>> {
    const out = new Map<Address, ContractMetadata>();
    await Promise.all(
      addresses.map(async (addr) => {
        const data = await read(addr);
        if (data) out.set(addr.toLowerCase() as Address, data);
      }),
    );
    return out;
  }

  return { read, write, readMany };
}
