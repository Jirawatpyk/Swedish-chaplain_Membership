/**
 * 063 (Option A) — `changePlan` runs F8 manual-plan-change listeners
 * POST-COMMIT in isolation (unit; stubbed deps + stubbed `runInTenant`).
 *
 * Pins the use-case-level contract that the in-tx → post-commit move
 * established:
 *
 *   1. Listeners receive the event ONLY (no `tx` arg) — the new
 *      `ManualPlanChangeListener` signature.
 *   2. A listener that THROWS does NOT fail the use-case — `changePlan`
 *      still returns `ok` (the plan-flip already committed). The old
 *      code re-threw inside the tx → `server_error`.
 *   3. Listeners run AFTER the tx writes (plan-flip + audits) — the
 *      stubbed `runInTenant` resolves before any listener is invoked.
 *   4. The event carries `oldPlanId` = the plan id read under the in-tx
 *      FOR UPDATE lock (`findByIdInTx`), and `newPlanId` = the request.
 *
 * Mirrors the dep-stub pattern from `m1-in-tx-not-found.test.ts`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ok } from '@/lib/result';

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// runInTenant stub — invoke the callback with a dummy tx, re-throw what
// it throws. The post-commit listener loop runs AFTER this resolves.
vi.mock('@/lib/db', () => ({
  runInTenant: vi.fn(async (_ctx: unknown, fn: (tx: unknown) => unknown) =>
    fn({}),
  ),
}));

import { changePlan } from '@/modules/members/application/use-cases/change-plan';
import type { ChangePlanDeps } from '@/modules/members/application/use-cases/change-plan';
import type { ManualPlanChangeListener } from '@/modules/renewals';
import { asTenantContext } from '@/modules/tenants';
import { asMemberId, asPlanId } from '@/modules/members/domain/member';

const tenant = asTenantContext('test-tenant');
const memberId = asMemberId('11111111-1111-4111-8111-111111111111');
const meta = { actorUserId: 'actor-uuid', requestId: 'req-pc' };

function baseMember(planId: string) {
  return {
    tenantId: tenant.slug as never,
    memberId,
    companyName: 'Acme Ltd',
    legalEntityType: null,
    country: 'TH' as never,
    taxId: null,
    website: null,
    description: null,
    foundedYear: 2020,
    turnoverThb: null,
    planId: asPlanId(planId),
    planYear: 2026,
    registrationDate: new Date('2026-01-01'),
    registrationFeePaid: true,
    lastActivityAt: null,
    notes: null,
    status: 'active' as const,
    archivedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

const corporatePlan = {
  tenantId: tenant.slug,
  planId: 'plan-new',
  planYear: 2026,
  planCategory: 'corporate' as const,
  memberTypeScope: 'company' as const,
  minTurnoverThb: null,
  maxTurnoverThb: null,
  maxDurationYears: null,
  includesCorporatePlanId: null,
  isSoftDeleted: false,
  annualFeeMinorUnits: 1_000_000,
  isActive: true,
};

function buildDeps(
  listeners: ReadonlyArray<ManualPlanChangeListener>,
  ordering: string[],
): ChangePlanDeps {
  return {
    tenant,
    memberRepo: {
      // pre-tx validation read — member on 'plan-old', so the no-op
      // short-circuit is skipped.
      findById: vi.fn().mockResolvedValue(ok(baseMember('plan-old'))),
      // in-tx locked re-read — old plan id provenance for the event.
      findByIdInTx: vi.fn().mockResolvedValue(ok(baseMember('plan-old'))),
      updateFieldsInTx: vi.fn(async () => {
        ordering.push('updateFieldsInTx');
        return ok(baseMember('plan-new'));
      }),
    } as unknown as ChangePlanDeps['memberRepo'],
    plans: {
      getPlan: vi.fn().mockResolvedValue(ok(corporatePlan)),
    } as unknown as ChangePlanDeps['plans'],
    audit: {
      record: vi.fn(),
      recordInTx: vi.fn(async () => {
        ordering.push('recordInTx');
        return ok(undefined);
      }),
    },
    planAdvisoryLock: {
      acquire: vi.fn().mockResolvedValue(undefined),
      isPlanSoftDeletedInTx: vi.fn().mockResolvedValue(false),
    },
    manualPlanChangeListeners: listeners,
  } as unknown as ChangePlanDeps;
}

describe('063 — changePlan runs manual-plan-change listeners post-commit (unit)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('a throwing listener does NOT fail the use-case — returns ok (plan-flip already committed)', async () => {
    const ordering: string[] = [];
    let invokedWith: { oldPlanId: string; newPlanId: string; argc: number } | null =
      null;
    const throwing: ManualPlanChangeListener = async (...args) => {
      ordering.push('listener');
      const [evt] = args;
      invokedWith = {
        oldPlanId: evt.oldPlanId,
        newPlanId: evt.newPlanId,
        argc: args.length,
      };
      throw new Error('synthetic_post_commit_listener_throw');
    };

    const result = await changePlan(
      memberId,
      { new_plan_id: 'plan-new', new_plan_year: 2026 },
      meta,
      buildDeps([throwing], ordering),
    );

    // (2) use-case returns ok despite the listener throw.
    expect(result.ok).toBe(true);

    // (3) ordering: the tx writes (updateFieldsInTx + the two audit
    // recordInTx) all precede the listener invocation.
    expect(ordering[ordering.length - 1]).toBe('listener');
    expect(ordering.indexOf('updateFieldsInTx')).toBeLessThan(
      ordering.indexOf('listener'),
    );
    expect(ordering.indexOf('recordInTx')).toBeLessThan(
      ordering.indexOf('listener'),
    );

    // (1) + (4) listener received the event ONLY (1 arg) carrying the
    // locked old plan + requested new plan.
    expect(invokedWith).not.toBeNull();
    expect(invokedWith!.argc).toBe(1);
    expect(invokedWith!.oldPlanId).toBe('plan-old');
    expect(invokedWith!.newPlanId).toBe('plan-new');
  });

  it('a succeeding listener runs post-commit and the use-case returns ok', async () => {
    const ordering: string[] = [];
    const seen: Array<{ oldPlanId: string; newPlanId: string }> = [];
    const okListener: ManualPlanChangeListener = async (evt) => {
      ordering.push('listener');
      seen.push({ oldPlanId: evt.oldPlanId, newPlanId: evt.newPlanId });
    };

    const result = await changePlan(
      memberId,
      { new_plan_id: 'plan-new', new_plan_year: 2026 },
      meta,
      buildDeps([okListener, okListener], ordering),
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.planId as string).toBe('plan-new');
    // Both listeners ran, after the tx writes.
    expect(seen).toHaveLength(2);
    expect(ordering.filter((s) => s === 'listener')).toHaveLength(2);
    expect(ordering.indexOf('updateFieldsInTx')).toBeLessThan(
      ordering.indexOf('listener'),
    );
    for (const s of seen) {
      expect(s.oldPlanId).toBe('plan-old');
      expect(s.newPlanId).toBe('plan-new');
    }
  });
});
