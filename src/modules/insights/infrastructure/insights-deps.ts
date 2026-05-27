/**
 * F9 insights composition root.
 *
 * Mirrors the F7 `broadcasts-deps.ts` / F4 `invoicing-deps.ts` shape: per-call
 * (per-tenant) factories for repos that need bound tenant context; stateless
 * adapters become module-level constants. Wires the dashboard (US1),
 * audit-viewer (US2), and benefit-usage (US4) dependency bundles; export-job
 * deps land with US6.
 *
 * Constitution Principle III: this file (Infrastructure) is the ONLY place
 * Application port interfaces are bound to concrete adapters. Use-cases never
 * import Infrastructure values directly.
 */

import { env } from '@/lib/env';
import { insightsMetrics } from '@/lib/metrics';
import { insightsAuditAdapter } from './audit/insights-audit-adapter';
import { f9RetentionFor } from '../application/ports/audit-port';
import { makeDrizzleInsightDismissalRepo } from './repos/drizzle-insight-dismissal-repo';
import { makeDrizzleSnapshotRepo } from './repos/drizzle-snapshot-repo';
import { memberSourceAdapter } from './sources/member-source-adapter';
import { memberPlanSourceAdapter } from './sources/member-plan-source-adapter';
import { planSourceAdapter } from './sources/plan-source-adapter';
import { invoiceSourceAdapter } from './sources/invoice-source-adapter';
import { broadcastSourceAdapter } from './sources/broadcast-source-adapter';
import { eventSourceAdapter } from './sources/event-source-adapter';
import { activityFeedSourceAdapter } from './sources/activity-feed-adapter';
import { auditEventSourceAdapter } from './sources/audit-source-adapter';
import { actorDirectoryAdapter } from './sources/actor-directory-adapter';
import { computeDashboardSnapshot } from '../application/use-cases/compute-dashboard-snapshot';
import type { DismissInsightDeps } from '../application/use-cases/dismiss-insight';
import type { ComputeDashboardSnapshotDeps } from '../application/use-cases/compute-dashboard-snapshot';
import type { ComputeBenefitUsageDeps } from '../application/use-cases/compute-benefit-usage';
import type { ListDashboardDeps } from '../application/use-cases/list-dashboard';
import type { ListSmartInsightsDeps } from '../application/use-cases/list-smart-insights';
import type { ActivityFeedDeps } from '../application/use-cases/activity-feed-query';
import type { AuditQueryDeps } from '../application/use-cases/audit-query';

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
    broadcastSource: broadcastSourceAdapter,
    snapshotRepo: makeDrizzleSnapshotRepo(tenantId),
    dismissalRepo: makeDrizzleInsightDismissalRepo(tenantId),
    clock: systemClock,
    tenantTimezone: env.tenant.timezone,
  };
}

/** US4 (T064) — `computeBenefitUsage` per-tenant dependency bundle. */
export function makeComputeBenefitUsageDeps(
  _tenantId: string,
): ComputeBenefitUsageDeps {
  return {
    memberPlanSource: memberPlanSourceAdapter,
    planSource: planSourceAdapter,
    broadcastSource: broadcastSourceAdapter,
    eventSource: eventSourceAdapter,
    clock: systemClock,
    tenantTimezone: env.tenant.timezone,
  };
}

/**
 * US4 (T068) — best-effort PII-read trail for a STAFF benefit view + the
 * SC-012 adoption metric. Mirrors the `dashboard_viewed` emit in `listDashboard`:
 * `insightsAuditAdapter.record` already logs+meters+swallows on failure, so the
 * page never blocks on the audit write (FR-036). The member self-view path
 * emits only the metric (`insightsMetrics.benefitViewed('member', …)`) directly
 * from the portal page — no PII-read audit, since a member reading their own
 * benefits is not a PII access of another data subject.
 */
export async function recordStaffBenefitView(input: {
  readonly tenantId: string;
  readonly requestId: string | null;
  readonly actorUserId: string;
  readonly actorRole: 'admin' | 'manager';
  readonly subjectMemberId: string;
  readonly membershipYear: number;
}): Promise<void> {
  await insightsAuditAdapter.record({
    tenantId: input.tenantId,
    requestId: input.requestId,
    eventType: 'member_benefit_viewed',
    actorUserId: input.actorUserId,
    retentionYears: f9RetentionFor('member_benefit_viewed'),
    summary: `benefit view of ${input.subjectMemberId} by ${input.actorRole}`,
    payload: {
      subject_member_id: input.subjectMemberId,
      membership_year: input.membershipYear,
    },
  });
  insightsMetrics.benefitViewed(input.actorRole, input.tenantId);
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

/** US1 (T028/T031) — `listSmartInsights` (live dismissal-filtered) deps. */
export function makeListSmartInsightsDeps(tenantId: string): ListSmartInsightsDeps {
  return {
    snapshotRepo: makeDrizzleSnapshotRepo(tenantId),
    dismissalRepo: makeDrizzleInsightDismissalRepo(tenantId),
    clock: systemClock,
    tenantTimezone: env.tenant.timezone,
  };
}

/** US1 (T029/T031) — `activityFeedQuery` (live recent-audit feed) deps. */
export function makeActivityFeedDeps(): ActivityFeedDeps {
  return { activitySource: activityFeedSourceAdapter };
}

/**
 * US2 (T042/T046) — `auditQuery` / `auditExport` deps. The reader self-scopes
 * per call (`ctx`), so no tenant binding is needed here; the audit emitter is
 * the shared best-effort F9 adapter.
 */
export function makeAuditQueryDeps(): AuditQueryDeps {
  return {
    source: auditEventSourceAdapter,
    audit: insightsAuditAdapter,
    actorDirectory: actorDirectoryAdapter,
  };
}
