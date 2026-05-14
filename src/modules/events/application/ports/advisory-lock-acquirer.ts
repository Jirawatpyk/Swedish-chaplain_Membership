/**
 * T085 — `AdvisoryLockAcquirer` Application port (F6).
 *
 * Tenant-scoped Postgres advisory lock primitive used by
 * `apply-quota-effect.ts` to serialise concurrent quota decisions for
 * the same logical (tenant, member, event) seat-allocation (research.md
 * R5 + spec FR-037 strict-tx invariant).
 *
 * The adapter (Phase 6 Infrastructure) implements via
 * `tx.execute(sql\`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))\`)` —
 * the lock is bound to the current transaction and auto-released at
 * COMMIT or ROLLBACK. The Application caller MUST already be inside a
 * tx; this port does NOT open one.
 *
 * Namespace convention (mirrors F4 `invoicing:` / F5 `payments:` /
 * F7 `broadcasts:` / F8 `renewals:` precedents):
 *   `eventcreate-quota:${tenantId}:${memberId}:${eventId}` —
 *   per-(tenant, member, event) coordination key.
 *
 * Pure interface — no framework imports (Constitution Principle III).
 */

export interface AdvisoryLockAcquirer {
  /**
   * Acquire a Postgres transaction-scoped advisory lock keyed by the
   * caller-supplied string. The string is hashed via
   * `hashtextextended(_, 0)` to produce the bigint key Postgres expects.
   *
   * The call BLOCKS until the lock is held (or the tx is rolled back).
   * Auto-released at tx-end — caller need not (must not) release
   * explicitly.
   *
   * Throws on DB error (caller wraps in TxStageError to propagate
   * through the strict-tx rollback path).
   */
  acquire(lockKey: string): Promise<void>;
}
