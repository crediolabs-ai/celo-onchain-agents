/**
 * Pipeline core — shared classification + FIFO PNL engine for the tax tools.
 * Standalone: NO imports from ../../src.
 *
 * Exchange rates (hardcoded): NGN=1550/USD, KES=153/USD (per planner rec).
 * Tax rules: NG FIRS 10% CGT on realized gains net of gas; KE KRA 5% DAT on gross
 * transfer value above 1M KES threshold. OTHER: totals only.
 */

// ─── Constants ────────────────────────────────────────────────────────────────

export const USD_TO_NGN = 1550;
export const USD_TO_KES = 153;
export const DEFAULT_DECIMALS: Record<string, number> = {
  CELO: 18, cUSD: 18, cEUR: 18, cREAL: 18, USDC: 6, USDT: 6,
};

const UBESWAP_ROUTER = '0x6索29e8Ae8aT96D4d381A86b8E8C4dC6e5b7d8F'; // placeholder; real addr in contracts.ts
const MENTO_BROKER = '0x937b2449dCD4D4Da5CBBc08f9D6fA45e8B3D3d3d';
const MENTO_ROUTER = '0x977645143B09b0D0d2d03D3D6d44f3Da8C7e9e9';

// ─── Shared types ────────────────────────────────────────────────────────────

export type TxType = 'INCOME'|'SWAP'|'TRANSFER_IN'|'TRANSFER_OUT'|'YIELD'|
  'GAS'|'MINT'|'BURN'|'BRIDGE'|'MENTO_STABILITY'|'INTERACTION'|'UNKNOWN';
export type ClassifierSource = 'rule' | 'flagged';

export interface RawTx {
  hash: string; blockNumber: number; timestamp: number;
  from: string; to: string | null; value: string; gasUsed: string;
  gasPrice: string; input: string; methodName?: string; isError: '0' | '1';
}
export interface TokenTransfer {
  hash: string; blockNumber: number; timestamp: number;
  from: string; to: string; contractAddress: string;
  tokenSymbol: string; tokenDecimals: number; value: string;
}
export interface InternalTx {
  hash: string; blockNumber: number; timestamp: number;
  from: string; to: string; value: string;
}
export interface AssetLeg { symbol: string; amount: string; priceUsd: number; }
export interface ClassifiedTx {
  hash: string; type: TxType; timestamp: number;
  assetIn?: AssetLeg; assetOut?: AssetLeg;
  classifierSource: ClassifierSource; confidence?: number; notes?: string;
}
export interface Disposal {
  amount: bigint; symbol: string;
  proceedsMicroUsd: bigint; costBasisMicroUsd: bigint; gainMicroUsd: bigint;
  sourceHash: string; lotSourceHash: string;
  disposalPriceUsd: number; lotPriceUsd: number; timestamp: number;
}
export interface PriceGap { asset: string; timestamp: number; }
export interface JurisdictionTaxResult {
  realizedGainsUsd: number; incomeUsd: number; yieldUsd: number;
  deductibleGasUsd: number; taxableIncomeUsd: number;
  cgtUsd?: number; cgtNgn?: number; incomeTaxUsd?: number; totalNgn?: number;
  datKes?: number; totalKes?: number; reportUsd?: number;
}
export interface ClassifyAndComputeTaxResult {
  realized: number; unrealized: number; taxable: number;
  breakdown: { realizedGainsUsd: number; incomeUsd: number; yieldUsd: number;
    deductibleGasUsd: number; taxableIncomeUsd: number };
  taxDue: JurisdictionTaxResult;
  perAsset: Record<string, { realized: number; unrealized: number;
    income: number; yield_: number }>;
  priceGaps: PriceGap[]; disposalsCount: number;
  methodJurisdictionCompat: { method: string; jurisdiction: string;
    ok: boolean; reason?: string }[];
}

// ─── Predicate DSL ───────────────────────────────────────────────────────────

interface PredicateContext { tx: RawTx; transfers: TokenTransfer[];
  internal: InternalTx[]; address: string; }

