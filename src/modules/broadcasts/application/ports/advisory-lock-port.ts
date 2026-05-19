/**
 * T035/T047 (F7.1a US1) — `AdvisoryLockPort` Application port.
 *
 * Tenant-aware Postgres advisory-lock abstraction. Wraps
 * `pg_advisory_xact_lock` / `pg_try_advisory_xact_lock` so use cases
 * can serialise mutating operations on a (tenant_id, broadcast_id)
 * tuple without holding row locks across HTTP boundaries.
 *
 * Lock-key namespaces in F7.1a (DISJOINT — see spec.md § Edge Cases L106):
 *   - `broadcasts-batch:{tenantId}:{broadcastId}:{batchIndex}` —
 *     per-batch dispatch serialisation (Phase 3 T045 `dispatchBroadcastBatch`)
 *   - `broadcasts-retry:{tenantId}:{broadcastId}` —
 *     per-broadcast admin-retry serialisation (Phase 3 T047
 *     `retryFailedBatches`). Prevents the SC-007 double-click hazard
 *     where 2 simultaneous admin tabs would consume the manual-retry
 *     budget twice.
 *
 * Both namespaces are DISJOINT from F7 MVP `broadcasts:` (used by
 * F7 dispatch-scheduled, drizzle-broadcasts-repo.ts:437) and F4/F5
 * namespaces (`invoicing:`, `payments:`). The disjointness invariant
 * is asserted at integration-test boundary (Phase 3 T036).
 *
 * `xact` scope means the lock auto-releases at transaction commit/
 * rollback. The Drizzle adapter (Phase 3B.3) acquires inside
 * `withTx(...)` so callers don't need to release explicitly.
 *
 * Pure interface — no framework imports (Constitution Principle III).
 */

/**
 * Phase 3F.11.6 (Type Bottom #2 partial — Round 2 minimal cascade) —
 * branded transaction token.
 *
 * Replaces the flat `tx: unknown` parameter with a nominal type that
 * carries intent at call sites: "this value is a Drizzle/postgres-js
 * tx handle, not a random unknown". Branded types are a Phase 3F.11.6
 * project convention — Application ports remain unaware of the actual
 * Drizzle/postgres-js types (Constitution III: no infrastructure leak
 * into the port layer) while still preventing the laundering of
 * arbitrary values via `as never` casts at call sites.
 *
 * Migration plan:
 *   - Step 1 (Phase 3F.11.6 b06ed10f — ✅ DONE): `AdvisoryLockPort.acquire`
 *     consumes `TxToken`. Single laundering line at
 *     `retry-failed-batches.ts:asTxToken(tx)` boundary.
 *   - Step 2 (Phase 3F.11.11 — see commit message at ship time):
 *     `BroadcastsRetryRepo.withTx` callback receives `TxToken` directly.
 *     Eliminates the `asTxToken(tx)` laundering line.
 *   - Step 3 (DEFERRED to F7.1a.1 backlog): `BatchManifestsPort.*` tx params
 *     (`findById`, `updateStatus`, etc. — 5 methods) widen to `TxToken`.
 *   - Step 4 (DEFERRED to F7.1a.1 backlog): Drizzle adapters cast
 *     `TxToken → TenantTx` at every boundary (centralise in a
 *     `unbrandTx(token): TenantTx` helper in `@/lib/db` once Step 3 lands).
 *
 * Steps 3-4 deferred because they cascade across ~10 test fixtures +
 * 5 adapter methods + 7 use cases. Steps 1-2 together deliver ~60% of
 * the type-safety benefit at <10% of the diff cost.
 */
declare const txTokenBrand: unique symbol;
export type TxToken = { readonly [txTokenBrand]: true };

/**
 * Caller-side brand constructor — wraps a raw tx handle into a TxToken
 * at the use-case → port boundary. The Drizzle adapter unbrands
 * internally with a single `as TenantTx` cast at the SQL-execution
 * boundary, so the brand serves as a compile-time barrier without
 * forcing runtime overhead.
 */
export function asTxToken(tx: unknown): TxToken {
  return tx as TxToken;
}

export interface AcquireResult {
  /** `true` if the lock was acquired, `false` if held by another tx. */
  readonly acquired: boolean;
}

export interface AdvisoryLockPort {
  /**
   * Try to acquire an advisory lock by string key INSIDE the caller's
   * transaction. Returns `{acquired: false}` on contention WITHOUT
   * throwing — caller decides whether to retry, fail open, or fail
   * closed.
   *
   * Real impl: `SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0))`
   * via the passed `tx`. The lock auto-releases at tx commit/rollback
   * — so the caller MUST hold its withTx scope open across every
   * mutation that depends on the lock (Phase 3 Cluster 3E hardening
   * — replaces the Phase 3C.1 noOpAdvisoryLock stub).
   *
   * The hash converts the variable-length key into the `bigint`
   * advisory-lock space; collisions are statistically negligible at
   * F71A scale (one lock per (tenant, broadcast) pair).
   *
   * Phase 3F.11.6 — `tx` is now `TxToken` (branded). Callers MUST
   * wrap their raw tx via `asTxToken(tx)` at the call site (one-line
   * boundary cost), which makes Principle III tenant-tx-laundering
   * via random `as never` casts compile-fail.
   *
   * Backward compat: `noOpAdvisoryLock` still accepts `null` via the
   * port's pre-existing acceptance of optional tx — the production
   * pgAdvisoryLockAdapter throws on null. See pg-advisory-lock-adapter.ts.
   */
  acquire(tx: TxToken | null, lockKey: string): Promise<AcquireResult>;
}
