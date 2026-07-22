/**
 * Plan-change -> billing remediation (Package A) — shared seed helper.
 *
 * THE FIX: the next renewal cycle must be seeded from the member's LIVE plan
 * (`members.plan_id`), NOT the just-completed cycle's frozen plan. Both
 * steady-state seed seams delegate here so the logic (and its cohort-E
 * fallback) lives in ONE place:
 *   - `create-next-cycle-on-paid.ts` (the LINKED F4-invoice rail), and
 *   - `resolve-unlinked-membership-payment.ts` `renewalComplete` (the
 *     UNLINKED ad-hoc-invoice rail).
 *
 * COHORT E (mandatory): the member's live plan may have no catalogue row
 * resolvable for the next cycle's fiscal year (e.g. an archived plan). Naively
 * seeding from it would make `createCycleInTx` throw `PlanNotResolvableError`,
 * which on the on-paid rails rolls back F4's payment tx — turning a silent
 * pricing bug into a Stripe-retry storm. So on that specific throw we FALL
 * BACK to the prior cycle's plan (guaranteed billable — the prior cycle was
 * created from it) and emit a forensic
 * `member_plan_change_billing_effect(seed_fallback_plan_unresolvable)` audit,
 * WITHOUT rolling back the payment.
 *
 * A GENUINE failure (any error other than the LIVE plan being unresolvable —
 * including the PRIOR plan itself being unresolvable, a pre-existing catalogue
 * gap) still propagates, preserving each caller's existing rollback posture.
 *
 * Fiscal-year derivation, the frozen-price freeze, and the
 * `renewal_cycle_created` audit are all delegated to `createCycleInTx` — this
 * helper never hand-rolls fiscal-year math. The production plan-lookup adapter
 * opens its OWN connection, so `PlanNotResolvableError` is a pure JS throw on a
 * clean read that leaves the caller's tx pristine — the fallback
 * `createCycleInTx` call runs safely in the same tx.
 *
 * Pure Application — port interfaces only (Constitution Principle III).
 */
import type { TenantTx } from '@/lib/db';
import type { MemberPlanLookupPort } from '../../ports/member-plan-lookup-port';
import type { PlanChangeBillingEffectAuditPort } from '../../ports/plan-change-billing-effect-audit-port';
import type { RenewalActorRole } from '../../ports/renewal-audit-emitter';
import {
  createCycleInTx,
  PlanNotResolvableError,
  type CreateCycleInTxDeps,
} from '../create-cycle-in-tx';

export type SeedNextCycleFromMemberPlanDeps = CreateCycleInTxDeps & {
  /** Resolves the member's CURRENT `plan_id` inside the caller's tx. */
  readonly memberPlanLookup: MemberPlanLookupPort;
  /** Emits the cohort-E `seed_fallback_plan_unresolvable` audit. */
  readonly planChangeBillingEffectAudit: PlanChangeBillingEffectAuditPort;
};

export interface SeedNextCycleFromMemberPlanInput {
  readonly tenantId: string;
  readonly memberId: string;
  /** Gapless anchor = the just-completed cycle's `periodTo`. */
  readonly periodFrom: string;
  /** The just-completed cycle's plan — the guaranteed-billable fallback. */
  readonly priorPlanId: string;
  readonly actorUserId: string | null;
  readonly actorRole: RenewalActorRole;
  readonly correlationId: string;
}

export async function seedNextCycleFromMemberPlanInTx(
  deps: SeedNextCycleFromMemberPlanDeps,
  tx: TenantTx,
  input: SeedNextCycleFromMemberPlanInput,
): Promise<void> {
  // Resolve the member's LIVE plan (the whole point of the fix). `null`
  // (member absent / cross-tenant — RLS filters both) degrades to the prior
  // plan, i.e. the pre-fix behaviour, rather than inventing a plan.
  const member = await deps.memberPlanLookup.loadMemberPlanInTx(
    tx,
    input.tenantId,
    input.memberId,
  );
  const livePlanId = member?.planId ?? input.priorPlanId;

  const baseInput = {
    tenantId: input.tenantId,
    memberId: input.memberId,
    periodFrom: input.periodFrom,
    actorUserId: input.actorUserId,
    actorRole: input.actorRole,
    correlationId: input.correlationId,
  };

  // No divergence (or member unresolvable) — original behaviour verbatim. A
  // PlanNotResolvableError here is a pre-existing catalogue gap on the prior
  // plan and propagates (rolls back), exactly as before the fix.
  if (livePlanId === input.priorPlanId) {
    await createCycleInTx(deps, tx, {
      ...baseInput,
      planId: input.priorPlanId,
    });
    return;
  }

  // Divergence: seed from the member's LIVE plan. On a catalogue gap for the
  // live plan (cohort E) fall back to the prior plan + emit the forensic
  // audit; the payment MUST NOT roll back. Any OTHER error propagates.
  try {
    await createCycleInTx(deps, tx, { ...baseInput, planId: livePlanId });
  } catch (e) {
    if (!(e instanceof PlanNotResolvableError)) {
      throw e;
    }
    // Cohort E — the live plan does not resolve for the next cycle's fiscal
    // year. The prior plan is guaranteed billable (the prior cycle was created
    // from it); a PlanNotResolvableError HERE is a genuine pre-existing gap and
    // propagates (preserving the caller's rollback posture for real failures).
    const outcome = await createCycleInTx(deps, tx, {
      ...baseInput,
      planId: input.priorPlanId,
    });
    const cycleId = outcome.kind === 'created' ? outcome.cycle.cycleId : null;
    await deps.planChangeBillingEffectAudit.emitInTx(
      tx,
      {
        tenantId: input.tenantId,
        actorUserId: input.actorUserId,
        correlationId: input.correlationId,
      },
      {
        memberId: input.memberId,
        oldPlanId: input.priorPlanId,
        newPlanId: livePlanId,
        cycleId,
        effect: 'seed_fallback_plan_unresolvable',
        oldPriceThb: null,
        newPriceThb: null,
        effectiveFrom: input.periodFrom,
        blockingInvoiceId: null,
        blockingSource: null,
      },
    );
  }
}
