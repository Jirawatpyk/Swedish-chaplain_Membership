/**
 * 126 — `validatePlanChange`, the plan-change policy core shared by the
 * single `changePlan` and the bulk `change_plan` arm.
 *
 * Before 126 the rules lived inline in `changePlan` and the bulk arm had none
 * of them; `changePlan` itself also skipped the archived, age and member-type
 * rules and only asked for bundle confirmation when the NEW plan was a
 * partnership.
 */
import { describe, expect, it } from 'vitest';
import { validatePlanChange } from '@/modules/members/application/use-cases/plan-change-core';
import type { PlanSummary } from '@/modules/members/application/ports/plan-lookup-port';
import { asPlanId, type Member, type TenantId } from '@/modules/members/domain/member';

const NOW = new Date('2026-10-24T00:00:00Z');

function plan(overrides: Partial<PlanSummary> = {}): PlanSummary {
  return {
    tenantId: 'test-tenant' as TenantId,
    planId: asPlanId('corporate-large'),
    planYear: 2026,
    planNameEn: 'Corporate Large',
    planCategory: 'corporate',
    memberTypeScope: 'company',
    minTurnoverThb: null,
    maxTurnoverThb: null,
    maxDurationYears: null,
    maxMemberAge: null,
    includesCorporatePlanId: null,
    isSoftDeleted: false,
    ...overrides,
  };
}

type PolicyMember = Pick<
  Member,
  'status' | 'turnoverThb' | 'foundedYear' | 'registrationDate' | 'legalEntityType'
>;

function member(overrides: Partial<PolicyMember> = {}): PolicyMember {
  return {
    status: 'active',
    turnoverThb: null,
    foundedYear: null,
    registrationDate: new Date('2020-01-01T00:00:00Z'),
    legalEntityType: 'limited_company',
    ...overrides,
  };
}

function run(args: {
  member?: PolicyMember;
  oldPlan?: PlanSummary | null;
  newPlan?: PlanSummary;
  confirmBundleChange?: boolean;
  overrideAsserted?: boolean;
  primaryDateOfBirth?: Date | null;
}) {
  return validatePlanChange({
    member: args.member ?? member(),
    oldPlan: args.oldPlan === undefined ? plan({ planId: asPlanId('corporate-small') }) : args.oldPlan,
    newPlan: args.newPlan ?? plan(),
    confirmBundleChange: args.confirmBundleChange ?? false,
    overrideAsserted: args.overrideAsserted ?? false,
    primaryDateOfBirth: args.primaryDateOfBirth ?? null,
    now: NOW,
  });
}

describe('validatePlanChange (126)', () => {
  it('passes a plain corporate → corporate move', () => {
    const r = run({});
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.bundleChanged).toBe(false);
  });

  it('refuses a soft-deleted target plan as plan_not_found', () => {
    const r = run({ newPlan: plan({ isSoftDeleted: true }) });
    expect(r).toEqual({ ok: false, error: { type: 'plan_not_found' } });
  });

  it('refuses an archived member (#4)', () => {
    const r = run({ member: member({ status: 'archived' }) });
    expect(r).toEqual({ ok: false, error: { type: 'member_archived' } });
  });

  it('asks for confirmation when a partnership member moves to a plan with no bundle (#9)', () => {
    const r = run({
      oldPlan: plan({
        planId: asPlanId('partnership-gold'),
        planCategory: 'partnership',
        includesCorporatePlanId: asPlanId('corporate-large'),
      }),
      newPlan: plan(),
    });
    expect(r).toEqual({
      ok: false,
      error: {
        type: 'bundle_change_requires_confirmation',
        oldBundleCorporatePlanId: 'corporate-large',
        newBundleCorporatePlanId: null,
      },
    });
  });

  it('reports bundleChanged once the partnership → corporate move is confirmed', () => {
    const r = run({
      oldPlan: plan({
        planId: asPlanId('partnership-gold'),
        planCategory: 'partnership',
        includesCorporatePlanId: asPlanId('corporate-large'),
      }),
      confirmBundleChange: true,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.bundleChanged).toBe(true);
  });

  it('refuses a turnover outside the new band unless an override is asserted', () => {
    const newPlan = plan({ minTurnoverThb: 1_000_000, maxTurnoverThb: 5_000_000 });
    const m = member({ turnoverThb: 50_000_000 });
    const refused = run({ member: m, newPlan });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.type).toBe('turnover_out_of_band');
    expect(run({ member: m, newPlan, overrideAsserted: true }).ok).toBe(true);
  });

  it('refuses a primary contact older than the plan max age (#5)', () => {
    const r = run({
      newPlan: plan({ maxMemberAge: 35 }),
      primaryDateOfBirth: new Date('1980-01-01T00:00:00Z'),
    });
    expect(r).toEqual({
      ok: false,
      error: { type: 'age_not_eligible', ageYears: 46, maxAge: 35 },
    });
  });

  it('lets an override bypass the age rule, and skips it with no date of birth', () => {
    const newPlan = plan({ maxMemberAge: 35 });
    const dob = new Date('1980-01-01T00:00:00Z');
    expect(run({ newPlan, primaryDateOfBirth: dob, overrideAsserted: true }).ok).toBe(true);
    expect(run({ newPlan, primaryDateOfBirth: null }).ok).toBe(true);
  });

  it('refuses an individual member on a company-only plan (#5)', () => {
    const r = run({ member: member({ legalEntityType: 'individual' }) });
    expect(r).toEqual({
      ok: false,
      error: {
        type: 'member_type_out_of_scope',
        legalEntityType: 'individual',
        memberTypeScope: 'company',
      },
    });
  });

  it('refuses a company on an individual-only plan', () => {
    const r = run({ newPlan: plan({ memberTypeScope: 'individual' }) });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.type).toBe('member_type_out_of_scope');
  });

  it('passes a null legal entity type, a "both" plan, and an override', () => {
    expect(run({ member: member({ legalEntityType: null }) }).ok).toBe(true);
    expect(
      run({
        member: member({ legalEntityType: 'individual' }),
        newPlan: plan({ memberTypeScope: 'both' }),
      }).ok,
    ).toBe(true);
    expect(
      run({ member: member({ legalEntityType: 'individual' }), overrideAsserted: true }).ok,
    ).toBe(true);
  });
});
