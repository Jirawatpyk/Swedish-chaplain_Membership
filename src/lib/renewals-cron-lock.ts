/**
 * #754 follow-up — non-blocking per-tenant advisory lock for the renewals
 * cron routes.
 *
 * `runInTenant` bounds every statement at 30 s (`SET LOCAL
 * statement_timeout`, #754). A route that took the BLOCKING
 * `pg_advisory_xact_lock` as its first statement and held it for the whole
 * run made an overlapping run (a cron retry, a manual re-fire) wait 30 s,
 * fail 57014 and answer 500, so the coordinator counted the tenant as
 * failed. The try-lock answers at once instead: for an overlap of the SAME
 * cron the run that already holds the lock does the work, so skipping loses
 * nothing. The one cross-cron key, `renewals:reconcile:` (below), is
 * different: a skipped reconcile run's work waits for its own next schedule
 * (reactivations 00:00 UTC daily, applications 22:00 UTC Friday in
 * `vercel.json`, so they do not normally meet).
 *
 * The key is the same text the blocking form hashed (`'<key>' || tenantId`),
 * concatenated in JS and bound as ONE parameter — the shape
 * `pgAdvisoryLockAdapter` already runs in production — so both forms address
 * the same lock. Keys (`renewals:dispatch:`, `renewals:at-risk:`,
 * `renewals:enter-awaiting:`, `renewals:lapse:`, `renewals:reconcile:`,
 * `renewals:tierupgrade:`) are unchanged; `renewals:reconcile:` stays shared
 * by reconcile-pending-reactivations and reconcile-pending-applications so
 * those two exclude each other.
 *
 * Transaction-scoped: released when the `runInTenant` tx ends.
 *
 * @returns `true` when this tx now holds the lock; `false` when another
 *   session holds it (the caller answers 200 `{ skipped: true, reason:
 *   'overlap' }` without running its use case).
 */
import { sql } from 'drizzle-orm';
import type { TenantTx } from '@/lib/db';

export async function tryRenewalsCronLock(
  tx: Pick<TenantTx, 'execute'>,
  key: string,
  tenantId: string,
): Promise<boolean> {
  const lockKey = `${key}${tenantId}`;
  const rows = (await tx.execute(
    sql`SELECT pg_try_advisory_xact_lock(hashtextextended(${lockKey}, 0)) AS acquired`,
  )) as unknown as Array<{ acquired: boolean }>;
  return rows[0]?.acquired === true;
}

/** Response body of a per-tenant renewals cron run skipped on overlap. */
export function renewalsCronOverlapBody(tenantId: string): {
  readonly skipped: true;
  readonly reason: 'overlap';
  readonly tenant_id: string;
} {
  return { skipped: true, reason: 'overlap', tenant_id: tenantId };
}
