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
import { makeDrizzleDirectoryRepo } from './repos/drizzle-directory-repo';
import { makeDrizzleExportJobRepo } from './repos/drizzle-export-job-repo';
import { privateBlobAdapter } from './blob/private-blob-adapter';
import { memberSourceAdapter } from './sources/member-source-adapter';
import { memberPlanSourceAdapter } from './sources/member-plan-source-adapter';
import { planSourceAdapter } from './sources/plan-source-adapter';
import { memberEnumerationAdapter } from './sources/member-enumeration-adapter';
import { benefitConsumptionAggregateAdapter } from './sources/benefit-consumption-aggregate-adapter';
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
import type { SearchDirectoryDeps } from '../application/use-cases/search-directory';
import type { UpdateDirectoryListingDeps } from '../application/use-cases/update-directory-listing';
import type { GenerateDirectoryExportDeps } from '../application/use-cases/generate-directory-export';
import type {
  DownloadExportDeps,
  PrepareExportDownloadDeps,
} from '../application/use-cases/download-export';
import type { RequestDataExportDeps } from '../application/use-cases/request-data-export';
import type { ExportJobRecord } from '../application/ports/export-job-repo';
import type { TenantContext } from '@/modules/tenants';

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
    // P1-4 / FR-004 — cross-member quota roll-up sources.
    memberEnumeration: memberEnumerationAdapter,
    consumptionAggregate: benefitConsumptionAggregateAdapter,
    planSource: planSourceAdapter,
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

/**
 * US3 (staff-review R002 / FR-036) — best-effort PII-read trail for a STAFF
 * timeline view (the member's full multi-source history). Member self-views at
 * /portal/timeline are NOT audited (not third-party access). Best-effort: the
 * adapter logs+meters+swallows, so the read never blocks on the audit write.
 */
export async function recordStaffTimelineView(input: {
  readonly tenantId: string;
  readonly requestId: string | null;
  readonly actorUserId: string;
  readonly actorRole: 'admin' | 'manager';
  readonly subjectMemberId: string;
  readonly filterApplied: boolean;
}): Promise<void> {
  await insightsAuditAdapter.record({
    tenantId: input.tenantId,
    requestId: input.requestId,
    eventType: 'member_timeline_viewed',
    actorUserId: input.actorUserId,
    retentionYears: f9RetentionFor('member_timeline_viewed'),
    summary: `timeline view of ${input.subjectMemberId} by ${input.actorRole}`,
    payload: {
      subject_member_id: input.subjectMemberId,
      filter_applied: input.filterApplied,
    },
  });
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

/** US5 (T078) — `searchDirectory` per-tenant deps (staff browse, FR-024). */
export function makeSearchDirectoryDeps(tenantId: string): SearchDirectoryDeps {
  return { directoryRepo: makeDrizzleDirectoryRepo(tenantId) };
}

/** US5 (T078) — `updateDirectoryListing` per-tenant deps (member/admin edit, FR-025). */
export function makeUpdateDirectoryListingDeps(
  tenantId: string,
): UpdateDirectoryListingDeps {
  return {
    directoryRepo: makeDrizzleDirectoryRepo(tenantId),
    audit: insightsAuditAdapter,
  };
}

/**
 * US5 (T080/T081) — `generateDirectoryEbook` / `exportDirectoryJson` enqueue
 * deps. Light (no react-pdf): the artefact build happens in the cron worker,
 * whose heavy deps live in `process-export-job-deps.ts` so pages importing this
 * barrel never pull `@react-pdf/renderer` into their bundle.
 */
export function makeGenerateDirectoryExportDeps(
  tenantId: string,
): GenerateDirectoryExportDeps {
  return { exportJobRepo: makeDrizzleExportJobRepo(tenantId), clock: systemClock };
}

/** US5/US6 (T073) — `prepareExportDownload` mint deps. */
export function makePrepareExportDownloadDeps(
  tenantId: string,
): PrepareExportDownloadDeps {
  return { exportJobRepo: makeDrizzleExportJobRepo(tenantId), clock: systemClock };
}

/** US5/US6 (T073) — `downloadExport` proxy deps (private blob + audit). */
export function makeDownloadExportDeps(tenantId: string): DownloadExportDeps {
  return {
    exportJobRepo: makeDrizzleExportJobRepo(tenantId),
    blob: privateBlobAdapter,
    audit: insightsAuditAdapter,
    clock: systemClock,
  };
}

/** US6 (T089) — `requestDataExport` enqueue deps (light; no archive build). */
export function makeRequestDataExportDeps(tenantId: string): RequestDataExportDeps {
  return {
    exportJobRepo: makeDrizzleExportJobRepo(tenantId),
    audit: insightsAuditAdapter,
    clock: systemClock,
  };
}

/**
 * US6 (T093) — recent GDPR export jobs for a member's data-export portal page.
 * Tenant + subject scoped (RLS); newest first. A page helper rather than a
 * use-case (read-only, no policy beyond the page's own session → member resolve).
 */
export function listMemberDataExports(
  tenant: TenantContext,
  subjectMemberId: string,
  limit = 5,
): Promise<readonly ExportJobRecord[]> {
  return makeDrizzleExportJobRepo(tenant.slug).listRecentForSubject(
    tenant,
    subjectMemberId,
    'gdpr_member_archive',
    limit,
  );
}
