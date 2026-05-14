/**
 * T086 — Drizzle adapter for `QuotaAccountingPort` (F6 Infrastructure).
 *
 * Bridges the F6 Domain port to:
 *   1. F3 `members` table — reads the matched member's current
 *      `plan_id` + `plan_year` snapshot.
 *   2. F2 `membership_plans` table — loads the row's `benefit_matrix`
 *      JSONB column to derive the per-event partnership allotment +
 *      per-year cultural allotment.
 *   3. F6 `event_registrations` (via the existing
 *      `RegistrationsRepository.countConsumedByMember` port method) —
 *      computes consumed-quota counts.
 *
 * ALL three reads happen via the SAME tx-bound executor — this is a
 * NON-NEGOTIABLE correctness AND performance constraint:
 *
 *   - Correctness: the F6 advisory lock at `apply-quota-effect.ts`
 *     serialises decisions only within the holding connection. Opening
 *     a SECOND connection for F2 plan lookup would let that read race
 *     against another worker's UPDATE that's not yet committed.
 *   - Performance: the F6 ingest spawns ≤N concurrent workers per
 *     (tenant, member, event). If the F2 plan-lookup adapter opened
 *     its own `runInTenant(...)` (which `buildPlansDeps().planRepo.findOne`
 *     does), 2× the connections would be needed — at 10 workers each
 *     wanting outer tx + inner F2 lookup, the postgres-js pool
 *     (default max ~10) deadlocks and the entire ingest set times out.
 *
 * Cross-module Infrastructure schema import (F6 → F2's
 * `membership_plans`) is therefore intentional and pragmatic; it is
 * READ-ONLY and keeps every quota-related query on the SAME connection
 * holding the advisory lock. The Domain + Application boundaries
 * remain clean (Principle III — Application never imports drizzle-orm).
 *
 * Spec authority:
 *   - FR-015 / FR-016 (partnership-per-event + cultural-per-year quotas)
 *   - research.md R5 (compute-on-read + per-tenant adv lock)
 *   - data-model.md § 8 (no stored counter; SUM is canonical)
 */
import { and, eq } from 'drizzle-orm';
import { ok, err, type Result } from '@/lib/result';
import type { TenantTx } from '@/lib/db';
import type { TenantContext } from '@/modules/tenants';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import type { BenefitMatrix } from '@/modules/plans/domain/benefit-matrix';
import type {
  QuotaAccountingPort,
  QuotaAccountingError,
  QueryAllotmentsInput,
  PlanAllotments,
  ConsumedQuota,
} from '../application/ports/quota-accounting-port';
import type { RegistrationsRepository } from '../application/ports/registrations-repository';

/**
 * R6 PERF-05 closure (R7 CODE-FR-01 corrected) — derive an OTel-
 * labelable plan tier slug from the F2 `membership_plans.plan_id`
 * string. Canonical SweCham 2026 plan_ids are documented at
 * `docs/membership-benefits-analysis.md:157` and listed in the
 * seed SQL block at the same file lines 247-260:
 *
 *   - Corporate (6 tiers): `premium`, `large`, `regular`,
 *     `start-up`, `individual`, `thai-alumni`
 *   - Partnership (3 tiers): `diamond`, `platinum`, `gold`
 *
 * The plan_id format is `{tier-slug}` optionally with a `-{year}`
 * suffix (e.g., `diamond-2026`, `start-up-2026`,
 * `thai-alumni-2027`). We strip the trailing year suffix only
 * (regex `/-\d{4}$/`) and validate the remainder against the closed
 * allowlist — this preserves hyphenated slugs like `start-up` +
 * `thai-alumni` that the previous greedy `/^[a-z]+/` regex
 * silently truncated to `start` / `thai` (both then rejected by
 * the allowlist → label degraded to `unknown` for 4 of 6 corporate
 * tiers on the live SweCham tenant). This was the R7 BLOCKER.
 *
 * The plan_id slug guard is case-insensitive and uses a closed
 * allowlist — no risk of OTel label cardinality explosion via
 * attacker-controlled plan_ids (admin-created anyway, but defense-
 * in-depth).
 */
export const KNOWN_PLAN_TIERS = [
  // 6 corporate tiers
  'premium',
  'large',
  'regular',
  'start-up',
  'individual',
  'thai-alumni',
  // 3 partnership tiers
  'diamond',
  'platinum',
  'gold',
] as const;
export type PlanTier = (typeof KNOWN_PLAN_TIERS)[number];

export function derivePlanTier(planId: string): PlanTier | null {
  // Strip the year suffix only (e.g., `diamond-2026` → `diamond`,
  // `start-up-2026` → `start-up`, `thai-alumni-2027` → `thai-alumni`).
  const stripped = planId.toLowerCase().replace(/-\d{4}$/, '');
  return (KNOWN_PLAN_TIERS as readonly string[]).includes(stripped)
    ? (stripped as PlanTier)
    : null;
}

