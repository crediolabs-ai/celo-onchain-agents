# Credio Build Review — Agent 06 (2026-06-10)

**Reviewer:** Tuan
**Scope:** tx-fetcher sub-agent, CLI, infra (wallet / log-emitter / erc8004), production wiring

---

## Verdict

Approve-with-fixes. The implementation is solid overall — no type errors, clean error boundaries, well-isolated deps, and good test coverage. One bug is demo-blocking: the `--refresh` CLI flag is defined but completely unwired, so the cache cannot be bypassed at runtime. Two correctness concerns (type widening in wallet.ts, the second `now()` call in fetchTxs) are worth fixing before the judges read the code. Everything else is nit-level.

---

## Summary Table

| File | 🔴 must-fix | 🟡 should-fix | 🟠 nit |
|------|-------------|---------------|--------|
| `src/cli/index.ts` | `--refresh` flag has no effect | — | `addr` placeholder vs `address` option name mismatch |
| `src/infra/wallet.ts` | — | `chain as Chain` type widening; `WalletError` message lacks method name | — |
| `src/sub-agents/tx-fetcher/index.ts` | — | `now` called twice (minor race if clock drifts mid-function) | — |
| `src/sub-agents/tx-fetcher/celoscan.ts` | — | — | `fetchPage` return type cast is opaque but safe |
| `src/sub-agents/tx-fetcher/cache.ts` | — | — | None |
| `src/sub-agents/tx-fetcher/pagination.ts` | — | — | None |
| `src/sub-agents/tx-fetcher/types.ts` | — | — | None |
| `src/infra/log-emitter.ts` | — | — | None |
| `src/infra/erc8004.ts` | — | — | `registerAgent` stub logs to `console.info` in test env |
| `src/orchestrator/production.ts` | — | — | `resolveNetwork` is an identity function — dead code |
| *Tests* | — | Cache module not exercised by `tx-fetcher.test.ts` | Missing integration test for parallel `Promise.allSettled` failure path |

---

## `src/cli/index.ts`

### 🟡 should-fix

**`--refresh` has no effect.** The flag is declared at line 55 and parsed at line 79, but `args.refresh` is immediately voided at line 166 with a TODO comment promising future wiring. The production deps in `production.ts` do not receive a cache-bypass flag, and `fetchTxs` has no mechanism to honour one. A user who re-runs the CLI expecting to bypass the cache will get stale data silently.

- **Line 166:** `void args.refresh;`

**Fix:** Pass a cache-bypass signal through `makeProductionDeps` → `PipelineDeps` → `fetchTxs`. The simplest path: add a `refresh?: boolean` field to `FetchTxsDeps` and have `fetchTxs` skip the cache read when `true`.

---

### 🟠 nit

**Option name mismatch in help text.** `--address <addr>` uses the placeholder `addr` in the usage string (line 48), but Commander resolves the actual option name from the flag itself (`--address`). This is cosmetic — Commander will still print the correct flag name — but it's slightly confusing in the help output.

- **Line 48:** `.requiredOption('--address <addr>', ...)` — the `<addr>` placeholder is not what the user types

---

## `src/infra/wallet.ts`

### 🟡 should-fix

