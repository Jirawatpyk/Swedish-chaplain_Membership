/**
 * F114 — `countPendingChangeRequests` (US6 AS3; FR-033, FR-037; research
 * R12). The one read behind the dashboard "Needs attention" item, the nav
 * badge and the settings card's switch-off warning: `pendingStats`
 * (`count(*)`, `min(submitted_at)` over pending rows — one indexed query)
 * projected to `{ count, oldestAgeSeconds }`.
 *
 * `oldestAgeSeconds` is `null` when nothing is pending — the same semantics
 * as `listChangeRequestQueue.oldestPendingAgeSeconds`: an absent age is not
 * a zero-second age, and every consumer renders nothing for `null`. (The
 * gauges tick zero-fills its OWN series from SQL — that is a metric
 * convention, "0 means 0", not this read model's.) Age comes from the
 * injected clock, floored to whole seconds, clamped at 0 against skew.
 */
import { logger } from '@/lib/logger';
import { errKind } from '@/lib/log-id';
import { err, ok, type Result } from '@/lib/result';
import type { TenantContext } from '@/modules/tenants';
import type { ChangeRequestRepo } from '../../ports/change-request-repo';
import type { ClockPort } from '../../ports/clock-port';
import { repoErrorCause } from '../../ports/member-repo';

export type CountPendingChangeRequestsDeps = {
  readonly tenant: TenantContext;
  readonly changeRequestRepo: Pick<ChangeRequestRepo, 'pendingStats'>;
  readonly clock: ClockPort;
};

export type PendingChangeRequestsSummary = {
  readonly count: number;
  readonly oldestAgeSeconds: number | null;
};

export type CountPendingChangeRequestsError = { readonly type: 'server_error'; readonly message: string };

export async function countPendingChangeRequests(
  deps: CountPendingChangeRequestsDeps,
): Promise<Result<PendingChangeRequestsSummary, CountPendingChangeRequestsError>> {
  const stats = await deps.changeRequestRepo.pendingStats(deps.tenant);
  if (!stats.ok) {
    logger.error(
      { tenantId: deps.tenant.slug, err: stats.error.code, cause: errKind(repoErrorCause(stats.error)) },
      'change-request.count-pending.failed',
    );
    return err({ type: 'server_error', message: `count-pending: ${stats.error.code}` });
  }
  const now = deps.clock.now();
  const oldest = stats.value.oldestSubmittedAt;
  return ok({
    count: stats.value.count,
    oldestAgeSeconds: oldest === null ? null : Math.max(0, Math.floor((now.getTime() - oldest.getTime()) / 1000)),
  });
}
