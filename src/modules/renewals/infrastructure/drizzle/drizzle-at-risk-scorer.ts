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
 * Factor coverage (all 8 implemented end-to-end; BUG-1 + follow-up wired the
 * three F6 factors via `EventAttendeesPort.listAttendances` now that F6
 * shipped 2026-05-19 — activeMax=100 is now fully realizable):
 *
 *   F6-INDEPENDENT (5):
 *     ✓ tenureDays                 — F3 members.created_at proxy
 *     ✓ invoicesOverdueCount       — F4 invoices status='issued' AND
 *                                     created_at < now - 30d
 *     ✓ daysSinceLastPayment       — F4 max(paid_at) per member
 *     ✓ daysSinceContactUpdate     — F3 members.last_activity_at
 *     ✓ tierDowngradedLast12Months — F2 audit_log scan: looks for any
 *                                     `member_plan_changed` event in the
 *                                     last 12mo where the new plan's
 *                                     renewal_tier_bucket ordinal is lower
 *                                     than the old plan's (a move to a
 *                                     lower tier BUCKET, not just a fee
 *                                     cut) (063 bucket-ordinal fix)
 *     ✓ eBlastQuotaPctUsed         — F7 broadcasts the member ORIGINATED
 *                                     (requested_by_member_id) that were
 *                                     SENT in the current quota year, vs
 *                                     plan benefit_matrix.eblast_per_year.
 *                                     Matches F9's benefit-usage `used`
 *                                     (computeQuotaCounter.used = sent
 *                                     this year), NOT F7's enforcement
 *                                     count — reserved/in-flight rows are
 *                                     excluded so a stale prior-year
 *                                     reservation can't suppress the risk
 *                                     signal (063 axis + quota-year +
 *                                     #8 usage-notion fix)
 *
 *   F6-DEPENDENT (3):
 *     ✓ eventsAttendedLast12Months — F6 listAttendances, 12mo window (BUG-1)
 *     ✓ eventsAttendedLast3Months  — F6 listAttendances, 3mo window (BUG-1)
 *     ✓ culturalTicketQuotaPctUsed — F6 cultural attendance / cultural_tickets
 *                                     _per_year, current calendar year (BUG-1
 *                                     follow-up; nextResetAtFor window)
 *
 * F6 factors are gathered ONLY when `isAvailable()` (F6 flag on); the stub
 * returns [] so activeMax stays 70. Any factor left `undefined` (e.g. a plan
 * with no cultural entitlement) the Domain tolerates by skipping (contributes
 * 0); Wave A1's property-based test pins the "0-contribution-when-undefined"
 * invariant (`tests/unit/renewals/domain/at-risk-score.test.ts`).
 *
 * Tenant isolation: most tables (members, invoices, membership_plans,
 * renewal_*) use strict isolating RLS policies and require NO explicit
 * `WHERE tenant_id = ?` — `runInTenant` SET LOCAL is sufficient. However,
 * `audit_log` uses a PERMISSIVE policy where rows with NULL tenant_id (F1
 * identity events, migration 0007) remain visible to every tenant context.
 * Therefore any `audit_log` query in this file MUST include an explicit
 * `al.tenant_id = ${tenantId}` predicate — it is load-bearing, not
 * defence-in-depth. A future audit_log query added here MUST carry the same
 * explicit filter.
 * The `broadcasts` table query also includes an explicit `b.tenant_id`
 * predicate as defence-in-depth (Phase 6 review I7 pattern), consistent
 * with the batch scorer (`drizzle-member-renewal-flags-repo.ts`).
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
import { broadcasts } from '@/modules/broadcasts/infrastructure/schema';
import { currentQuotaYear, nextResetAtFor } from '@/modules/broadcasts';
import { env } from '@/lib/env';
import { tierBucketDowngradePredicateSql } from './tier-bucket-ordinal-sql';
import {
  computeAtRiskScore,
  ENGAGEMENT_OBSERVATION_MIN_DAYS,
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
      //    last_activity_at as the closest available signal). Round 8
      //    review-fix — folded plan_id + plan_year into the same SELECT
      //    so we make ONE round-trip to the members PK instead of two
      //    (Round 7 introduced a duplicate query; T262 already at
      //    84.95s @ 1k cron-dispatch SLO so every avoidable round-trip
      //    counts).
      const memberRows = await tx
        .select({
          createdAt: members.createdAt,
          registrationDate: members.registrationDate,
          lastActivityAt: members.lastActivityAt,
          planId: members.planId,
          planYear: members.planYear,
        })
        .from(members)
        .where(eq(members.memberId, memberId))
        .limit(1);
      const memberRow = memberRows[0];

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
          MAX(paid_at) FILTER (WHERE status IN ('paid','partially_credited')) AS last_paid_at
        FROM ${invoices}
        WHERE member_id = ${memberId}
          -- I7 defence-in-depth: invoices has a strict isolating RLS policy
          -- so runInTenant already scopes this query; the explicit predicate
          -- matches the batch scorer (drizzle-member-renewal-flags-repo.ts
          -- ~line 502) for consistency. Result is RLS-identical.
          AND tenant_id = ${tenantId}
      `);
      const aggRow = invoiceAgg[0];

      const nowMs = Date.now();
      // Tenure = real membership age → registration_date (the true membership
      // start), NOT created_at. For an imported member created_at is the import
      // instant, so a decade-long member would read as ~0-day tenure and be
      // mis-handled by the FR-035 min-tenure gate. registration_date is a
      // `date` col (notNull, defaultNow) → parse to a Date; fall back to
      // created_at defensively. MUST match the batch scorer
      // (drizzle-member-renewal-flags-repo.ts) to avoid single/batch drift.
      // Two-tier anchor (MUST mirror the batch scorer's fallback): use
      // registration_date when it parses, else fall back to created_at. A
      // present-but-unparseable registration_date must still fall back (not
      // yield undefined tenure), so single == batch for the same member.
      let tenureAnchorMs: number | undefined;
      if (memberRow?.registrationDate != null) {
        const t = new Date(
          memberRow.registrationDate as string | Date,
        ).getTime();
        if (!Number.isNaN(t)) tenureAnchorMs = t;
      }
      if (tenureAnchorMs === undefined && memberRow?.createdAt != null) {
        tenureAnchorMs = memberRow.createdAt.getTime();
      }
      const tenureDays =
        tenureAnchorMs !== undefined
          ? Math.floor((nowMs - tenureAnchorMs) / (24 * 60 * 60 * 1000))
          : undefined;
      // In-system observation window = now - created_at (when we STARTED
      // observing this member's in-system benefit usage). Distinct from tenure:
      // an imported member has LONG tenure but a SHORT observation window. Gates
      // the engagement factors (G5) so a never-onboarded member's pre-import
      // zero usage is treated as "no data yet" (skip), not "disengaged".
      const inSystemDays =
        memberRow?.createdAt != null
          ? Math.floor(
              (nowMs - memberRow.createdAt.getTime()) / (24 * 60 * 60 * 1000),
            )
          : undefined;
      const engagementObserved =
        inSystemDays !== undefined &&
        inSystemDays >= ENGAGEMENT_OBSERVATION_MIN_DAYS;
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
      // Review Task 11 follow-up fix — postgres-js returns a raw
      // `tx.execute(sql\`...\`)` timestamptz column as EITHER a `Date` or
      // an ISO string depending on column metadata (same documented
      // gotcha as the batch scorer's `toIso` helper in
      // drizzle-member-renewal-flags-repo.ts). Calling `.getTime()`
      // directly on `aggRow.last_paid_at` crashed with "getTime is not a
      // function" the first time a live (non-credited/void) paid invoice
      // reached this path — no prior test had ever seeded one, so the
      // F-3 status-filter integration tests (at-risk-f2-f7-factors.test.ts)
      // are what surfaced it. Normalise via the `Date` constructor before
      // computing the day delta, mirroring the batch scorer's pattern.
      const lastPaidAtDate: Date | null =
        aggRow?.last_paid_at != null
          ? aggRow.last_paid_at instanceof Date
            ? aggRow.last_paid_at
            : new Date(aggRow.last_paid_at)
          : null;
      const daysSinceLastPayment =
        lastPaidAtDate != null
          ? Math.floor(
              (nowMs - lastPaidAtDate.getTime()) / (24 * 60 * 60 * 1000),
            )
          : undefined;

      // Per-tenant min-tenure threshold from tenant_renewal_settings;
      // default 30 if no row.
      const settings =
        await deps.tenantRenewalSettingsRepo.findByTenant(tenantId);
      const minTenureDays = settings?.minTenureDaysForAtRisk ?? 30;

      // ----------------------------------------------------------------
      // F2 audit-log scan: tier_downgraded_last_12mo (FR-029 line 8).
      // Consumes the `member_plan_changed` audit trail (emitted by F3
      // change-plan) joined against `membership_plans` to detect a
      // downgrade in the last 12 months.
      //
      // 063 correctness fix — a "downgrade" is a move to a lower tier
      // BUCKET (`renewal_tier_bucket` ordinal), NOT merely an annual-fee
      // decrease. The prior `np.annual_fee_minor_units <
      // op.annual_fee_minor_units` test falsely flagged a same-bucket fee
      // cut (custom pricing / override) as a downgrade, and diverged from
      // the batch scorer (`drizzle-member-renewal-flags-repo.ts`) which
      // already compared the bucket ordinal. Both now use the shared
      // `tierBucketDowngradePredicateSql` fragment, derived from the
      // Domain `TIER_BUCKETS` tuple, so the two cannot drift.
      //
      // The `CASE WHEN … ~ '^[0-9]+$' THEN (…)::int END` guard mirrors
      // the batch (Phase 6 review C3): a malformed payload year for ONE
      // member's audit row is treated as "no match" instead of aborting
      // the whole query. The guard is at the EXPRESSION level (the cast
      // is only reached inside the THEN branch), NOT a planner-order
      // assumption: an `AND regex AND cast=…` pattern does NOT guarantee
      // the regex evaluates before the `::int` cast (Postgres may reorder
      // AND clauses), so a malformed year could still crash with
      // `invalid input syntax for type integer`. CASE provably short-
      // circuits — a non-matching year yields NULL, and `NULL = op.plan_year`
      // is NULL (not true), so the row is excluded (no crash, no false
      // downgrade). Years are zod-guarded on write today; this hardens
      // against corrupt/legacy/future-drift payloads.
      //
      // audit_log has ENABLE + FORCE RLS, but its policy is PERMISSIVE:
      // rows with NULL tenant_id (F1 identity events) remain visible to
      // every tenant context (migration 0007). membership_plans uses a
      // strict isolating policy and IS fully scoped automatically.
      // The explicit tenant_id predicate on both tables is therefore
      // load-bearing for audit_log, not merely defence-in-depth. Single
      // query; O(1) per member (we short-circuit on the first downgrade
      // row found).
      // ----------------------------------------------------------------
      const downgradeProbe = await tx.execute<{ has_downgrade: boolean }>(sql`
        SELECT EXISTS (
          SELECT 1
          FROM ${auditLog} al
          JOIN ${membershipPlans} op
            ON op.tenant_id = al.tenant_id
           AND op.plan_id = al.payload->>'old_plan_id'
           AND op.plan_year = CASE
                 WHEN al.payload->>'old_plan_year' ~ '^[0-9]+$'
                 THEN (al.payload->>'old_plan_year')::int
               END
          JOIN ${membershipPlans} np
            ON np.tenant_id = al.tenant_id
           AND np.plan_id = al.payload->>'new_plan_id'
           AND np.plan_year = CASE
                 WHEN al.payload->>'new_plan_year' ~ '^[0-9]+$'
                 THEN (al.payload->>'new_plan_year')::int
               END
          WHERE al.event_type = 'member_plan_changed'
            AND al.tenant_id = ${tenantId}
            AND al.payload->>'member_id' = ${memberId}
            AND al.timestamp > NOW() - INTERVAL '12 months'
            AND ${sql.raw(
              tierBucketDowngradePredicateSql(
                'np.renewal_tier_bucket',
                'op.renewal_tier_bucket',
              ),
            )}
        ) AS has_downgrade
      `);
      // Round 8 review-fix — defensive Boolean() coerce so a future
      // refactor that switches the EXISTS to a CASE/COUNT shape (which
      // would return string/number not native bool) still type-checks
      // and produces correct truthy/falsy semantics.
      const tierDowngradedLast12Months = Boolean(
        downgradeProbe[0]?.has_downgrade,
      );

      // ----------------------------------------------------------------
      // F7 broadcast quota: eBlastQuotaPctUsed (FR-029 line 3).
      // Member's plan benefit_matrix.eblast_per_year is the per-quota-year
      // SENDING budget. The at-risk ENGAGEMENT factor asks "did the member
      // USE the benefit THIS year?" — so "used %" here = broadcasts the
      // member ORIGINATED that were actually SENT in the current quota
      // year, divided by the cap. This is the exact number the member
      // sees as "used" on their /portal/benefits page.
      //
      // 063 axis fix (#3) — this previously counted `broadcast_deliveries
      // WHERE recipient_member_id = member` (RECEIVED axis), which is the
      // WRONG axis: per F7 Q16 the e-blast quota is consumed by the
      // ORIGINATOR (`requested_by_member_id`) and the sender is EXCLUDED
      // from receiving their own broadcast, so received-count is unrelated
      // to the member's own quota. The ORIGINATED axis is correct + matches
      // the batch scorer (`drizzle-member-renewal-flags-repo.ts`).
      //
      // 063 usage-notion refinement (#8) — the at-risk engagement factor
      // counts USAGE = F9 benefit-usage `used` (sent THIS quota year only),
      // NOT F7's quota-ENFORCEMENT count (sent + reserved). This matches
      // `computeQuotaCounter(...).counter.used`, which is `counts.sent`
      // from `countForMemberQuota` (the year-fenced sent bucket); the
      // separate `reserved`/`submittedOrApproved` bucket is deliberately
      // EXCLUDED from `used`. The divergence from F7's enforcement count
      // (which DOES include reserved) is intentional: enforcement must
      // refuse a 6th send while a slot is in-flight, but engagement asks
      // whether the benefit was actually delivered.
      //
      // Why reserved MUST be dropped here: a reserved row
      // (submitted/approved/failed_to_dispatch) carries
      // `quota_year_consumed IS NULL` (schema CHECK
      // `broadcasts_quota_year_only_on_sent`), so it has NO year fence.
      // NOTE: `failed_to_dispatch` RELEASES the quota slot (Design D1,
      // 2026-06-21); this query counts only `sent` rows regardless, so it
      // is unaffected by D1. Counting reserved rows would inflate this
      // year's usage, push pct >= 30, and SILENTLY SUPPRESS the +15 risk
      // factor for a disengaged member (#8). Counting only sent-this-year
      // cannot leak a stale prior-year slot.
      //
      // Returned `undefined` (skipped) when:
      //   - member's plan has no benefit_matrix (orphan)
      //   - eblast_per_year === 0 (plan with no quota — Junior tier)
      // Domain handles `undefined` as a 0-contribution skip per the
      // computeAtRiskScore contract.
      //
      // Tenant timezone (env.tenant.timezone) feeds currentQuotaYear so
      // the year boundary aligns with however F7 wrote the broadcasts row
      // at send time (SweCham is Bangkok; future non-Bangkok tenants stay
      // correct).
      // ----------------------------------------------------------------
      let eBlastQuotaPctUsed: number | undefined;
      // BUG-1 follow-up — cultural-ticket entitlement hoisted out of the eblast
      // block so the F6 block below can read it from the SAME plan row.
      let culturalEntitlement = 0;
      if (memberRow != null) {
        const planRows = await tx
          .select({
            benefitMatrix: membershipPlans.benefitMatrix,
          })
          .from(membershipPlans)
          .where(
            sql`${membershipPlans.planId} = ${memberRow.planId}
                AND ${membershipPlans.planYear} = ${memberRow.planYear}`,
          )
          .limit(1);
        const benefitMatrix = planRows[0]?.benefitMatrix;
        culturalEntitlement = benefitMatrix?.cultural_tickets_per_year ?? 0;
        const eblastQuota = benefitMatrix?.eblast_per_year ?? 0;
        if (eblastQuota > 0) {
          const quotaYear = currentQuotaYear(
            new Date(),
            env.tenant.timezone,
          );
          // F9 benefit-usage `used`: rows that CONSUMED the annual quota
          // slot this year. Mirrors countForMemberQuota's `sent` bucket
          // (the value computeQuotaCounter assigns to `counter.used`).
          // Both `sent` AND `partial_delivery_accepted` consume the slot
          // (schema CHECK `broadcasts_quota_year_only_on_sent` stamps
          // `quota_year_consumed` for BOTH terminal states; FR-008c) — so
          // counting only `sent` UNDERCOUNTS usage and falsely fires the
          // "+15 didn't use e-blast" risk factor for a member who did send
          // (partial accept). Reserved rows (submitted/approved/
          // failed_to_dispatch) are still EXCLUDED here — see the #8 note
          // above — they carry `quota_year_consumed IS NULL` so the year
          // fence drops them regardless.
          const usedRows = await tx.execute<{ used_count: string }>(sql`
            SELECT count(*)::text AS used_count
            FROM ${broadcasts} b
            WHERE b.tenant_id = ${tenantId}
              AND b.requested_by_member_id = ${memberId}
              AND b.status IN ('sent', 'partial_delivery_accepted')
              AND b.quota_year_consumed = ${quotaYear}
          `);
          const usedCount = Number.parseInt(
            usedRows[0]?.used_count ?? '0',
            10,
          );
          eBlastQuotaPctUsed = (usedCount / eblastQuota) * 100;
        }
      }

      // BUG-1 — F6 event-attendance factors (events_12mo/3mo). Reuse the
      // injected EventAttendeesPort (proven RLS-scoped + fail-open) instead of
      // a raw events query. Gathered ONLY when F6 is available; the stub
      // returns [] and activeMax stays 70. `listAttendances` opens its own
      // runInTenant (nested, separate RLS-scoped tx) — one extra round-trip on
      // this ad-hoc/small-N per-member path (the weekly cron uses the set-based
      // batch CTE in drizzle-member-renewal-flags-repo.ts, not this scorer).
      let eventsAttendedLast12Months: number | undefined;
      let eventsAttendedLast3Months: number | undefined;
      // BUG-1 follow-up — F6 cultural-ticket quota-usage factor (FR-029 line 4).
      let culturalTicketQuotaPctUsed: number | undefined;
      if (f6Available) {
        // Fetch [now-370d, now]: the lower bound is a safe superset (370d
        // covers a full 12 CALENDAR months incl. leap) so the calendar-month
        // count below is never truncated; `untilIso: now` upper-bounds at the
        // DB so future-dated registrations are excluded BEFORE the 500-row cap
        // + DESC ordering apply (else future rows could sort first and consume
        // the cap, undercounting real past attendance). Matches the batch
        // LATERAL's `start_date <= NOW()`.
        const attendances = await deps.eventAttendees.listAttendances(
          tenantId,
          memberId,
          {
            sinceIso: new Date(nowMs - 370 * 24 * 60 * 60 * 1000).toISOString(),
            untilIso: new Date(nowMs).toISOString(),
            limit: 500,
          },
        );
        // Final-review fix: use CALENDAR-month lower bounds (setMonth) to match
        // the batch CTE's `NOW() - INTERVAL '12 months'/'3 months'` — FR-029
        // says "last N MONTHS", and a fixed-day (365d/90d) bound diverged from
        // the batch by 1-2 days at the boundary (band flicker between the
        // admin single-recompute and the weekly cron). Both now upper-bound at
        // `now` so future registrations don't count (batch: `start_date <= NOW()`).
        const twelveMonthsAgoMs = (() => {
          const d = new Date(nowMs);
          d.setMonth(d.getMonth() - 12);
          return d.getTime();
        })();
        const threeMonthsAgoMs = (() => {
          const d = new Date(nowMs);
          d.setMonth(d.getMonth() - 3);
          return d.getTime();
        })();
        eventsAttendedLast12Months = attendances.filter((a) => {
          const t = new Date(a.attendedAt).getTime();
          return t > twelveMonthsAgoMs && t <= nowMs;
        }).length;
        eventsAttendedLast3Months = attendances.filter((a) => {
          const t = new Date(a.attendedAt).getTime();
          return t > threeMonthsAgoMs && t <= nowMs;
        }).length;

        // BUG-1 follow-up — cultural-ticket quota % used (FR-029 line 4:
        // <50% used -> +10). Cultural attendance = an event whose eventType
        // includes 'cultural' (derived directly from events.is_cultural_event
        // by the F6 adapter's deriveEventType — provably equivalent to the
        // batch CTE's `is_cultural_event = true`), within the CURRENT calendar
        // year in the tenant timezone (F9 benefit-usage parity: window start =
        // nextResetAtFor(quotaYear-1) = Jan-01 of the current quota year),
        // upper-bounded at now. Both scorers use nextResetAtFor so single and
        // batch cannot drift. Skipped (undefined -> Domain contributes 0) when
        // the plan has no cultural entitlement.
        if (culturalEntitlement > 0) {
          const quotaYear = currentQuotaYear(new Date(), env.tenant.timezone);
          const yearStartMs = new Date(
            nextResetAtFor(quotaYear - 1, env.tenant.timezone),
          ).getTime();
          const culturalUsed = attendances.filter((a) => {
            if (!a.eventType.includes('cultural')) return false;
            const t = new Date(a.attendedAt).getTime();
            return t >= yearStartMs && t <= nowMs;
          }).length;
          culturalTicketQuotaPctUsed =
            (culturalUsed / culturalEntitlement) * 100;
        }
      }

      // G5 — gate the engagement factors on the in-system observation window.
      // A member we have NOT observed in-system for a full quota year has no
      // meaningful usage history yet (e.g. an imported member never onboarded),
      // so their 0 usage is "no data yet" → undefined (Domain skips it), NOT
      // "disengaged". Mirrors the payment factor's undefined-when-absent
      // handling; MUST match the batch scorer to avoid single/batch drift.
      if (!engagementObserved) {
        eBlastQuotaPctUsed = undefined;
        eventsAttendedLast12Months = undefined;
        eventsAttendedLast3Months = undefined;
        culturalTicketQuotaPctUsed = undefined;
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
        // BUG-1 — F6 factors (events_12mo/3mo + cultural). Undefined when F6 is
        // unavailable → Domain skips them, activeMax stays 70.
        ...(eventsAttendedLast12Months !== undefined
          ? { eventsAttendedLast12Months }
          : {}),
        ...(eventsAttendedLast3Months !== undefined
          ? { eventsAttendedLast3Months }
          : {}),
        ...(culturalTicketQuotaPctUsed !== undefined
          ? { culturalTicketQuotaPctUsed }
          : {}),
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
