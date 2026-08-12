/**
 * F9 `listDashboard` use-case (US1 / FR-005/007 / contracts application-ports).
 *
 * The dashboard READ path. Reads the cached snapshot; on cold-start (no cache
 * row yet — new tenant, pre-first-cron) lazily recomputes it (critique E3) so
 * the caller never sees a raw error. Genuine compute failure → `snapshot_unavailable`
 * (presentation renders the empty state + a retryable signal, FR-006).
 *
 * Role projection (FR-007): admin + manager → full read-only view (the manager
 * role is "read-only on finance" — it MAY view revenue figures; the dashboard
 * exposes no finance edit/drill-down so read-only holds by construction);
 * member → forbidden (staff-only dashboard). Emits the `dashboard_viewed`
 * PII-read audit (best-effort; never masks the read, FR-036).
 *
 * No direct `runInTenant` — `snapshotRepo.read` self-scopes and `recompute`
 * self-runs — so this use-case is unit-testable with mocks.
 */
import { ok, err, type Result } from '@/lib/result';
import { insightsMetrics } from '@/lib/metrics';
import { logger } from '@/lib/logger';
import { errKind } from '@/lib/log-id';
import type { TenantContext } from '@/modules/tenants';
import type { DashboardSnapshot } from '../../domain/dashboard-snapshot';
import { f9RetentionFor } from '../ports/audit-port';
import type { InsightsAuditPort } from '../ports/audit-port';
import type { SnapshotRepo } from '../ports/snapshot-repo';
import type { SnapshotError } from './compute-dashboard-snapshot';
import type { Role } from '@/modules/auth';

// 016 T030/T033 — widened to the full Role union so routes stop casting and
// audit emitters record the LITERAL actor role; the decision arms in this
// file stay explicit per-role checks (deny arms unchanged).
export type DashboardActorRole = Role;

export interface ListDashboardMeta {
  readonly actorUserId: string;
  readonly actorRole: DashboardActorRole;
  readonly requestId: string;
}

export interface DashboardView {
  /**
   * The full snapshot for a viewer holding `insights.finance`; the engagement
   * projection for anyone else. The finance keys are ABSENT rather than zeroed —
   * see `projectEngagementOnly`.
   */
  readonly metrics: DashboardSnapshot | EngagementSnapshot;
  /** "As of" time (FR-005), ISO 8601 UTC; presentation renders per-locale. */
  readonly computedAt: string;
}

export interface ListDashboardDeps {
  readonly snapshotRepo: Pick<SnapshotRepo, 'read'>;
  /** Cold-start lazy recompute (computeDashboardSnapshot bound to the tenant). */
  recompute(ctx: TenantContext): Promise<Result<DashboardSnapshot, SnapshotError>>;
  readonly audit: InsightsAuditPort;
  /**
   * Whether the viewer holds `insights.finance` (016 T056). INJECTED by the
   * composition root, which owns `canPerform` — the Application layer must not
   * re-derive the permission model, and a role literal here would be the third
   * copy of a predicate this feature has already been bitten by twice.
   *
   * REQUIRED. It shipped optional with a PERMISSIVE default ("existing callers
   * keep today's behaviour"), which meant an omitted dep sent full revenue —
   * the opposite direction from its sibling `activityUnredacted`, ~40 lines
   * away in the same module, which defaults to redacted. Two adjacent security
   * projections that read alike and behave oppositely is how the wrong one gets
   * copied. The justification had also expired: there was exactly one
   * production caller and the factory already made it mandatory, so the default
   * was unused and untested.
   */
  readonly canFinance: boolean;
}

/**
 * The engagement-only view of the snapshot: every field except the finance ones.
 *
 * Finance members, per design § 4.3: `ytdPaidRevenueSatang`, `revenueTrend`,
 * `invoiceStatus` at the top level, plus `needsAttention.overdueInvoices` and
 * `counts.overdue` — the last two are finance-derived numbers living inside
 * containers that also carry engagement data, so the containers survive and only
 * those members are dropped.
 */
export type EngagementSnapshot = Omit<
  DashboardSnapshot,
  'ytdPaidRevenueSatang' | 'revenueTrend' | 'invoiceStatus' | 'needsAttention' | 'counts'
