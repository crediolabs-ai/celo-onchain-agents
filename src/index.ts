/**
 * Public package entrypoint.
 *
 * Sub-agents and the orchestrator import from here for shared types/config.
 * Do not export internals that are not part of the interface contract.
 */

export * from './shared/types.js';
export * from './shared/errors.js';
export { loadConfig, type AppConfig, type RawEnv } from './shared/config.js';
export {
  httpFetch,
  httpRequest,
  type HttpRequestOptions,
  type HttpResponse,
} from './shared/http.js';
export {
  NAMED_CONTRACTS,
  makeContractLookup,
  makeContractLookupForChain,
  CELO_NATIVE,
  CUSD_MENTO,
  CEUR_MENTO,
  CREAL_MENTO,
  USDC_BRIDGED,
  USDT_BRIDGED,
  CELO_NATIVE_TOKENS,
  type ContractAlias,
  type ContractLookup,
  type NamedContract,
  type Network,
} from './shared/contracts.js';
