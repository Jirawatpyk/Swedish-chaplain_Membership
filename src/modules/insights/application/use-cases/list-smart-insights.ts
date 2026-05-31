/**
 * F9 `listSmartInsights` use-case (US1 / FR-004 / T028).
 *
 * Reads the cached snapshot's `topInsights` and RE-FILTERS them against LIVE
 * dismissals. `computeDashboardSnapshot` already filters dismissals at compute
 * time, but the snapshot is only refreshed by the ~5-min cron — so an insight
 * a staff member dismisses NOW would still appear (stale cache) until the next
 * recompute. This live read makes a just-dismissed insight disappear on the
 * next dashboard load (after `router.refresh()`), closing that gap.
 *
 * Application layer: orchestrates the snapshot read + dismissal check via
 * `runInTenant`; no ORM/framework imports beyond the shared `@/lib/db` helper.
 */
import { runInTenant } from '@/lib/db';
import { ok, type Result } from '@/lib/result';
import { logger } from '@/lib/logger';
import { errKind } from '@/lib/log-id';
import type { TenantContext } from '@/modules/tenants';
import { cycleKeyFor } from '../../domain/insight-cycle-key';
import type { SmartInsight } from '../../domain/smart-insight';
import type { SnapshotRepo } from '../ports/snapshot-repo';
import type { InsightDismissalRepo } from '../ports/insight-dismissal-repo';
import type { ClockPort } from '../ports/clock-port';

export interface ListSmartInsightsDeps {
  readonly snapshotRepo: Pick<SnapshotRepo, 'read'>;
  readonly dismissalRepo: Pick<InsightDismissalRepo, 'isDismissedInTx'>;
  readonly clock: ClockPort;
  readonly tenantTimezone: string;
}

export async function listSmartInsights(
  ctx: TenantContext,
  deps: ListSmartInsightsDeps,
): Promise<Result<readonly SmartInsight[], never>> {
  const cached = await deps.snapshotRepo.read(ctx);
  if (!cached) return ok([]);
  const candidates = cached.metrics.topInsights;
  if (candidates.length === 0) return ok([]);

  const now = deps.clock.now();
  try {
    const live = await runInTenant(ctx, async (tx) => {
      const kept: SmartInsight[] = [];
      for (const insight of candidates) {
        const scopeRef = insight.scopeRef ?? '';
        const cycleKey = cycleKeyFor(insight.key, now, deps.tenantTimezone);
        const dismissed = await deps.dismissalRepo.isDismissedInTx(
          tx,
          insight.key,
          scopeRef,
          cycleKey,
        );
        if (!dismissed) kept.push(insight);
      }
      return kept;
    });
    return ok(live);
  } catch (e) {
    // Live dismissal-check failure is non-critical — fall back to the cached
    // (compute-time-filtered) insights so the panel still renders.
    logger.warn(
      { tenantId: ctx.slug, errKind: errKind(e) },
      'insights.list_smart_insights.live_filter_failed',
    );
    return ok(candidates);
  }
}
