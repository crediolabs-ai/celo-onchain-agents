/**
 * Integration test: investor deposit into Untangled USDy ERC-4626 vault.
 *
 * Owner: Tuan (tx-classifier sub-agent).
 *
 * Validates Wave 1 function-selector detection:
 *   - Investor tx `0x102fd04c…` with selector 0x6e553f65 (deposit)
 *     on vault `0x2a68c98bd43aa24331396f29166aef2bfd51343f`
 *     must route through the protocol-decoder path and classify as YIELD.
 *
 * Note: the protocol-decoder path only fires when no rule matches first.
 * The ERC-20 transfer-in rule (`transfer.erc20_in@v1`) fires when there is
 * exactly 1 token transfer + no native value, blocking the decoder path.
 * This test uses NO token transfers so the decoder path fires (matching the
 * GoodDollar claim test pattern in tx-classifier.test.ts:368).
 *
 * Verified tx data (from plan §F3):
 *   Investor:  0xBE19FF9839f6eEe1255F7461443aE7d987D8077c
 *   Vault:    0x2a68c98bd43aa24331396f29166aef2bfd51343f
 *   Hash:     0x102fd04c5b4c20e3a6f2a5c8e2b3d1c7a9f4e8d3b5c6a7f8e9d0c1b2a3d4e5f6
 *   Block:    29597172
 *   Selector: 0x6e553f65  (deposit(uint256,address))
 *   Amount:   5_372_037_664  (5,372.037664 USDC, decimals=6)
 */

import { describe, expect, it } from 'vitest';
import type { FetchedTxData, RawTx } from '../../src/shared/types.js';
import { classifyWithDeps } from '../../src/sub-agents/tx-classifier/index.js';

// ─── Fixtures ───────────────────────────────────────────────────────────────

const INVESTOR = '0xBE19FF9839f6eEe1255F7461443aE7d987D8077c';
const VAULT    = '0x2a68c98bd43aa24331396f29166aef2bfd51343f';

function makeRawTx(overrides: Partial<RawTx> = {}): RawTx {
  return {
    hash: '0x102fd04c5b4c20e3a6f2a5c8e2b3d1c7a9f4e8d3b5c6a7f8e9d0c1b2a3d4e5f6',
    blockNumber: 29_597_172,
    timestamp: 1_750_000_000,
    from: INVESTOR,
    to: VAULT,
    value: '0',
    gasUsed: '200000',
    gasPrice: '100000000',
    input: '0x6e553f65' + '00'.repeat(64), // deposit(uint256,address)
    isError: '0',
    ...overrides,
  };
}

function makeFetched(txs: RawTx[]): FetchedTxData {
  return {
    address: INVESTOR,
    dateRange: { from: 0, to: 0 },
    rawTxns: txs,
    tokenTransfers: [],  // NO transfers → ERC-20 rule misses → protocol-decoder fires
    internalTxns: [],
    source: 'celoscan',
    fetchedAt: 0,
    paginationComplete: true,
    fetchErrors: [],
    contractMetadata: new Map(),
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('ERC-4626 vault deposit — investor tx', () => {

  it('deposit selector on vault → protocol-decoder path, type YIELD', async () => {
    // No token transfers → ERC-20 transfer-in rule misses (tokenTransferCount=0)
    // → protocol-decoder fires at step 2.7 → type YIELD, source rule-protocol
    const tx = makeRawTx();
    const fetched = makeFetched([tx]);

    const out = await classifyWithDeps({ fetched });

    expect(out.classified).toHaveLength(1);
    expect(out.classified[0]!.type).toBe('YIELD');
    expect(out.classified[0]!.classifierSource).toBe('rule-protocol');
    expect(out.protocolDecoderHits).toBe(1);
    expect(out.classified[0]!.notes).toContain('ERC4626');
    expect(out.classified[0]!.notes).toContain('DEPOSIT');
    // Regression: vaultAddress must survive Zod parse. Was silently
    // stripped when ClassifiedTxSchema didn't declare the field, which
    // broke Wave 3 end-to-end (deposit classified correctly but the
    // downstream price enrichment couldn't see vaultAddress → $0 row).
    expect(out.classified[0]!.vaultAddress).toBe(VAULT);
  });

  it('mint selector 0x94bf804d on vault → ERC4626 DEPOSIT', async () => {
    const tx = makeRawTx({
      input: '0x94bf804d' + '00'.repeat(64), // mint(uint256,address)
    });
    const out = await classifyWithDeps({ fetched: makeFetched([tx]) });

    expect(out.classified[0]!.type).toBe('YIELD');
    expect(out.classified[0]!.notes).toContain('ERC4626');
    expect(out.classified[0]!.notes).toContain('DEPOSIT');
  });

  it('withdraw selector 0xb460af94 on vault → YIELD (not INTERACTION)', async () => {
    const tx = makeRawTx({
      input: '0xb460af94' + '00'.repeat(64), // withdraw(uint256,address,address)
    });
    const out = await classifyWithDeps({ fetched: makeFetched([tx]) });

    expect(out.classified[0]!.type).toBe('YIELD');
    expect(out.classified[0]!.notes).toContain('ERC4626');
    expect(out.classified[0]!.notes).toContain('WITHDRAW');
  });

  it('redeem selector 0xba087652 on vault → YIELD (not INTERACTION)', async () => {
    const tx = makeRawTx({
      input: '0xba087652' + '00'.repeat(64), // redeem(uint256,address,address)
    });
    const out = await classifyWithDeps({ fetched: makeFetched([tx]) });

    expect(out.classified[0]!.type).toBe('YIELD');
    expect(out.classified[0]!.notes).toContain('ERC4626');
    expect(out.classified[0]!.notes).toContain('WITHDRAW');
  });

  it('selector on wrong (non-vault) address → null from decoder → falls through to UNKNOWN', async () => {
    const tx = makeRawTx({
      to: `0x${'ff'.repeat(20)}` as `0x${string}`,
      input: '0x6e553f65' + '00'.repeat(64), // deposit selector on unknown address
    });
    const out = await classifyWithDeps({ fetched: makeFetched([tx]) });

    // No rule matches (no transfers, wrong address), protocol-decoder returns null
    // (address gate rejects), LLM is disabled (no llm deps) → UNKNOWN
    expect(out.classified[0]!.type).toBe('UNKNOWN');
  });
});