**`chain as Chain` type widening is unsound.** `AgentWallet.chain` is typed as `Chain` (viem's base interface) but stores a value of type `typeof celoAlfajores | typeof celo`. The cast at line 135 widens to the base type to suppress viem's mismatched `getBlock` schema between pre-L2 and post-L2 chains. This works at runtime because viem clients are structurally compatible, but if viem ever adds a required field to `Chain` that differs between these two union members, the cast would be unsound. The code comment (lines 131–135) acknowledges the issue.

- **Line 135:** `const chainForClient = chain as Chain;`

**Fix:** Keep the cast but add a `// Safety: Chain is the base interface; both celo and celoAlfajores satisfy it at runtime` comment explaining why this is safe. Better: narrow the union in `AppConfig.chain` itself so the cast is provably safe.

---

**`WalletError` messages omit the operation name.** Both `sendTransaction` and `writeContract` wrap errors with only the target address — a developer debugging a failure has no way to tell from the error message which operation (send vs write) failed without parsing the `cause`.

- **Line 194:** `throw new WalletError(\`sendTransaction to ${tx.to} failed\`, err);`
- **Line 210:** `throw new WalletError(\`writeContract to ${target} failed\`, err);`

**Fix:** Include the operation name: `"sendTransaction to ${tx.to} failed"` → `"wallet.sendTransaction to ${tx.to} failed"`.

---

## `src/sub-agents/tx-fetcher/index.ts`

### 🟡 should-fix

**`now` can be called twice with different values.** `now` is assigned at line 79 as `deps.now ?? (() => Math.floor(Date.now() / 1000))`. It is called once to compute `dateRange.to` (line 111) and again to compute `fetchedAt` (line 117). If `now` is the default `() => Math.floor(Date.now() / 1000)` and the function is slow enough that `Date.now()` advances between the two calls, `fetchedAt` will be 1 second ahead of `dateRange.to`. This is cosmetic but inconsistent.

- **Line 111:** `to: (request.dateRange?.to ?? now()) as Timestamp,`
- **Line 117:** `fetchedAt: now() as Timestamp,`

**Fix:** Capture `now()` once: `const ts = now();` and use `ts` for both fields.

---

### 🟠 nit

**Test gap: cache module not exercised in `tx-fetcher.test.ts`.** `createTxCache` is imported and used in `index.ts` but `tx-fetcher.test.ts` does not directly test the cache's `write`/`read`/`clear` methods or the atomic-write safety (concurrent writes, crash-recovery via `.tmp` rename). The integration test covers a cache hit/miss, but not edge cases like a half-written file after a crash.

**Fix:** Add unit tests for `createTxCache` covering: `read` returns `null` on `ENOENT`; `read` throws on other errors; `write` produces a file; `write` then `read` round-trips correctly; `clear` is idempotent.

---

## `src/sub-agents/tx-fetcher/celoscan.ts`

### 🟠 nit

**Opaque generic return-type cast in `fetchPage`.** The return expression `body.result ?? ([] as unknown as T)` uses a double cast to satisfy the generic. This is intentional (the caller knows the shape) but the double cast makes type safety invisible. Not a bug — `unknown` as an intermediate cast is the correct pattern here — but worth a comment.

- **Line 94:** `return body.result ?? ([] as unknown as T);`

---

## `src/sub-agents/tx-fetcher/cache.ts`

No findings. Atomic write pattern (`.tmp` → `rename`) is correct.

---

## `src/sub-agents/tx-fetcher/pagination.ts`

No findings. Short-page detection via `rows.length < client.maxPageSize` is correct.

---

## `src/sub-agents/tx-fetcher/types.ts`

No findings. Normalizers are correct.

---

## `src/infra/log-emitter.ts`

No findings. `buildLogPayload` correctly clamps negatives, `createLogEmitter` correctly sends 0-value self-tx with ASCII payload, and `WalletError` wrapping is in place.

---

## `src/infra/erc8004.ts`

### 🟠 nit

**`registerAgent` stub logs to `console.info`.** In test environments (`erc8004.test.ts` line 103), `console.info` is spied on and must be restored. In production, this logs the Celoscan URL to stdout for every agent run. This is fine for a hackathon (it's a link-display), but worth noting the `console` dependency is not injectable and not tested for the non-stub path.

---

## `src/orchestrator/production.ts`

### 🟠 nit

**`resolveNetwork` is a no-op identity function.** It takes a `config.network` of type `'alfajores' | 'mainnet'` and returns it unchanged as `Network`. The sole comment suggests it was intended to translate a Celo Sepolia chainId, but it doesn't. It adds cognitive overhead for a reader with no runtime effect.

- **Lines 65–67:** `export function resolveNetwork(network: AppConfig['network']): Network { return network; }`

---

## Test Quality Assessment

| Test file | Coverage quality |
|-----------|-----------------|
| `tests/unit/tx-fetcher.test.ts` | Good — cache hit/miss, per-endpoint error, shape verification. Missing: direct cache module tests. |
| `tests/unit/wallet.test.ts` | Good — construction, signMessage determinism, error wrapping. `hasGas` tested via math rather than RPC stub, which is acceptable. |
| `tests/unit/log-emitter.test.ts` | Excellent — payload encoding edge cases (negative clamp, missing year, 2dp), hex round-trip, WalletError wrapping. |
| `tests/unit/erc8004.test.ts` | Good — metadata shape, per-network URL, stub return, zero-address guard. |

**Notable test gap:** No test exercises the `Promise.allSettled` path where two or more endpoints fail simultaneously. The existing test (`per-endpoint failures land in fetchErrors`) covers one failure, but doesn't verify that `fetchErrors` gets multiple entries when all three fail concurrently.

---

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| `--refresh` does nothing | High (confirmed bug) | Medium — stale data served | Wire `refresh` through `PipelineDeps` |
| `now()` called twice, clock drift | Low | Low — cosmetic only | Capture once |
| `chain as Chain` unsoundness | Low — viem structurally compatible | Low — runtime correct | Add safety comment |
| Cache atomic write failure | Low — `rename` is atomic on POSIX | Medium — corrupt cache file | `.tmp` rename pattern is correct |

---

**Status:** DONE_WITH_CONCERNS

The codebase is production-quality for a hackathon submission. The `--refresh` bug is the only item that would embarrass in a demo (a user trying to refresh gets stale data). The rest are correctness nits or test gaps that don't affect runtime behavior.
