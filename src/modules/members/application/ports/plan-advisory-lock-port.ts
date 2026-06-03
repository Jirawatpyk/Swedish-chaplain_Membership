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

  /**
   * W0-02 completion (code-review #1) — read the NEW plan's soft-delete
   * state WITHIN the caller's tx, AFTER `acquire`. The pre-tx `getPlan`
   * snapshot can go stale if a concurrent `softDeleteGuarded` wins the lock
   * and deletes the (0-member) plan between the snapshot read and the FK
   * write. Because `softDeleteGuarded` holds the SAME advisory key, any such
   * delete has committed and is visible by the time we hold the lock — so
   * this read inside the lock is authoritative. `changePlan` aborts the tx
   * (→ `plan_not_found`) when this returns `true`, so a member is never
   * attached to a soft-deleted plan.
   *
   * @param tx - ambient `TenantTx` (typed `unknown` to keep the port pure;
   *   adapter casts via `unbrandTx`). RLS scopes the read to the tenant.
   * @returns `true` when `deleted_at IS NOT NULL` (or the row is gone).
   */
  isPlanSoftDeletedInTx(
    tx: unknown,
    planId: string,
    planYear: number,
  ): Promise<boolean>;
}
