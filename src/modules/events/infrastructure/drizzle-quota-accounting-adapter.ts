/**
 * T086 — Drizzle adapter for `QuotaAccountingPort` (F6 Infrastructure).
 *
 * Bridges the F6 Domain port to:
 *   1. F3 `members` table — reads the matched member's current
 *      `plan_id` + `plan_year` snapshot (the read happens via the
 *      tx-bound executor so it shares the strict-tx connection that
 *      holds the F6 advisory lock).
 *   2. F2 plans barrel — `buildPlansDeps(ctx).planRepo.findOne(...)`
 *      loads the full `Plan` (including `benefit_matrix` JSONB) for
 *      the member's plan snapshot. This call opens its own connection
 *      from the Drizzle pool — that's fine because plan data is
 *      effectively static during the brief ingest window and the
 *      advisory lock coordinates on (tenant, member, event) registration
 *      writes, NOT on plan reads.
 *   3. F6 `event_registrations` (via the existing
 *      `RegistrationsRepository.countConsumedByMember` port method
 *      which is implemented in the tx-bound registrations adapter) —
 *      computes the consumed-quota count under the same lock so the
 *      "decide-then-write" sequence has no race window.
 *
 * Per research.md R5 the lock is acquired at the USE-CASE layer
 * (`apply-quota-effect.ts`), not inside this adapter — keeps the port
 * surface a pure read query.
 *
 * Spec authority:
 *   - FR-015 / FR-016 (partnership-per-event + cultural-per-year quotas)
 *   - research.md R5 (compute-on-read + per-tenant adv lock)
 *   - data-model.md § 8 (no stored counter; SUM is canonical)
 */
import { eq } from 'drizzle-orm';
import { ok, err, type Result } from '@/lib/result';
import type { TenantTx } from '@/lib/db';
import type { TenantContext } from '@/modules/tenants';
import { asPlanSlug, asPlanYear } from '@/modules/plans';
import { buildPlansDeps } from '@/modules/plans/plans-deps';
import { members } from '@/modules/members/infrastructure/db/schema-members';
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
  ctx: TenantContext,
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
      // 1. F3 member → plan snapshot (tx-bound so it shares the lock's
      // connection and the RLS tenant-context binding).
      let planSnapshot: { planId: string; planYear: number };
      try {
        const memberRows = await executor
          .select({ planId: members.planId, planYear: members.planYear })
          .from(members)
          .where(eq(members.memberId, input.memberId))
          .limit(1);
        const row = memberRows[0];
        if (!row) {
          return err({ kind: 'member_not_found', memberId: input.memberId });
        }
        planSnapshot = { planId: row.planId, planYear: row.planYear };
      } catch (e) {
        return err({
          kind: 'db_error',
          message: `member lookup failed: ${(e as Error)?.message ?? 'unknown'}`,
        });
      }

      // 2. F2 plan repo (separate connection — see file header for why
      // this is safe).
      let allotments: PlanAllotments;
      try {
        const plansDeps = buildPlansDeps(ctx);
        const plan = await plansDeps.planRepo.findOne(
          ctx,
          asPlanSlug(planSnapshot.planId),
          asPlanYear(planSnapshot.planYear),
        );
        if (!plan) {
          return err({ kind: 'plan_not_found', memberId: input.memberId });
        }
        allotments = {
          partnershipPerEvent:
            plan.benefit_matrix.partnership?.event_tickets_included ?? 0,
          culturalPerYear: plan.benefit_matrix.cultural_tickets_per_year,
        };
      } catch (e) {
        return err({
          kind: 'db_error',
          message: `plan lookup failed: ${(e as Error)?.message ?? 'unknown'}`,
        });
      }

      // 3. F6 consumed-count reads (tx-bound — uses the SAME lock window
      // so concurrent writers under the same lock-key cannot interleave).
      // Issued as two reads so the per-event scope + per-year scope are
      // independent (FR-015 / FR-016 model them as two separate buckets).
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
