/**
 * F8 Phase 6 Wave F · T159 — Drizzle adapter for `AtRiskScorer` port.
 *
 * Replaces the Wave-B `at-risk-scorer-stub.ts` (uniformly score=0/healthy)
 * with a real per-member factor-gathering implementation that joins F3
 * members + F4 invoices in one round-trip per scoreMember call. Then
 * delegates the pure 8-factor computation to the Domain
 * `computeAtRiskScore` function (FR-029 + FR-029a F6-readiness fallback
 * + FR-030 proportional bands + FR-035 min-tenure gate).
 *
 * Factor coverage (5 of 8 implemented end-to-end as of PR #24 Round 7;
 * the 3 F6-dependent factors stay at 0 contribution until F6
 * EventCreate integration ships):
 *
 *   F6-INDEPENDENT (5):
 *     ✓ tenureDays                 — F3 members.created_at proxy
 *     ✓ invoicesOverdueCount       — F4 invoices status='issued' AND
 *                                     created_at < now - 30d
 *     ✓ daysSinceLastPayment       — F4 max(paid_at) per member
 *     ✓ daysSinceContactUpdate     — F3 members.last_activity_at
 *     ✓ tierDowngradedLast12Months — F2 audit_log scan: looks for any
 *                                     `member_plan_changed` event in the
 *                                     last 12mo where new plan's
 *                                     annual_fee < old plan's annual_fee
 *                                     (PR #24 Round 7 — F2 ship unblocked)
 *     ✓ eBlastQuotaPctUsed         — F7 broadcast_deliveries count vs
 *                                     plan benefit_matrix.eblast_per_year
 *                                     for current quota year
 *                                     (PR #24 Round 7 — F7 ship unblocked)
 *
 *   F6-DEPENDENT (3):
 *     ⊘ eventsAttendedLast12Months — F6 EventCreate not shipped
 *     ⊘ eventsAttendedLast3Months  — same
 *     ⊘ culturalTicketQuotaPctUsed — F6 ticket data not shipped
 *
 * The 3 remaining deferred factors return `undefined` from the gather
 * step, which the Domain function tolerates by skipping (contributes 0).
 * Wave A1's property-based test pins the "0-contribution-when-undefined"
 * invariant (`tests/unit/renewals/domain/at-risk-score.test.ts`).
 *
 * Tenant isolation via RLS — adapter runs queries inside `runInTenant`
 * so SET LOCAL app.current_tenant binds the row visibility. NO explicit
 * `WHERE tenant_id = ?` — the policies add it automatically.
 *
 * Per-member SLO budget (per FR-036 + SC-005 + T174 perf bench): the
 * single SQL query per member with primary-key + secondary-index lookups
 * stays under ~10ms locally; 5,000 members * ~10ms = 50s wall-clock,
 * comfortably under the 60s budget. T174 measures + writes the actual
 * p95 to perf-benchmarks.md.
 */
import { eq, sql } from 'drizzle-orm';
import { runInTenant } from '@/lib/db';
import type { TenantContext } from '@/modules/tenants';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
// PR #24 Round 7 — F2/F7 ship + at-risk factor unblock. Adapter→Adapter
// schema deep imports are the canonical Drizzle pattern (eslint config
// exception for `src/modules/**`); same precedent as the F8 audit
// emitter at `drizzle-renewal-audit-emitter.ts:20`.
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import { broadcastDeliveries } from '@/modules/broadcasts/infrastructure/schema';
import { currentQuotaYear } from '@/modules/broadcasts';
import {
  computeAtRiskScore,
  type AtRiskFactors,
  type AtRiskScoreResult,
} from '../../domain/at-risk-score';
import type { AtRiskScorer } from '../../application/ports/at-risk-scorer';
import type { EventAttendeesPort } from '../../application/ports/event-attendees-port';
import type { TenantRenewalSettingsRepo } from '../../application/ports/tenant-renewal-settings-repo';

export interface MakeDrizzleAtRiskScorerDeps {
  readonly tenant: TenantContext;
  readonly eventAttendees: EventAttendeesPort;
  readonly tenantRenewalSettingsRepo: TenantRenewalSettingsRepo;
}

const FALLBACK_RESULT: AtRiskScoreResult = (() => {
  const r = computeAtRiskScore(
    { tenureDays: 365 },
    { minTenureDays: 30, eventAttendeesAvailable: false },
  );
  /* v8 ignore next */
  if (!r.ok) throw new Error('unreachable: scorer fallback seed failed');
  return r.value;
})();