> & {
  readonly counts: Omit<DashboardSnapshot['counts'], 'overdue'>;
  readonly needsAttention: Omit<DashboardSnapshot['needsAttention'], 'overdueInvoices'>;
};

/**
 * Drop the finance fields by CONSTRUCTION rather than by deletion.
 *
 * Rebuilding the object from named engagement fields means a NEW finance field
 * added to `DashboardSnapshot` is excluded by default — it has to be added here
 * deliberately to reach a marketing viewer. A `delete`-based implementation, or
 * a spread minus a blocklist, would leak every future field silently, which is
 * the failure mode this whole task exists to prevent.
 */
/**
 * Narrow a `DashboardView.metrics` back to the full snapshot.
 *
 * The union is deliberately NOT discriminated by a flag field — presence of the
 * finance data IS the discriminant, so there is no way to claim finance access
 * while the numbers are absent. Callers that render finance widgets must go
 * through this, which is why the compiler flags every unguarded finance read in
 * the dashboard page the moment the projection lands.
 */
export function hasFinanceMetrics(
  metrics: DashboardSnapshot | EngagementSnapshot,
): metrics is DashboardSnapshot {
  return 'ytdPaidRevenueSatang' in metrics;
}

export function projectEngagementOnly(snapshot: DashboardSnapshot): EngagementSnapshot {
  const { total, active, atRisk } = snapshot.counts;
  const { broadcastsAwaitingApproval, atRiskMembers } = snapshot.needsAttention;
  return {
    counts: { total, active, atRisk },
    underDeliveredBenefitCount: snapshot.underDeliveredBenefitCount,
    needsAttention: { broadcastsAwaitingApproval, atRiskMembers },
    memberGrowth: snapshot.memberGrowth,
    topInsights: snapshot.topInsights,
    tierDistribution: snapshot.tierDistribution,
    computedAt: snapshot.computedAt,
  };
}

export type DashboardError = 'forbidden' | 'snapshot_unavailable';

export async function listDashboard(
  meta: ListDashboardMeta,
  ctx: TenantContext,
  deps: ListDashboardDeps,
): Promise<Result<DashboardView, DashboardError>> {
  // FR-007 / US1 AS-5 — the staff dashboard is denied to members (not hidden).
  if (meta.actorRole === 'member') return err('forbidden');

  let snapshot: DashboardSnapshot;
  let computedAt: string;

  const cached = await deps.snapshotRepo.read(ctx);
  if (cached) {
    snapshot = cached.metrics;
    computedAt = cached.computedAt.toISOString();
  } else {
    // Cold-start (E3): lazily compute + cache; surface only genuine failures.
    const recomputed = await deps.recompute(ctx);
    if (!recomputed.ok) return err('snapshot_unavailable');
    snapshot = recomputed.value;
    computedAt = snapshot.computedAt;
  }

  // PII-read audit (FR-036) — best-effort; a write failure must not block the
  // read. The adapter's `record` already logs+meters+swallows, but wrap here as
  // defence-in-depth so any port impl that throws can never fail the dashboard.
  try {
    await deps.audit.record({
      tenantId: ctx.slug,
      requestId: meta.requestId,
      eventType: 'dashboard_viewed',
      actorUserId: meta.actorUserId,
      retentionYears: f9RetentionFor('dashboard_viewed'),
      summary: `dashboard viewed by ${meta.actorRole}`,
      payload: { actor_role: meta.actorRole },
    });
  } catch (e) {
    logger.error(
      { tenantId: ctx.slug, errKind: errKind(e) },
      'insights.list_dashboard.audit_emit_threw',
    );
  }
  insightsMetrics.dashboardViewed(meta.actorRole, ctx.slug);

  // Project AFTER both branches converge (cached read and cold-start recompute),
  // so a cold start cannot leak the full snapshot — which is precisely when a
  // newly-hired marketing operator first opens the page.
  // `!== true` rather than `=== false`: with the field required this is the
  // same decision, and it keeps the safe direction if the type ever loosens.
  const metrics = deps.canFinance !== true ? projectEngagementOnly(snapshot) : snapshot;

  return ok({ metrics, computedAt });
}
