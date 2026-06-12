/**
 * Protocol action type definitions — shared interface between the decoder
 * and the classifier's integration layer.
 *
 * Owner: Tuan (tx-classifier sub-agent).
 */

import type { TxType } from '../../shared/types.js';

/** Protocols covered by the semantic decoder. */
export enum ProtocolName {
  MENTO = 'MENTO',
  UBESWAP = 'UBESWAP',
  MOOLA = 'MOOLA',
  GOODDOLLAR = 'GOODDOLLAR',
  ERC4626 = 'ERC4626',
}

/** Top-level actions decoded per protocol. */
export enum ProtocolActionType {
  SWAP = 'SWAP',
  DEPOSIT = 'DEPOSIT',
  WITHDRAW = 'WITHDRAW',
  MINT = 'MINT',
  BURN = 'BURN',
  CLAIM_YIELD = 'CLAIM_YIELD',
  STAKE = 'STAKE',
  UNSTAKE = 'UNSTAKE',
}

/** Result of decodeProtocolAction(). */
export interface ProtocolAction {
  protocol: ProtocolName;
  action: ProtocolActionType;
  /** Confidence the semantics were decoded correctly. */
  confidence: number;
  /** Function name that drove the match (e.g. "swapExactIn"). */
  functionName: string;
}

/**
 * Maps (protocol, action) → ClassifiedTx.type for integration with the
 * existing classifier. Unknown combinations fall back to INTERACTION.
 */
export function protocolActionToTxType(
  protocol: ProtocolName,
  action: ProtocolActionType,
): TxType {
  switch (protocol) {
    case ProtocolName.MENTO:
    case ProtocolName.UBESWAP:
      switch (action) {
        case ProtocolActionType.SWAP:      return 'SWAP';
        case ProtocolActionType.DEPOSIT:    return 'YIELD';
        case ProtocolActionType.WITHDRAW:   return 'YIELD';
        default:                            return 'INTERACTION';
      }
    case ProtocolName.MOOLA:
      switch (action) {
        case ProtocolActionType.MINT:        return 'YIELD';
        case ProtocolActionType.BURN:        return 'YIELD';
        case ProtocolActionType.DEPOSIT:     return 'YIELD';
        case ProtocolActionType.WITHDRAW:    return 'YIELD';
        case ProtocolActionType.CLAIM_YIELD: return 'YIELD';
        default:                             return 'INTERACTION';
      }
    case ProtocolName.GOODDOLLAR:
      switch (action) {
        case ProtocolActionType.CLAIM_YIELD: return 'YIELD';
        default:                             return 'INTERACTION';
      }
    case ProtocolName.ERC4626:
      switch (action) {
        case ProtocolActionType.DEPOSIT:  return 'YIELD';
        case ProtocolActionType.WITHDRAW: return 'YIELD';
        default:                          return 'INTERACTION';
      }
  }
}