type Predicate =
  | { kind: 'allOf'; children: Predicate[] }
  | { kind: 'anyOf'; children: Predicate[] }
  | { kind: 'not'; child: Predicate }
  | { kind: 'hasMethod'; method: string }
  | { kind: 'toIn'; refs: string[] }
  | { kind: 'tokenSymbolIn'; symbols: string[] }
  | { kind: 'tokenTransferCount'; op: 'eq' | 'gt' | 'lt'; value: number }
  | { kind: 'nativeDirection'; is: 'in' | 'out' | 'self' | 'none' }
  | { kind: 'valueGt'; amount: string }
  | { kind: 'valueLt'; amount: string }
  | { kind: 'isError'; is: boolean }
  | { kind: 'isContractCreation'; is: boolean };

function evaluatePredicate(p: Predicate, ctx: PredicateContext): boolean {
  switch (p.kind) {
    case 'allOf': return p.children.every(c => evaluatePredicate(c, ctx));
    case 'anyOf': return p.children.some(c => evaluatePredicate(c, ctx));
    case 'not': return !evaluatePredicate(p.child, ctx);
    case 'hasMethod': return ctx.tx.methodName === p.method;
    case 'toIn': {
      if (!ctx.tx.to) return false;
      const lower = ctx.tx.to.toLowerCase();
      const addrMap: Record<string, string> = {
        ubeswap_v2_router: UBESWAP_ROUTER.toLowerCase(),
        mento_broker: MENTO_BROKER.toLowerCase(),
        mento_router: MENTO_ROUTER.toLowerCase(),
      };
      return p.refs.some(r => addrMap[r.toLowerCase()] === lower);
    }
    case 'tokenSymbolIn': return ctx.transfers.some(t => p.symbols.includes(t.tokenSymbol));
    case 'tokenTransferCount': {
      const n = ctx.transfers.length;
      return p.op === 'eq' ? n === p.value : p.op === 'gt' ? n > p.value : n < p.value;
    }
    case 'nativeDirection': {
      const fromMe = ctx.tx.from.toLowerCase() === ctx.address.toLowerCase();
      const toMe = ctx.tx.to?.toLowerCase() === ctx.address.toLowerCase();
      const hasValue = BigInt(ctx.tx.value) > 0n;
      const dir = !hasValue ? 'none' : (fromMe && toMe) ? 'self' : toMe ? 'in' : fromMe ? 'out' : 'none';
      return dir === p.is;
    }
    case 'valueGt': { try { return BigInt(ctx.tx.value) > BigInt(p.amount); } catch { return false; } }
    case 'valueLt': { try { return BigInt(ctx.tx.value) < BigInt(p.amount); } catch { return false; } }
    case 'isError': return (ctx.tx.isError === '1') === p.is;
    case 'isContractCreation': return (ctx.tx.to === null) === p.is;
  }
}

// ─── Rule engine ─────────────────────────────────────────────────────────────

interface Rule {
  id: string; matches: Predicate; classify: TxType;
  jurisdiction?: string[]; confidence: number; notes?: string;
}

