/**
 * W0-02 — `PlanAdvisoryLockPort` for the members module.
 *
 * Consumed by `change-plan` use case to acquire the shared Postgres
 * advisory lock (`plans:softdelete:<tenantSlug>:<planId>:<planYear>`)
 * BEFORE writing the new plan FK on a member row.
 *
 * This is Side B of the W0-02 TOCTOU fix — Side A is
 * `planRepo.softDeleteGuarded` in the plans module which acquires the
 * SAME key. Serialising both paths under the same lock closes the race
 * window described in the go-live W0-02 finding.
 *
 * The port is Application-layer: no ORM / framework / drizzle imports.
 * The infrastructure adapter (plans module infra) calls
 * `tx.execute(sql\`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))\`)`.
 *
 * **Caller contract**: the acquirer MUST already be inside a
 * `runInTenant` tx (change-plan's existing tx). Acquiring outside a tx
 * would use a session-level lock which is NOT auto-released at tx end.
 */

export interface PlanAdvisoryLockPort {
  /**
   * Acquire a Postgres transaction-scoped advisory lock on the given
   * `lockKey`. Blocks until the lock is granted (or the tx rolls back).
   * Auto-released at COMMIT or ROLLBACK — caller must NOT release
   * explicitly.
   *
   * @param tx - The ambient `TenantTx` from the surrounding
   *   `runInTenant` block. Passed as `unknown` to keep this port pure
   *   (no drizzle-orm types in Application). The infrastructure adapter
   *   casts via `unbrandTx` from `@/lib/db`.
   * @param lockKey - The full advisory-lock key string, e.g.
   *   `plans:softdelete:swecham:gold:2027`.
   */
  acquire(tx: unknown, lockKey: string): Promise<void>;
}