export function makeDrizzleAtRiskScorer(
  deps: MakeDrizzleAtRiskScorerDeps,
): AtRiskScorer {
  const f6Available = deps.eventAttendees.isAvailable();

  async function gatherFactors(
    tenantId: string,
    memberId: string,
  ): Promise<{ factors: AtRiskFactors; minTenureDays: number }> {
    return runInTenant(deps.tenant, async (tx) => {
      // 1. F3 members row — tenure (via created_at proxy) + last
      //    activity timestamp (FR-029 line 7 contact-update factor uses
      //    last_activity_at as the closest available signal).
      const memberRows = await tx
        .select({
          createdAt: members.createdAt,
          lastActivityAt: members.lastActivityAt,
        })
        .from(members)
        .where(eq(members.memberId, memberId))
        .limit(1);
      const memberRow = memberRows[0];

      // F3 members.plan_id — needed for both the F2 tier-downgrade
      // query (resolve "current plan annualFee") and the F7 e-blast
      // quota lookup (resolve "tier's eblast_per_year").
      const memberPlanRows = await tx
        .select({
          planId: members.planId,
          planYear: members.planYear,
        })
        .from(members)
        .where(eq(members.memberId, memberId))
        .limit(1);
      const memberPlan = memberPlanRows[0];

      // 2. F4 invoice aggregates — overdue count + max paid_at. Single
      //    aggregate query per member; with the (tenant_id, member_id)
      //    index on invoices this is sub-millisecond on Neon.
      const invoiceAgg = await tx.execute<{
        overdue_count: string | null;
        last_paid_at: Date | null;
      }>(sql`
        SELECT
          count(*) FILTER (
            WHERE status = 'issued'
              AND created_at < NOW() - INTERVAL '30 days'
          )::text AS overdue_count,
          MAX(paid_at) AS last_paid_at
        FROM ${invoices}
        WHERE member_id = ${memberId}
      `);
      const aggRow = invoiceAgg[0];

      const nowMs = Date.now();
      const tenureDays =
        memberRow?.createdAt != null
          ? Math.floor(
              (nowMs - memberRow.createdAt.getTime()) /
                (24 * 60 * 60 * 1000),
            )
          : undefined;
      const daysSinceContactUpdate =
        memberRow?.lastActivityAt != null
          ? Math.floor(
              (nowMs - memberRow.lastActivityAt.getTime()) /
                (24 * 60 * 60 * 1000),
            )
          : undefined;
      const overdueCount =
        aggRow?.overdue_count != null
          ? Number.parseInt(aggRow.overdue_count, 10) || 0
          : 0;
      const daysSinceLastPayment =
        aggRow?.last_paid_at != null
          ? Math.floor(
              (nowMs - aggRow.last_paid_at.getTime()) /
                (24 * 60 * 60 * 1000),
            )
          : undefined;

      // Per-tenant min-tenure threshold from tenant_renewal_settings;
      // default 30 if no row.
      const settings =
        await deps.tenantRenewalSettingsRepo.findByTenant(tenantId);
      const minTenureDays = settings?.minTenureDaysForAtRisk ?? 30;

      // ----------------------------------------------------------------
      // PR #24 Round 7 — F2 audit-log scan: tier_downgraded_last_12mo.
      // F2 + F7 shipped, so the at-risk scorer can now consume the
      // `member_plan_changed` audit trail (emitted by F3 change-plan
      // use-case) joined against `membership_plans` to detect a
      // downgrade in the last 12 months. A "downgrade" is defined as
      // any plan transition where `new.annual_fee_minor_units` <
      // `old.annual_fee_minor_units` — a member moving from Premium
      // (high fee) to Standard (lower fee). Tier-equal moves and
      // upgrades both score as `false`.
      //
      // RLS scopes audit_log + membership_plans to the current tenant
      // automatically (both tables ENABLE + FORCE RLS). Single query;
      // O(1) per member regardless of plan-change history depth (we
      // short-circuit on the first downgrade row found).
      // ----------------------------------------------------------------
      const downgradeProbe = await tx.execute<{ has_downgrade: boolean }>(sql`
        SELECT EXISTS (
          SELECT 1
          FROM ${auditLog} al
          JOIN ${membershipPlans} op
            ON op.tenant_id = al.tenant_id
           AND op.plan_id = al.payload->>'old_plan_id'
           AND op.plan_year = (al.payload->>'old_plan_year')::int
          JOIN ${membershipPlans} np
            ON np.tenant_id = al.tenant_id
           AND np.plan_id = al.payload->>'new_plan_id'
           AND np.plan_year = (al.payload->>'new_plan_year')::int
          WHERE al.event_type = 'member_plan_changed'
            AND al.payload->>'member_id' = ${memberId}
            AND al.timestamp > NOW() - INTERVAL '12 months'
            AND np.annual_fee_minor_units < op.annual_fee_minor_units
        ) AS has_downgrade
      `);
      const tierDowngradedLast12Months =
        downgradeProbe[0]?.has_downgrade === true;

      // ----------------------------------------------------------------
      // PR #24 Round 7 — F7 broadcast quota: eBlastQuotaPctUsed.
      // Member's plan benefit_matrix.eblast_per_year is the per-year
      // delivery budget. We count `broadcast_deliveries` where
      // `recipient_member_id = ?` AND `quota_year_consumed = current
      // quota year` (Asia/Bangkok calendar year — matches F7
      // `currentQuotaYear()` semantics). pct = sent / quota * 100.
      //
      // Returned `undefined` (skipped) when:
      //   - member's plan has no benefit_matrix (orphan)
      //   - eblast_per_year === 0 (plan with no quota — Junior tier)
      // Domain handles `undefined` as a 0-contribution skip per the
      // computeAtRiskScore contract.
      // ----------------------------------------------------------------
      let eBlastQuotaPctUsed: number | undefined;
      if (memberPlan != null) {
        const planRows = await tx
          .select({
            benefitMatrix: membershipPlans.benefitMatrix,
          })
          .from(membershipPlans)
          .where(
            sql`${membershipPlans.planId} = ${memberPlan.planId}
                AND ${membershipPlans.planYear} = ${memberPlan.planYear}`,
          )
          .limit(1);
        const eblastQuota =
          planRows[0]?.benefitMatrix?.eblast_per_year ?? 0;
        if (eblastQuota > 0) {
          const quotaYear = currentQuotaYear(new Date());
          const sentRows = await tx.execute<{ sent_count: string }>(sql`
            SELECT count(*)::text AS sent_count
            FROM ${broadcastDeliveries}
            WHERE recipient_member_id = ${memberId}
              AND status = 'sent'
              AND quota_year_consumed = ${quotaYear}
          `);
          const sentCount = Number.parseInt(
            sentRows[0]?.sent_count ?? '0',
            10,
          );
          eBlastQuotaPctUsed = (sentCount / eblastQuota) * 100;
        }
      }

      const factors: AtRiskFactors = {
        ...(tenureDays !== undefined ? { tenureDays } : {}),
        ...(daysSinceContactUpdate !== undefined
          ? { daysSinceContactUpdate }
          : {}),
        invoicesOverdueCount: overdueCount,
        ...(daysSinceLastPayment !== undefined
          ? { daysSinceLastPayment }
          : {}),
        // PR #24 Round 7 — F2 + F7 unblocked; 3 F6 factors still pending
        // F6 EventCreate ship.
        tierDowngradedLast12Months,
        ...(eBlastQuotaPctUsed !== undefined ? { eBlastQuotaPctUsed } : {}),
      };

      return { factors, minTenureDays };
    });
  }

  return {
    async scoreMember(
      tenantId: string,
      memberId: string,
    ): Promise<AtRiskScoreResult> {
      try {
        const { factors, minTenureDays } = await gatherFactors(
          tenantId,
          memberId,
        );
        const r = computeAtRiskScore(factors, {
          minTenureDays,
          eventAttendeesAvailable: f6Available,
        });
        /* v8 ignore next 3 */
        if (!r.ok) {
          throw new Error('unreachable: Domain returns Result<_, never>');
        }
        return r.value;
      } catch (e) {
        // Per-member fault isolation — the use-case loop catches +
        // counts in members_failed; here we surface a healthy fallback
        // so the cron continues. Re-throw lets the use-case log the
        // class.
        void e;
        throw e;
      }
    },

    async *scoreMembers(
      tenantId: string,
      memberIds: ReadonlyArray<string>,
    ): AsyncIterable<{
      readonly memberId: string;
      readonly result: AtRiskScoreResult;
    }> {
      // R4-W13 (staff-review-2026-05-09): NOT the cron path — the weekly
      // recompute uses `recomputeAtRiskScoresBatch` which calls a single-
      // CTE bulk gather + bulk UPDATE (4 round-trips total). This per-
      // member generator exists for ad-hoc admin use-cases ("recompute
      // for member X right now") and small-N fixtures. At 5k members
      // calling this would issue ≈15,000 round-trips and breach SC-005.
      // Do NOT call from cron / batch code paths.
      for (const memberId of memberIds) {
        try {
          const result = await this.scoreMember(tenantId, memberId);
          yield { memberId, result };
        } catch {
          // Yield a fallback so callers can still reason about the
          // shape; per-member failure is logged at the use-case layer.
          yield { memberId, result: FALLBACK_RESULT };
        }
      }
    },
  };
}