/** Ported rules — skips LLM/protocol-decoder/selector-registry paths (not available standalone). */
const RULES: Rule[] = [
  // INCOME: stablecoin incoming, no CELO out (payroll pattern)
  { id: 'income.stablecoin_in@v1', matches: { kind: 'allOf', children: [
    { kind: 'tokenSymbolIn', symbols: ['USDC','cUSD','USDT'] },
    { kind: 'nativeDirection', is: 'in' }, { kind: 'isError', is: false }] },
    classify: 'INCOME', jurisdiction: ['NG','KE'], confidence: 0.75 },
  // SWAP: DEX router + 2+ token transfers
  { id: 'swap.dex@v1', matches: { kind: 'allOf', children: [
    { kind: 'toIn', refs: ['UBESWAP_V2_ROUTER','MENTO_BROKER','MENTO_ROUTER'] },
    { kind: 'tokenTransferCount', op: 'gt', value: 1 }, { kind: 'isError', is: false }] },
    classify: 'SWAP', confidence: 0.92 },
  // TRANSFER_OUT: native CELO out, no token transfers, not contract creation
  { id: 'transfer.native_out@v1', matches: { kind: 'allOf', children: [
    { kind: 'tokenTransferCount', op: 'eq', value: 0 }, { kind: 'nativeDirection', is: 'out' },
    { kind: 'valueGt', amount: '0' }, { kind: 'isError', is: false },
    { kind: 'isContractCreation', is: false }] },
    classify: 'TRANSFER_OUT', confidence: 0.98 },
  // TRANSFER_IN: native CELO in, no token transfers
  { id: 'transfer.native_in@v1', matches: { kind: 'allOf', children: [
    { kind: 'tokenTransferCount', op: 'eq', value: 0 }, { kind: 'nativeDirection', is: 'in' },
    { kind: 'valueGt', amount: '0' }, { kind: 'isError', is: false }] },
    classify: 'TRANSFER_IN', confidence: 0.98 },
  // TRANSFER_OUT: ERC-20 transfer() call, no native movement, 1 transfer
  { id: 'transfer.erc20_out@v1', matches: { kind: 'allOf', children: [
    { kind: 'tokenTransferCount', op: 'eq', value: 1 }, { kind: 'nativeDirection', is: 'none' },
    { kind: 'hasMethod', method: 'transfer' }, { kind: 'isError', is: false }] },
    classify: 'TRANSFER_OUT', confidence: 0.97 },
  // TRANSFER_IN: single ERC-20 received, no native movement
  { id: 'transfer.erc20_in@v1', matches: { kind: 'allOf', children: [
    { kind: 'tokenTransferCount', op: 'eq', value: 1 }, { kind: 'nativeDirection', is: 'none' },
    { kind: 'isError', is: false }] },
    classify: 'TRANSFER_IN', confidence: 0.85 },
  // YIELD: small periodic incoming (< 1 CELO)
  { id: 'yield.staking@v1', matches: { kind: 'allOf', children: [
    { kind: 'nativeDirection', is: 'in' }, { kind: 'valueLt', amount: '1000000000000000000' },
    { kind: 'isError', is: false }] },
    classify: 'YIELD', confidence: 0.88 },
  // GAS: self-send
  { id: 'gas.self@v1', matches: { kind: 'allOf', children: [
    { kind: 'nativeDirection', is: 'self' }, { kind: 'isError', is: false }] },
    classify: 'GAS', confidence: 0.85 },
];

function findMatchingRule(ctx: PredicateContext, jurisdiction?: string): Rule | null {
  for (const rule of RULES) {
    if (rule.jurisdiction && jurisdiction && !rule.jurisdiction.includes(jurisdiction)) continue;
    if (evaluatePredicate(rule.matches, ctx)) return rule;
  }
  return null;
}

// ─── FIFO engine ─────────────────────────────────────────────────────────────

interface AssetLot {
  amount: bigint; costBasisMicroUsd: bigint; sourceHash: string;
  source: 'rule'|'aggregated'|'unknown'; timestamp: number; priceUsd: number;
}

