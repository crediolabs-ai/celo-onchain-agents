/**
 * Shared selector-extraction utility.
 *
 * Unifies the logic from the former duplicates in:
 *   - selector-registry.ts  (returned `0x${string} | null`)
 *   - protocol-decoder.ts   (returned `string | null`)
 *
 * Both callers only need `string | null`, so that is the return type.
 */

/** Extracts the 4-byte function selector from calldata, or null. */
export function extractSelector(input: string): string | null {
  if (!input || input === '0x' || input.length < 10) return null;
  if (!input.startsWith('0x')) return null;
  return input.slice(0, 10).toLowerCase();
}
