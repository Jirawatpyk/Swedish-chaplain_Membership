/**
 * 065 §5.1 — billing_cycle round-trips through updateMember.
 *
 * `billing_cycle` is OPTIONAL on the update schema (mirrors is_vat_registered):
 * absent from a partial patch means unchanged; when present, the use case must
 * thread it into the patch handed to `updateFieldsInTx` (drizzle field
 * `billingCycle`). Mirrors update-member-vat-registrant.test.ts's stub pattern:
 * `runInTenant` invokes its callback directly with a dummy tx and `memberRepo`
 * is a hand-rolled stub — no live DB.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ok } from '@/lib/result';

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('@/lib/db', () => ({
  runInTenant: vi.fn(async (_ctx: unknown, fn: (tx: unknown) => unknown) => fn({})),
}));

import {
  updateMember,
  updateMemberSchema,
} from '@/modules/members/application/use-cases/update-member';
import type { UpdateMemberDeps } from '@/modules/members/application/use-cases/update-member';
import type { BillingCycle } from '@/modules/members/domain/member';
import { asTenantContext } from '@/modules/tenants';
import { asMemberId, asPlanId } from '@/modules/members/domain/member';

const tenant = asTenantContext('test-tenant');
const memberId = asMemberId('11111111-1111-4111-8111-111111111111');
const meta = { actorUserId: 'actor-uuid', requestId: 'req-billing-cycle' };

function baseMember(billingCycle: BillingCycle) {
  return {
    tenantId: tenant.slug as never,
    memberId,
    companyName: 'Acme Ltd',
    legalEntityType: null,
    country: 'TH' as never,
    taxId: null,
    isVatRegistered: false,
    billingCycle,
    website: null,
    description: null,
    foundedYear: 2020,
    turnoverThb: null,
    registeredCapitalThb: null,
    planId: asPlanId('plan-1'),
    planYear: 2026,
    registrationDate: new Date('2026-01-01'),
    registrationFeePaid: true,
    lastActivityAt: null,
    notes: null,
    addressLine1: null,
    addressLine2: null,
    city: null,
    province: null,
    postalCode: null,
    subDistrict: null,
    status: 'active' as const,
    archivedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function depsFor(current: ReturnType<typeof baseMember>) {
  const updateFieldsInTx = vi
    .fn()
    .mockImplementation((_tx: unknown, _id: unknown, patch: object) =>
      Promise.resolve(ok({ ...current, ...patch })),
    );
  const memberRepo = {
    findByIdInTx: vi.fn().mockResolvedValue(ok(current)),
    updateFieldsInTx,
  } as unknown as UpdateMemberDeps['memberRepo'];
  return {
    deps: {
      tenant,
      memberRepo,
      audit: {
        record: vi.fn(),
        recordInTx: vi.fn().mockResolvedValue(ok(undefined)),
      },
      clock: { now: () => new Date('2026-07-16') },
    } as unknown as UpdateMemberDeps,
    updateFieldsInTx,
  };
}

describe('updateMemberSchema — billing_cycle is OPTIONAL (065 §5.1)', () => {
  it('accepts a patch that only sets billing_cycle', () => {
    expect(updateMemberSchema.safeParse({ billing_cycle: 'calendar' }).success).toBe(true);
  });

  it('accepts a patch that omits billing_cycle entirely', () => {
    expect(updateMemberSchema.safeParse({ company_name: 'X' }).success).toBe(true);
  });

  it('rejects an unknown billing_cycle value', () => {
    expect(updateMemberSchema.safeParse({ billing_cycle: 'quarterly' }).success).toBe(false);
  });
});

describe('updateMember — billing_cycle round-trips into the patch (065 §5.1)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('threads a changed billing_cycle into updateFieldsInTx as billingCycle', async () => {
    const current = baseMember('rolling');
    const { deps, updateFieldsInTx } = depsFor(current);

    const result = await updateMember(memberId, { billing_cycle: 'calendar' }, meta, deps);

    expect(result.ok).toBe(true);
    expect(updateFieldsInTx).toHaveBeenCalledOnce();
    const patch = updateFieldsInTx.mock.calls[0]![2] as { billingCycle?: BillingCycle };
    expect(patch.billingCycle).toBe('calendar');
    if (result.ok) expect(result.value.billingCycle).toBe('calendar');
  });

  it('is a no-op (no write) when billing_cycle is unchanged', async () => {
    const current = baseMember('calendar');
    const { deps, updateFieldsInTx } = depsFor(current);

    const result = await updateMember(memberId, { billing_cycle: 'calendar' }, meta, deps);

    // Same value ⇒ buildDiff finds no change ⇒ no audit + no write.
    expect(result.ok).toBe(true);
    expect(updateFieldsInTx).not.toHaveBeenCalled();
  });
});