function computeFifo(
  classified: ClassifiedTx[],
  decimalsBySymbol: Record<string, number>,
) {
  const lots = new Map<string, AssetLot[]>();
  const disposals: Disposal[] = [];
  const realizedPnlMicroUsdByAsset: Record<string, bigint> = {};
  let incomeMicroUsdTotal = 0n, yieldMicroUsdTotal = 0n, gasMicroUsdTotal = 0n;
  const priceGaps: PriceGap[] = [];

  for (const c of classified) {
    const isAcq = c.type === 'INCOME' || c.type === 'YIELD' || c.type === 'MINT';
    const isDisposal = c.type === 'TRANSFER_OUT' || c.type === 'SWAP';

    if (isAcq && c.assetIn) {
      const sym = c.assetIn.symbol;
      const decimals = decimalsBySymbol[sym] ?? 18;
      const lot: AssetLot = {
        amount: BigInt(c.assetIn.amount),
        costBasisMicroUsd: BigInt(Math.round(c.assetIn.priceUsd * 1e6 * Number(c.assetIn.amount))),
        sourceHash: c.hash, source: c.classifierSource as AssetLot['source'],
        timestamp: c.timestamp, priceUsd: c.assetIn.priceUsd,
      };
      const q = lots.get(sym) ?? []; q.push(lot); lots.set(sym, q);
      if (c.type === 'INCOME') incomeMicroUsdTotal += lot.costBasisMicroUsd;
      if (c.type === 'YIELD') yieldMicroUsdTotal += lot.costBasisMicroUsd;
      continue;
    }

    if (isDisposal && c.assetOut) {
      const sym = c.assetOut.symbol;
      const decimals = decimalsBySymbol[sym] ?? 18;
      const decAdj = BigInt(10) ** BigInt(decimals);
      const queue = lots.get(sym) ?? [];
      let remaining = BigInt(c.assetOut.amount);
      const priceMicro = BigInt(Math.round(c.assetOut.priceUsd * 1e6));

      while (remaining > 0n && queue.length > 0) {
        const front = queue[0]!;
        const take = remaining < front.amount ? remaining : front.amount;
        const costBasisMicro = (front.costBasisMicroUsd * take) / front.amount;
        const proceedsMicro = (priceMicro * take) / decAdj;
        const gainMicro = proceedsMicro - costBasisMicro;
        const lotPriceUsd = front.amount === 0n ? 0 : Number(front.costBasisMicroUsd) / Number(front.amount) / 1e6;

        disposals.push({ amount: take, symbol: sym, proceedsMicroUsd: proceedsMicro,
          costBasisMicroUsd: costBasisMicro, gainMicroUsd: gainMicro,
          sourceHash: c.hash, lotSourceHash: front.sourceHash,
          disposalPriceUsd: c.assetOut.priceUsd, lotPriceUsd,
          timestamp: c.timestamp });

        realizedPnlMicroUsdByAsset[sym] = (realizedPnlMicroUsdByAsset[sym] ?? 0n) + gainMicro;

        if (take === front.amount) { queue.shift(); }
        else {
          queue[0] = { ...front, amount: front.amount - take,
            costBasisMicroUsd: front.costBasisMicroUsd - costBasisMicro };
        }
        remaining -= take;
      }
      if (remaining > 0n) priceGaps.push({ asset: sym, timestamp: c.timestamp });
      continue;
    }

    if (c.type === 'GAS') { gasMicroUsdTotal += 0n; }
  }

  return { disposals, remainingLots: lots, realizedPnlMicroUsdByAsset,
    incomeMicroUsdTotal, yieldMicroUsdTotal, gasMicroUsdTotal, priceGaps };
}

// ─── Jurisdiction tax ─────────────────────────────────────────────────────────

function computeJurisdictionTax(
  jurisdiction: 'NG' | 'KE' | 'OTHER',
  realized: number, income: number, yield_: number, gas: number,
  disposals: Disposal[],
): JurisdictionTaxResult {
  const base: JurisdictionTaxResult = {
    realizedGainsUsd: realized, incomeUsd: income, yieldUsd: yield_,
    deductibleGasUsd: gas, taxableIncomeUsd: realized + income - gas,
  };
  if (jurisdiction === 'NG') {
    const cgtUsd = Math.max(0, realized - gas) * 0.10;
    return { ...base, cgtUsd, cgtNgn: cgtUsd * USD_TO_NGN, totalNgn: cgtUsd * USD_TO_NGN };
  }
  if (jurisdiction === 'KE') {
    const grossUsd = disposals.reduce((s, d) => s + Number(d.proceedsMicroUsd) / 1e6, 0);
    const datKes = grossUsd * USD_TO_KES > 1_000_000 ? grossUsd * USD_TO_KES * 0.05 : 0;
    return { ...base, datKes, totalKes: datKes };
  }
  return { ...base, reportUsd: realized };
}

// ─── Main pipeline ───────────────────────────────────────────────────────────

/**
 * Classify raw txs via rules, then compute FIFO PNL + jurisdiction tax.
 *
 * @param priceBySymbolAndDate  e.g. prices['CELO']['2025-03-15'] = 0.82
 */
