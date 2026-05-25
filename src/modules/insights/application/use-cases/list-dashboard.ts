/**
 * F9 `listDashboard` use-case (US1 / FR-005/007 / contracts application-ports).
 *
 * The dashboard READ path. Reads the cached snapshot; on cold-start (no cache
 * row yet — new tenant, pre-first-cron) lazily recomputes it (critique E3) so
 * the caller never sees a raw error. Genuine compute failure → `snapshot_unavailable`
 * (presentation renders the empty state + a retryable signal, FR-006).
 *
 * Role projection (FR-007): admin → full; manager → finance-redacted
 * (YTD revenue hidden); member → forbidden (staff-only dashboard). Emits the
 * `dashboard_viewed` PII-read audit (best-effort; never masks the read, FR-036).
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

export type DashboardActorRole = 'admin' | 'manager' | 'member';

export interface ListDashboardMeta {
  readonly actorUserId: string;
  readonly actorRole: DashboardActorRole;
  readonly requestId: string;
}

/** Role-projected snapshot — `ytdPaidRevenueSatang` is null when finance-redacted. */
export type ProjectedDashboard = Omit<DashboardSnapshot, 'ytdPaidRevenueSatang'> & {
  readonly ytdPaidRevenueSatang: string | null;
};

export interface DashboardView {
  readonly metrics: ProjectedDashboard;
  /** "As of" time (FR-005), ISO 8601 UTC; presentation renders per-locale. */
  readonly computedAt: string;
  /** True for managers — the UI hides the revenue figure. */
  readonly financeRedacted: boolean;
}

export interface ListDashboardDeps {
  readonly snapshotRepo: Pick<SnapshotRepo, 'read'>;
  /** Cold-start lazy recompute (computeDashboardSnapshot bound to the tenant). */
  recompute(ctx: TenantContext): Promise<Result<DashboardSnapshot, SnapshotError>>;
  readonly audit: InsightsAuditPort;
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

  const financeRedacted = meta.actorRole === 'manager';
  const metrics: ProjectedDashboard = {
    ...snapshot,
    ytdPaidRevenueSatang: financeRedacted ? null : snapshot.ytdPaidRevenueSatang,
  };

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

  return ok({ metrics, computedAt, financeRedacted });
}
