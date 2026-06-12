/**
 * Shared deterministic tx-hash builder for test fixtures.
 *
 * Module-level counter increments on every call so hashes are unique
 * within a test run. The optional `prefix` lets fixture builders group
 * related hashes visually (e.g. `'aa'`, `'bb'`) without colliding.
 */
import type { TxHash } from '../../src/shared/types.js';

let counter = 0;

export function mkHash(prefix = ''): TxHash {
  counter += 1;
  return ('0x' + prefix + counter.toString(16).padStart(64 - prefix.length, '0')) as TxHash;
}
