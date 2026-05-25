/**
 * F9 insights composition root (T005 stub).
 *
 * Mirrors the F7 `broadcasts-deps.ts` / F4 `invoicing-deps.ts` shape: per-call
 * (per-tenant) factories for repos that need bound tenant context; stateless
 * adapters become module-level constants. Wiring is filled in per phase as
 * use-cases land (T031 dashboard deps, T064 benefit-usage deps, T069+ export
 * deps). Until then this exposes only the shared `systemClock`.
 *
 * Constitution Principle III: this file (Infrastructure) is the ONLY place
 * Application port interfaces are bound to concrete adapters. Use-cases never
 * import Infrastructure values directly.
 */

import { env } from '@/lib/env';
import { insightsAuditAdapter } from './audit/insights-audit-adapter';
import { makeDrizzleInsightDismissalRepo } from './repos/drizzle-insight-dismissal-repo';
import { makeDrizzleSnapshotRepo } from './repos/drizzle-snapshot-repo';
import { memberSourceAdapter } from './sources/member-source-adapter';
import { invoiceSourceAdapter } from './sources/invoice-source-adapter';
import { activityFeedSourceAdapter } from './sources/activity-feed-adapter';
import { computeDashboardSnapshot } from '../application/use-cases/compute-dashboard-snapshot';
import type { DismissInsightDeps } from '../application/use-cases/dismiss-insight';
import type { ComputeDashboardSnapshotDeps } from '../application/use-cases/compute-dashboard-snapshot';
import type { ListDashboardDeps } from '../application/use-cases/list-dashboard';
import type { ActivityFeedDeps } from '../application/use-cases/activity-feed-query';

/** Shared wall-clock port impl (injected so use-cases stay deterministic in tests). */
export const systemClock = {
  now: (): Date => new Date(),
} as const;

/** US1 (T028) — `dismissInsight` per-tenant dependency bundle. */
export function makeDismissInsightDeps(tenantId: string): DismissInsightDeps {
  return {
    dismissalRepo: makeDrizzleInsightDismissalRepo(tenantId),
    audit: insightsAuditAdapter,
    clock: systemClock,
    tenantTimezone: env.tenant.timezone,
  };
}

/** US1 (T026/T031) — `computeDashboardSnapshot` per-tenant dependency bundle. */
export function makeComputeDashboardSnapshotDeps(
  tenantId: string,
): ComputeDashboardSnapshotDeps {
  return {
    memberSource: memberSourceAdapter,
    invoiceSource: invoiceSourceAdapter,
    snapshotRepo: makeDrizzleSnapshotRepo(tenantId),
    dismissalRepo: makeDrizzleInsightDismissalRepo(tenantId),
    clock: systemClock,
    tenantTimezone: env.tenant.timezone,
  };
}

/** US1 (T027/T031) — `listDashboard` read-path dependency bundle. */
export function makeListDashboardDeps(tenantId: string): ListDashboardDeps {
  return {
    snapshotRepo: makeDrizzleSnapshotRepo(tenantId),
    recompute: (ctx) =>
      computeDashboardSnapshot(ctx, makeComputeDashboardSnapshotDeps(tenantId)),
    audit: insightsAuditAdapter,
  };
}

/** US1 (T029/T031) — `activityFeedQuery` (live recent-audit feed) deps. */
export function makeActivityFeedDeps(): ActivityFeedDeps {
  return { activitySource: activityFeedSourceAdapter };
}
