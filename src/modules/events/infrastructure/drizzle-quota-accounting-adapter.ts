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
        // tx executor. Both rows live in the SAME tenant (composite FK
        // constraint at the migration layer; RLS additionally enforces
        // tenant scope). Returns the BenefitMatrix JSONB column,
        // typed via Drizzle's $type<BenefitMatrix>() on the schema
        // column declaration.
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
          .where(eq(members.memberId, input.memberId))
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
        allotments = {
          partnershipPerEvent: bm.partnership?.event_tickets_included ?? 0,
          culturalPerYear: bm.cultural_tickets_per_year,
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
