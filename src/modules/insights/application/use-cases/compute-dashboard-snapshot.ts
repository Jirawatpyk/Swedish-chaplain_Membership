/**
 * F9 `computeDashboardSnapshot` use-case (US1 / FR-001/004 / data-model R1).
 *
 * Recomputes the per-tenant operations-dashboard snapshot and upserts the
 * cache row. Invoked by the snapshot cron (T035) and by the cold-start lazy
 * path in `listDashboard`. Idempotent — the projection is derived + safe to
 * rebuild.
 *
 * Computes membership counts + at-risk insight via `MemberSource`, and YTD paid
 * revenue + overdue-invoice count via `InvoiceSource` (Increment 1 + 2). Still
 * scoped follow-ups (emitted as 0/empty with the field present so the UI stays
 * stable):
 *   - needsAttention.broadcastsAwaitingApproval
 *     → BroadcastConsumptionSource (needs a broadcasts barrel count export)
 *   - underDeliveredBenefitCount + the 2 quota insights
 *     → US4 benefit-usage aggregate (cross-member)
 *
 * Application layer: orchestrates Domain + ports; `runInTenant` only wraps the
 * tenant-scoped dismissal-check + upsert (the MemberSource reads self-scope via
 * the members repo). Pure of ORM/framework imports beyond `@/lib/db`.
 */
import { runInTenant } from '@/lib/db';
import { ok, err, type Result } from '@/lib/result';
import { logger } from '@/lib/logger';
import { errKind } from '@/lib/log-id';
import type { TenantContext } from '@/modules/tenants';
import { cycleKeyFor } from '../../domain/insight-cycle-key';
import type { DashboardSnapshot } from '../../domain/dashboard-snapshot';
import type { SmartInsight } from '../../domain/smart-insight';
import type { InsightDismissalRepo } from '../ports/insight-dismissal-repo';
import type { InvoiceSource, MemberSource } from '../ports/source-ports';
import type { SnapshotRepo } from '../ports/snapshot-repo';
import type { ClockPort } from '../ports/clock-port';

export interface ComputeDashboardSnapshotDeps {
  readonly memberSource: MemberSource;
  readonly invoiceSource: InvoiceSource;
  readonly snapshotRepo: SnapshotRepo;
  readonly dismissalRepo: InsightDismissalRepo;
  readonly clock: ClockPort;
  readonly tenantTimezone: string;
}

export type SnapshotError = 'compute_failed';

export async function computeDashboardSnapshot(
  ctx: TenantContext,
  deps: ComputeDashboardSnapshotDeps,
): Promise<Result<DashboardSnapshot, SnapshotError>> {
  try {
    const now = deps.clock.now();
    // Calendar year in the tenant timezone (FR-023 / membership-year convention).
    const year = Number(
      new Intl.DateTimeFormat('en-CA', {
        timeZone: deps.tenantTimezone,
        year: 'numeric',
      }).format(now),
    );

    // Source reads self-scope (each call runs in its own tenant tx).
    const [statusCounts, atRisk, ytdPaidRevenueSatang, overdueInvoices] =
      await Promise.all([
        deps.memberSource.countByStatus(ctx),
        deps.memberSource.countAtRisk(ctx),
        deps.invoiceSource.getYtdPaidRevenueSatang(ctx, year),
        deps.invoiceSource.countOverdue(ctx),
      ]);
    const total = statusCounts.active + statusCounts.inactive + statusCounts.archived;

    // Candidate insights (Increment 1: at-risk follow-up only; quota insights → US4).
    const candidates: SmartInsight[] = atRisk > 0 ? [{ key: 'at_risk_followup', count: atRisk }] : [];

    const snapshot = await runInTenant(ctx, async (tx) => {
      // Suppress insights dismissed for the current cycle (FR-004).
      const topInsights: SmartInsight[] = [];
      for (const candidate of candidates) {
        const scopeRef = candidate.scopeRef ?? '';
        const cycleKey = cycleKeyFor(candidate.key, now, deps.tenantTimezone);
        const dismissed = await deps.dismissalRepo.isDismissedInTx(
          tx,
          candidate.key,
          scopeRef,
          cycleKey,
        );
        if (!dismissed) topInsights.push(candidate);
      }

      const snap: DashboardSnapshot = {
        counts: { total, active: statusCounts.active, atRisk, overdue: overdueInvoices },
        ytdPaidRevenueSatang: ytdPaidRevenueSatang.toString(),
        underDeliveredBenefitCount: 0, // TODO(US4): benefit aggregate
        needsAttention: {
          broadcastsAwaitingApproval: 0, // TODO: needs a broadcasts barrel count export
          overdueInvoices,
          atRiskMembers: atRisk,
        },
        topInsights,
        computedAt: now.toISOString(),
      };
      await deps.snapshotRepo.upsertInTx(tx, snap, now);
      return snap;
    });

    return ok(snapshot);
  } catch (e) {
    // Bind + log at the point of failure so a context-free `compute_failed`
    // string isn't all an operator has during a Neon outage / source error.
    // Log only `errKind` (constructor name) — a raw Postgres `e.message` can
    // carry SQL params / table names (forbidden-fields hygiene). Programmer
    // errors (TypeError/ReferenceError) surface distinctly via errKind.
    logger.error(
      { tenantId: ctx.slug, errKind: errKind(e) },
      'insights.compute_snapshot.failed',
    );
    return err('compute_failed');
  }
}
