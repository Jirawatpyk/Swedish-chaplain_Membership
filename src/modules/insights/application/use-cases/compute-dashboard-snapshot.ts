/**
 * F9 `computeDashboardSnapshot` use-case (US1 / FR-001/004 / data-model R1).
 *
 * Recomputes the per-tenant operations-dashboard snapshot and upserts the
 * cache row. Invoked by the snapshot cron (T035) and by the cold-start lazy
 * path in `listDashboard`. Idempotent — the projection is derived + safe to
 * rebuild.
 *
 * Computes membership counts + at-risk insight via `MemberSource`, YTD paid
 * revenue + overdue-invoice count via `InvoiceSource`, and
 * needsAttention.broadcastsAwaitingApproval via `BroadcastConsumptionSource`
 * (`countAwaitingApproval`). The cross-member quota roll-up (P1-4 / FR-004) —
 * `underDeliveredBenefitCount` + the `unused_eblast_quota` /
 * `underused_event_tickets` insight cards — is computed via
 * `MemberEnumerationSource` + `BenefitConsumptionAggregateSource` (one batched
 * GROUP BY per benefit, no N+1) + memoized `PlanSource` entitlements, joined by
 * the pure `countUnderUsedQuota` domain rule. Threshold = "any shortfall"
 * (`used < entitlement`), distinct from the FR-021 US4 25pt-gap member view.
 *
 * `tierDistribution` (067) reuses the `activeMembers` enumeration + the SAME
 * memoized `PlanSource` fan-out (adds `getPlanLabel` alongside
 * `getEntitlements`) and folds them through the pure
 * `groupActiveMembersByTier` domain rule. `invoiceStatus` (067) is a single
 * additional `InvoiceSource.getInvoiceStatusDistribution` read, satang mapped
 * bigint → decimal string for the JSONB cache.
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
import { lastNMonthKeys } from '../../domain/trend-window';
import type {
  DashboardSnapshot,
  InvoiceStatusDistribution,
  MemberGrowthPoint,
  RevenueTrendPoint,
} from '../../domain/dashboard-snapshot';
import type { SmartInsight } from '../../domain/smart-insight';
import {
  countUnderUsedQuota,
  planKey,
  type QuotaEntitlement,
} from '../../domain/quota-underuse';
import { groupActiveMembersByTier } from '../../domain/tier-distribution';
import type { InsightDismissalRepo } from '../ports/insight-dismissal-repo';
import type {
  BenefitConsumptionAggregateSource,
  BroadcastConsumptionSource,
  InvoiceSource,
  MemberEnumerationSource,
  MemberSource,
  PlanSource,
} from '../ports/source-ports';
import type { SnapshotRepo } from '../ports/snapshot-repo';
import type { ClockPort } from '../ports/clock-port';

export interface ComputeDashboardSnapshotDeps {
  readonly memberSource: MemberSource;
  readonly invoiceSource: InvoiceSource;
  /** Broadcasts awaiting approval (FR-002 / AS-2); only the count is needed at US1. */
  readonly broadcastSource: Pick<BroadcastConsumptionSource, 'countAwaitingApproval'>;
  /** Active-member enumeration for the cross-member quota roll-up (P1-4 / FR-004). */
  readonly memberEnumeration: MemberEnumerationSource;
  /** Batched cross-member benefit consumption for the quota roll-up (P1-4 / FR-004). */
  readonly consumptionAggregate: BenefitConsumptionAggregateSource;
  /** Plan entitlements for the quota roll-up (P1-4 / FR-004 / FR-019). */
  readonly planSource: PlanSource;
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
    // Calendar / membership year in the tenant timezone (FR-023). Used for the
    // benefit-quota roll-up (eblast/cultural usage is tracked per membership
    // year). NOT for the revenue KPI — that windows by the tenant FISCAL year,
    // derived inside the invoice adapter from `now` + fiscalYearStartMonth (F9
    // #4); the two coincide only for a January-start tenant.
    const year = Number(
      new Intl.DateTimeFormat('en-CA', {
        timeZone: deps.tenantTimezone,
        year: 'numeric',
      }).format(now),
    );

    // 12-month trend window in the tenant timezone (FR-001a), oldest→newest.
    const monthKeys = lastNMonthKeys(now, deps.tenantTimezone, 12);

    // Source reads self-scope (each call runs in its own tenant tx).
    const [
      statusCounts,
      atRisk,
      ytdPaidRevenueSatang,
      overdueInvoices,
      broadcastsAwaitingApproval,
      monthlyRevenue,
      joinDist,
      activeMembers,
      eblastUsedByMember,
      culturalUsedByMember,
      invoiceStatusRaw,
    ] = await Promise.all([
      deps.memberSource.countByStatus(ctx),
      deps.memberSource.countAtRisk(ctx),
      // Revenue KPI windows by the tenant FISCAL year (derived in the adapter
      // from this instant + fiscalYearStartMonth), not the calendar `year`.
      deps.invoiceSource.getYtdPaidRevenueSatang(ctx, now.toISOString()),
      deps.invoiceSource.countOverdue(ctx),
      deps.broadcastSource.countAwaitingApproval(ctx),
      deps.invoiceSource.getMonthlyPaidRevenueSatang(ctx, monthKeys, deps.tenantTimezone),
      deps.memberSource.joinDistribution(ctx, monthKeys),
      // P1-4 / FR-004 — cross-member quota roll-up inputs. The two consumption
      // aggregates are ONE GROUP BY each (no N+1); entitlements are resolved
      // below (memoized per distinct plan).
      deps.memberEnumeration.listActiveWithPlan(ctx),
      deps.consumptionAggregate.eblastUsedByMember(ctx, year),
      deps.consumptionAggregate.culturalUsedByMember(ctx, year),
      // 067 — invoice-status distribution chart (paid/unpaid/overdue + drafts).
      deps.invoiceSource.getInvoiceStatusDistribution(ctx, now.toISOString()),
    ]);
    const total = statusCounts.active + statusCounts.inactive + statusCounts.archived;

    // Build the trend series aligned to the 12 month keys (FR-001a).
    const revenueTrend: RevenueTrendPoint[] = monthKeys.map((month) => ({
      month,
      satang: (monthlyRevenue[month] ?? 0n).toString(),
    }));
    let cumulative = joinDist.baseline;
    const memberGrowth: MemberGrowthPoint[] = monthKeys.map((month) => {
      cumulative += joinDist.byMonth[month] ?? 0;
      return { month, cumulative };
    });

    // P1-4 / FR-004 — cross-member quota roll-up. Resolve entitlements ONCE per
    // distinct (planId, planYear) the active members hold (≤ tier count, memoized;
    // ≤9 for SweCham). A member whose plan/year is not found is omitted from the
    // map and therefore excluded by `countUnderUsedQuota` (cannot assess under-use
    // without an entitlement baseline). Threshold = "any shortfall" (used <
    // entitlement) — intentionally distinct from the FR-021 US4 25pt-gap rule.
    //
    // 067 — the SAME fan-out also resolves each distinct plan's display LABEL
    // (`getPlanLabel`), memoized per `planId` (not per plan-year key) since the
    // tier-distribution chart collapses plan year (`groupActiveMembersByTier`
    // groups by planId only). A plan/year that fails to resolve a label is
    // simply absent from the map — `groupActiveMembersByTier` folds it into
    // the `unassigned` bucket, same null-handling as the quota entitlements.
    const distinctPlans = new Map<string, { planId: string; planYear: number }>();
    for (const m of activeMembers) {
      const key = planKey(m.planId, m.planYear);
      if (!distinctPlans.has(key)) distinctPlans.set(key, m);
    }
    const entitlementByPlanKey = new Map<string, QuotaEntitlement>();
    const labelByPlanId = new Map<string, string>();
    await Promise.all(
      [...distinctPlans].map(async ([key, ref]) => {
        const [ent, label] = await Promise.all([
          deps.planSource.getEntitlements(ctx, ref.planId, ref.planYear),
          deps.planSource.getPlanLabel(ctx, ref.planId, ref.planYear),
        ]);
        if (ent !== null) {
          entitlementByPlanKey.set(key, {
            eblastPerYear: ent.eblastPerYear,
            culturalTicketsPerYear: ent.culturalTicketsPerYear,
          });
        }
        if (label !== null && !labelByPlanId.has(ref.planId)) {
          labelByPlanId.set(ref.planId, label);
        }
      }),
    );
    const quota = countUnderUsedQuota({
      members: activeMembers,
      eblastUsedByMember,
      culturalUsedByMember,
      entitlementByPlanKey,
    });

    // 067 — active-membership tier breakdown (unassigned bucket for members
    // whose plan/year label didn't resolve; sorted, sums to `statusCounts.active`).
    const tierDistribution = groupActiveMembersByTier(
      activeMembers,
      (planId) => labelByPlanId.get(planId) ?? null,
    );

    // 067 — invoice-status distribution chart. `satang` is a bigint on the
    // port's return shape (matches the money convention elsewhere); mapped to
    // a decimal string here — JSONB (the snapshot cache column) has no bigint.
    const invoiceStatus: InvoiceStatusDistribution = {
      buckets: invoiceStatusRaw.buckets.map((b) => ({
        bucket: b.bucket,
        satang: b.satang.toString(),
        count: b.count,
      })),
      draftCount: invoiceStatusRaw.draftCount,
    };

    // Candidate insights — at-risk follow-up + the 2 quota cards. A count=0 card
    // is NOT emitted (parity with the at-risk gate); dismissals are filtered next.
    const candidates: SmartInsight[] = [];
    if (atRisk > 0) candidates.push({ key: 'at_risk_followup', count: atRisk });
    if (quota.unusedEblastMembers > 0) {
      candidates.push({ key: 'unused_eblast_quota', count: quota.unusedEblastMembers });
    }
    if (quota.underusedTicketMembers > 0) {
      candidates.push({ key: 'underused_event_tickets', count: quota.underusedTicketMembers });
    }

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
        // P1-4 / FR-004 — UNION of members under-using EITHER quota benefit.
        underDeliveredBenefitCount: quota.underDeliveredEither,
        needsAttention: {
          broadcastsAwaitingApproval,
          overdueInvoices,
          atRiskMembers: atRisk,
        },
        revenueTrend,
        memberGrowth,
        topInsights,
        tierDistribution,
        invoiceStatus,
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
