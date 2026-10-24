/**
 * Plan-change policy core (126) — the rules a member must pass to move onto
 * a new plan. Shared by `changePlan`; `createMember` runs the same domain
 * policies for a member's first plan.
 *
 * Order matters only for which refusal the caller sees first:
 *   1. a soft-deleted target plan            → plan_not_found
 *   2. an archived member (#4)               → member_archived
 *   3. a bundle change, either direction (#9) → bundle_change_requires_confirmation
 *   4. turnover band, startup age, primary-contact age (#5), member type (#5)
 *      — each bypassable by an override reason (FR-006a).
 *
 * Pure — no I/O. The caller supplies the plans, the primary contact's date
 * of birth and the clock.
 */
import { err, ok, type Result } from '@/lib/result';
import { checkAgeEligibility } from '../../domain/policies/age-eligibility-policy';
import { checkMemberTypeScope } from '../../domain/policies/member-type-scope-policy';
import { checkStartupDuration } from '../../domain/policies/startup-duration-policy';
import { checkTurnoverBand } from '../../domain/policies/turnover-policy';
import type { LegalEntityTypeCode } from '../../domain/value-objects/legal-entity-type';
import type { Member } from '../../domain/member';
import type { PlanSummary } from '../ports/plan-lookup-port';

export type PlanChangeRefusal =
  | { type: 'plan_not_found' }
  | { type: 'member_archived' }
  | {
      type: 'bundle_change_requires_confirmation';
      oldBundleCorporatePlanId: string | null;
      newBundleCorporatePlanId: string | null;
    }
  | {
      type: 'turnover_out_of_band';
      turnoverThb: number;
      band: { minThb: number | null; maxThb: number | null };
    }
  | { type: 'startup_too_old'; foundedYear: number; maxAllowedYears: number }
  | { type: 'age_not_eligible'; ageYears: number; maxAge: number }
  | {
      type: 'member_type_out_of_scope';
      legalEntityType: LegalEntityTypeCode;
      memberTypeScope: 'company' | 'individual' | 'both';
    };

export type PlanChangeCheck = {
  bundleChanged: boolean;
  oldBundle: string | null;
  newBundle: string | null;
};

export function validatePlanChange(input: {
  member: Pick<
    Member,
    'status' | 'turnoverThb' | 'foundedYear' | 'registrationDate' | 'legalEntityType'
  >;
  oldPlan: PlanSummary | null;
  newPlan: PlanSummary;
  confirmBundleChange: boolean;
  overrideAsserted: boolean;
  primaryDateOfBirth: Date | null;
  now: Date;
}): Result<PlanChangeCheck, PlanChangeRefusal> {
  const { member, oldPlan, newPlan, overrideAsserted } = input;

  if (newPlan.isSoftDeleted) return err({ type: 'plan_not_found' });
  if (member.status === 'archived') return err({ type: 'member_archived' });

  // FR-010 — a bundle change in EITHER direction: entering a partnership,
  // leaving one, or switching the bundled corporate tier (#9).
  const oldBundle = oldPlan?.includesCorporatePlanId ?? null;
  const newBundle = newPlan.includesCorporatePlanId;
  const bundleChanged =
    oldBundle !== newBundle &&
    (newPlan.planCategory === 'partnership' || oldPlan?.planCategory === 'partnership');
  if (bundleChanged && !input.confirmBundleChange) {
    return err({
      type: 'bundle_change_requires_confirmation',
      oldBundleCorporatePlanId: oldBundle,
      newBundleCorporatePlanId: newBundle,
    });
  }

  if (!overrideAsserted) {
    const turnover = checkTurnoverBand(member.turnoverThb, {
      minThb: newPlan.minTurnoverThb,
      maxThb: newPlan.maxTurnoverThb,
    });
    if (!turnover.ok) {
      return err({
        type: 'turnover_out_of_band',
        turnoverThb: turnover.error.turnoverThb,
        band: turnover.error.band,
      });
    }

    if (newPlan.maxDurationYears !== null && member.foundedYear !== null) {
      const startup = checkStartupDuration(
        member.foundedYear,
        member.registrationDate,
        newPlan.maxDurationYears,
      );
      if (!startup.ok) {
        return err({
          type: 'startup_too_old',
          foundedYear: startup.error.foundedYear,
          maxAllowedYears: startup.error.maxAllowedYears,
        });
      }
    }

    if (newPlan.maxMemberAge !== null && input.primaryDateOfBirth !== null) {
      const age = checkAgeEligibility(input.primaryDateOfBirth, input.now, newPlan.maxMemberAge);
      if (!age.ok) {
        return err({ type: 'age_not_eligible', ageYears: age.error.ageYears, maxAge: age.error.maxAge });
      }
    }

    const scope = checkMemberTypeScope(member.legalEntityType, newPlan.memberTypeScope);
    if (!scope.ok) {
      return err({
        type: 'member_type_out_of_scope',
        legalEntityType: scope.error.legalEntityType,
        memberTypeScope: scope.error.memberTypeScope,
      });
    }
  }

  return ok({ bundleChanged, oldBundle, newBundle });
}
