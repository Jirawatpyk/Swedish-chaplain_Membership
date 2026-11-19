/**
 * #754 follow-up — non-blocking per-tenant advisory lock for the renewals
 * cron routes.
 *
 * `runInTenant` bounds every statement at 30 s (`SET LOCAL
 * statement_timeout`, #754). A route that took the BLOCKING
 * `pg_advisory_xact_lock` as its first statement and held it for the whole
 * run made an overlapping run (a cron retry, a manual re-fire) wait 30 s,
 * fail 57014 and answer 500, so the coordinator counted the tenant as
 * failed. The try-lock answers at once instead.
 *
 * What a skip costs: for an overlap of the SAME cron, the run that holds
 * the lock does the work. If that run then fails, or a row becomes due
 * after it listed its work, the skipped run's work waits for that cron's
 * next schedule (daily for dispatch, enter-awaiting, lapse and
 * reconcile-reactivations; weekly for at-risk, tier-upgrade and
 * reconcile-applications). To catch up sooner, re-fire the cron once the
 * holder's run has ended. The one cross-cron key, `renewals:reconcile:`
 * (below), is shared by two crons whose schedules do not normally meet
 * (reactivations 00:00 UTC daily, applications 22:00 UTC Friday in
 * `vercel.json`).
 *
 * The key is the same text the blocking form hashed (`'<key>' || tenantId`),
 * concatenated in JS and bound as ONE parameter — the shape
 * `plan-repo.ts` and `drizzle-member-number-allocator.ts` already run in
 * production — so both forms address the same lock. Keys
 * (`renewals:dispatch:`, `renewals:at-risk:`, `renewals:enter-awaiting:`,
 * `renewals:lapse:`, `renewals:reconcile:`, `renewals:tierupgrade:`) are
 * unchanged; `renewals:reconcile:` stays shared by
 * reconcile-pending-reactivations and reconcile-pending-applications so
 * those two exclude each other.
 *
 * Transaction-scoped: released when the `runInTenant` tx ends.
 *
 * @returns `true` when this tx now holds the lock; `false` when another
 *   session holds it (the caller answers 200 `{ skipped: true, reason:
 *   'overlap' }` without running its use case).
 * @throws when Postgres returns no boolean — a broken read must surface as
 *   a 500 the coordinator counts as failed, never as a quiet skip.
 */
import { sql } from 'drizzle-orm';
import type { TenantTx } from '@/lib/db';
import { logger } from '@/lib/logger';
import { renewalsMetrics } from '@/lib/metrics';

export async function tryRenewalsCronLock(
  tx: Pick<TenantTx, 'execute'>,
  key: string,
  tenantId: string,
): Promise<boolean> {
  const lockKey = `${key}${tenantId}`;
  const rows = (await tx.execute(
    sql`SELECT pg_try_advisory_xact_lock(hashtextextended(${lockKey}, 0)) AS acquired`,
  )) as unknown as Array<{ acquired?: unknown }>;
  const acquired = rows[0]?.acquired;
  if (typeof acquired !== 'boolean') {
    throw new Error('renewals cron try-lock: unexpected result shape');
  }
  return acquired;
}

/** Response body of a per-tenant renewals cron run skipped on overlap. */
export function renewalsCronOverlapBody(tenantId: string): {
  readonly skipped: true;
  readonly reason: 'overlap';
  readonly tenant_id: string;
} {
  return { skipped: true, reason: 'overlap', tenant_id: tenantId };
}

/**
 * Split a coordinator's per-tenant 200 skips: `overlap` (another run held
 * the try-lock) apart from every other skip (the tenant route's kill
 * switch). Errored tenants are neither. With these two counts a
 * coordinator's `succeeded + failed + skipped_kill_switch + skipped_overlap`
 * equals `tenants_enqueued`.
 */
export function countTenantSkips(
  results: ReadonlyArray<{
    readonly error?: unknown;
    readonly skipped?: boolean;
    readonly skip_reason?: string;
  }>,
): { readonly overlap: number; readonly other: number } {
  let overlap = 0;
  let other = 0;
  for (const r of results) {
    if (r.error !== undefined || r.skipped !== true) continue;
    if (r.skip_reason === 'overlap') overlap += 1;
    else other += 1;
  }
  return { overlap, other };
}

/**
 * Make overlap skips visible. They are not failures (F8-A1 stays quiet),
 * so without this nothing would show that a run was stuck or that a
 * schedule overlaps itself. Alert on overlap in two runs in a row
 * (`docs/observability.md`).
 */
export function reportOverlapSkips(
  cronKind: string,
  overlap: number,
  correlationId: string,
): void {
  if (overlap <= 0) return;
  renewalsMetrics.coordinatorTenantsSkippedOverlap(cronKind, overlap);
  logger.warn(
    { cronKind, tenantsSkippedOverlap: overlap, correlationId },
    'cron.renewals.coordinator.overlap_skipped',
  );
}