export function makeDrizzleQuotaAccountingAdapter(
  executor: TenantTx,
  // Retained in the signature even though no longer used by the inner
  // body — keeps the di.ts wiring stable + allows future tenant-scoped
  // logic (e.g., tenant-specific fiscal-year-start-month override
  // when MTA onboards a non-SweCham tenant). Underscore-prefixed to
  // satisfy `noUnusedParameters`.
  _ctx: TenantContext,
  registrationsRepo: RegistrationsRepository,
): QuotaAccountingPort {
  return {
    async queryAllotments(
      input: QueryAllotmentsInput,
    ): Promise<
      Result<
        { readonly allotments: PlanAllotments; readonly consumed: ConsumedQuota },
        QuotaAccountingError
      >
    > {
      let allotments: PlanAllotments;
      try {
        // Single SELECT joining members → membership_plans through the
        // tx executor. Constitution v1.4.0 Principle I (NON-NEG) clause 2
        // requires TWO-LAYER tenant isolation — explicit
        // `WHERE tenant_id = ?` at the application layer PLUS Postgres
        // RLS+FORCE at the database layer. The TenantTx executor has
        // `SET LOCAL app.current_tenant` set so RLS scopes the query
        // already; the explicit filter below is defense-in-depth that
        // matches the F2/F3/F4/F5 adapter precedent and would still scope
        // the query if a future regression dropped the runInTenant wrap.
        // The leftJoin condition already includes
        // `membershipPlans.tenantId = members.tenantId` (line below),
        // closing the symmetry on both tables.
        const rows = await executor
          .select({
            planId: members.planId,
            planYear: members.planYear,
            benefitMatrix: membershipPlans.benefitMatrix,
          })
          .from(members)
          .leftJoin(
            membershipPlans,
            and(
              eq(membershipPlans.tenantId, members.tenantId),
              eq(membershipPlans.planId, members.planId),
              eq(membershipPlans.planYear, members.planYear),
            ),
          )
          .where(
            and(
              eq(members.tenantId, input.tenantId),
              eq(members.memberId, input.memberId),
            ),
          )
          .limit(1);
        const row = rows[0];
        if (!row) {
          return err({ kind: 'member_not_found', memberId: input.memberId });
        }
        if (row.benefitMatrix === null) {
          // member.plan_id / plan_year point at a missing
          // membership_plans row — likely the plan was hard-deleted
          // while a member still references it (data drift). Treat
          // as plan_not_found so the caller short-circuits cleanly.
          return err({ kind: 'plan_not_found', memberId: input.memberId });
        }
        const bm: BenefitMatrix = row.benefitMatrix;
        // R6 PERF-05 closure — extract plan tier from the slug-shaped
        // `plan_id` (canonical SweCham 2026 packaging: `diamond`,
        // `platinum`, `gold`, `premium`, `large`, `small`,
        // `standard`). Falls back to null when the plan_id doesn't
        // contain a recognised tier classifier — the counter then
        // labels as `plan_tier='unknown'`. Recognised tiers are the
        // union of the 6 corporate + 3 partnership tiers from
        // `docs/membership-benefits-analysis.md`.
        const planId = String(row.planId).toLowerCase();
        const planTier = derivePlanTier(planId);
        allotments = {
          partnershipPerEvent: bm.partnership?.event_tickets_included ?? 0,
          culturalPerYear: bm.cultural_tickets_per_year,
          planTier,
        };
      } catch (e) {
        return err({
          kind: 'db_error',
          message: `member/plan lookup failed: ${(e as Error)?.message ?? 'unknown'}`,
        });
      }

      // F6 consumed-count reads via the tx-bound registrationsRepo so
      // SUM sees rows already inserted by THIS tx + commits from prior
      // committed txs. Two reads keep the per-event partnership scope
      // disjoint from the per-year cultural scope.
      const partnershipConsumed = await registrationsRepo.countConsumedByMember({
        tenantId: input.tenantId,
        memberId: input.memberId,
        scope: { kind: 'partnership_per_event', eventId: input.eventId },
      });
      if (!partnershipConsumed.ok) {
        return err({
          kind: 'db_error',
          message: `partnership consumed-count failed: ${
            'message' in partnershipConsumed.error
              ? partnershipConsumed.error.message
              : partnershipConsumed.error.kind
          }`,
        });
      }
      const culturalConsumed = await registrationsRepo.countConsumedByMember({
        tenantId: input.tenantId,
        memberId: input.memberId,
        scope: { kind: 'cultural_per_year', fiscalYear: input.fiscalYear },
      });
      if (!culturalConsumed.ok) {
        return err({
          kind: 'db_error',
          message: `cultural consumed-count failed: ${
            'message' in culturalConsumed.error
              ? culturalConsumed.error.message
              : culturalConsumed.error.kind
          }`,
        });
      }

      const consumed: ConsumedQuota = {
        partnershipConsumedForEvent: partnershipConsumed.value,
        culturalConsumedForYear: culturalConsumed.value,
      };

      return ok({ allotments, consumed });
    },
  };
}