export function classifyAndComputeTax(
  rawTxs: RawTx[],
  tokenTransfers: TokenTransfer[],
  _internalTxns: InternalTx[], // reserved for future use
  address: string,
  taxYear: number,
  jurisdiction: 'NG' | 'KE' | 'OTHER',
  method: 'FIFO' | 'LIFO' | 'WAC',
  priceBySymbolAndDate: Record<string, Record<string, number>>,
): ClassifyAndComputeTaxResult {
  const byHash = new Map<string, TokenTransfer[]>();
  for (const t of tokenTransfers) { const b = byHash.get(t.hash) ?? []; b.push(t); byHash.set(t.hash, b); }

  const yearStart = new Date(taxYear, 0, 1).getTime() / 1000;
  const yearEnd = new Date(taxYear, 11, 31, 23, 59, 59).getTime() / 1000;
  const yearTxs = rawTxs.filter(tx => tx.timestamp >= yearStart && tx.timestamp <= yearEnd);

  const classified: ClassifiedTx[] = [];
  for (const tx of yearTxs) {
    const transfers = byHash.get(tx.hash) ?? [];
    const ctx: PredicateContext = { tx, transfers, internal: [], address };
    const rule = findMatchingRule(ctx, jurisdiction);

    if (rule) {
      const ct: ClassifiedTx = { hash: tx.hash, type: rule.classify, timestamp: tx.timestamp,
        classifierSource: rule.confidence < 0.7 ? 'flagged' : 'rule', confidence: rule.confidence };

      if (transfers.length > 0) {
        const sym = transfers[0]!.tokenSymbol;
        const dateStr = new Date(tx.timestamp * 1000).toISOString().split('T')[0]!;
        const price = priceBySymbolAndDate[sym]?.[dateStr] ?? 0;
        const amt = transfers.reduce((s, t) => s + BigInt(t.value), 0n).toString();
        if (rule.classify === 'INCOME' || rule.classify === 'YIELD') {
          ct.assetIn = { symbol: sym, amount: amt, priceUsd: price };
        } else {
          ct.assetOut = { symbol: sym, amount: amt, priceUsd: price };
        }
      }

      // Native CELO leg when no transfers but native value moved
      if (Number(tx.value) > 0 && !transfers.length) {
        const dateStr = new Date(tx.timestamp * 1000).toISOString().split('T')[0]!;
        const price = priceBySymbolAndDate['CELO']?.[dateStr] ?? 0;
        if (rule.classify === 'TRANSFER_IN' || rule.classify === 'YIELD') {
          ct.assetIn = { symbol: 'CELO', amount: tx.value, priceUsd: price };
        } else if (rule.classify === 'TRANSFER_OUT' || rule.classify === 'GAS') {
          ct.assetOut = { symbol: 'CELO', amount: tx.value, priceUsd: price };
        }
      }
      classified.push(ct);
    } else {
      classified.push({ hash: tx.hash, type: 'UNKNOWN', timestamp: tx.timestamp,
        classifierSource: 'flagged', notes: 'No rule matched' });
    }
  }

  const fifoResult = computeFifo(classified, DEFAULT_DECIMALS);

  const perAsset: Record<string, { realized: number; unrealized: number; income: number; yield_: number }> = {};
  for (const sym of Object.keys(DEFAULT_DECIMALS)) perAsset[sym] = { realized: 0, unrealized: 0, income: 0, yield_: 0 };
  for (const [sym, gainMicro] of Object.entries(fifoResult.realizedPnlMicroUsdByAsset)) {
    const r = Number(gainMicro) / 1e6;
    perAsset[sym] ? perAsset[sym].realized = r : perAsset[sym] = { realized: r, unrealized: 0, income: 0, yield_: 0 };
  }

  const realized = Object.values(fifoResult.realizedPnlMicroUsdByAsset).reduce((s, v) => s + Number(v) / 1e6, 0);
  const income = Number(fifoResult.incomeMicroUsdTotal) / 1e6;
  const yield_ = Number(fifoResult.yieldMicroUsdTotal) / 1e6;
  const gas = Number(fifoResult.gasMicroUsdTotal) / 1e6;
  const taxable = realized + income - gas;

  const taxDue = computeJurisdictionTax(jurisdiction, realized, income, yield_, gas, fifoResult.disposals);

  return {
    realized, unrealized: 0, taxable,
    breakdown: { realizedGainsUsd: realized, incomeUsd: income, yieldUsd: yield_,
      deductibleGasUsd: gas, taxableIncomeUsd: taxable },
    taxDue,
    perAsset,
    priceGaps: fifoResult.priceGaps,
    disposalsCount: fifoResult.disposals.length,
    methodJurisdictionCompat: [
      { method: 'FIFO', jurisdiction, ok: true },
      { method: 'LIFO', jurisdiction, ok: jurisdiction !== 'NG',
        reason: jurisdiction === 'NG' ? 'LIFO not permitted under NG FIRS' : undefined },
      { method: 'WAC', jurisdiction, ok: false, reason: 'WAC not supported' },
    ],
  };
}
