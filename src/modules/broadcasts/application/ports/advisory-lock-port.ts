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

export interface AcquireResult {
  /** `true` if the lock was acquired, `false` if held by another tx. */
  readonly acquired: boolean;
}

export interface AdvisoryLockPort {
  /**
   * Try to acquire an advisory lock by string key. Returns
   * `{acquired: false}` on contention WITHOUT throwing — caller
   * decides whether to retry, fail open, or fail closed.
   *
   * Real impl: `SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0))`
   * inside a tx. The hash converts the variable-length key into the
   * `bigint` advisory-lock space.
   */
  acquire(lockKey: string): Promise<AcquireResult>;
}
