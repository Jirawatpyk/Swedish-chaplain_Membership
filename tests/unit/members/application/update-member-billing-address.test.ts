/**
 * member-billing-address (0284) — the all-or-nothing billing-group
 * invariant, enforced in the use-case BODY (not updateMemberSchema's
 * superRefine).
 *
 * Mirrors update-member-branch-registrant.test.ts's reasoning exactly:
 * updateMemberSchema validates a PARTIAL patch, so any single billing field
 * may arrive alone. A patch that only NULLs `billing_address_line1` looks
 * fine in isolation — but if the member ALREADY carries a full billing
 * group, the resulting row is a partial group, which the DB CHECK
 * `members_billing_address_group_ck` (migration 0284) rejects with a raw
 * constraint-violation 500. Only the RESULTING member state (`current`
 * merged with the patch) can tell, so the rule lives in update-member.ts's
 * use-case body. Rule: fully-NULL group = cleared (OK — the §86/4 buyer
 * block falls back to the company address); ANY field present ⇒ line1 +
 * city + postal_code + country required.
 *
 * Mirrors m1-in-tx-not-found.test.ts's stub pattern: `runInTenant` invokes
 * its callback directly with a dummy tx, and `memberRepo` is a hand-rolled
 * stub — no live DB. The live-Neon proof (CHECK constraint + roundtrip)
 * lives in tests/integration/members/member-billing-address.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ok } from '@/lib/result';

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// runInTenant stub — invoke the callback with a dummy tx, re-throw what it throws.
vi.mock('@/lib/db', () => ({
  runInTenant: vi.fn(async (_ctx: unknown, fn: (tx: unknown) => unknown) =>
    fn({}),
  ),
}));

import {
  updateMember,
  updateMemberSchema,
} from '@/modules/members/application/use-cases/update-member';
import type { UpdateMemberDeps } from '@/modules/members/application/use-cases/update-member';
import { asTenantContext } from '@/modules/tenants';
import { asMemberId, asPlanId } from '@/modules/members/domain/member';

const tenant = asTenantContext('test-tenant');
const memberId = asMemberId('33333333-3333-4333-8333-333333333333');
const meta = { actorUserId: 'actor-uuid', requestId: 'req-billing-address' };

const FULL_BILLING = {
  billingAddressLine1: '9 Tax Rd',
  billingAddressLine2: null,
  billingSubDistrict: null,
  billingCity: 'Bangkok',
  billingProvince: null,
  billingPostalCode: '10500',
  billingCountry: 'TH',
} as const;

function baseMember(overrides: Partial<typeof FULL_BILLING> = {}) {
  return {
    tenantId: tenant.slug as never,
    memberId,
    companyName: 'Acme Ltd',
    legalEntityType: null,
    country: 'TH' as never,
    taxId: null,
    isHeadOffice: true,
    branchCode: null,
    isVatRegistered: false,
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
    // NOTE: billing keys deliberately ABSENT unless overridden — the Member
    // aggregate declares them optional (fixture ergonomics), and the
    // resulting-state check must treat absence exactly like explicit null.
    ...overrides,
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
  const recordInTx = vi.fn().mockResolvedValue(ok(undefined));
  const memberRepo = {
    findByIdInTx: vi.fn().mockResolvedValue(ok(current)),
    updateFieldsInTx,
  } as unknown as UpdateMemberDeps['memberRepo'];
  return {
    deps: {
      tenant,
      memberRepo,
      audit: { record: vi.fn(), recordInTx },
      clock: { now: () => new Date('2026-08-03') },
    } as unknown as UpdateMemberDeps,
    updateFieldsInTx,
    recordInTx,
  };
}

describe('updateMemberSchema — the billing all-or-nothing rule is deliberately ABSENT here', () => {
  // Regression guard mirroring the branch-registrant suite: if a future
  // change "helpfully" moves the invariant into this schema, a legitimate
  // partial patch (e.g. `{ billing_postal_code }` alone on a member whose
  // group is already complete) would start failing at the SCHEMA layer,
  // even though the resulting state is perfectly valid.
  it('a patch that only sets billing_city parses fine at the schema level', () => {
    expect(updateMemberSchema.safeParse({ billing_city: 'Bangkok' }).success).toBe(
      true,
    );
  });
});

describe('updateMember — billing group invariant, checked against the RESULTING state (0284)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('1. adds a complete group in one patch ⇒ allowed; audit carries the billing fields', async () => {
    const current = baseMember();
    const { deps, updateFieldsInTx, recordInTx } = depsFor(current);

    const result = await updateMember(
      memberId,
      {
        billing_address_line1: '9 Tax Rd',
        billing_city: 'Bangkok',
        billing_postal_code: '10500',
        billing_country: 'TH',
      },
      meta,
      deps,
    );

    expect(result.ok).toBe(true);
    expect(updateFieldsInTx).toHaveBeenCalledOnce();
    // buildDiff surfaces the group on the member_updated audit (no new
    // event type) — the fields_changed list must name the billing fields.
    // recordInTx(tx, tenant, event) — event is the 3rd argument.
    const event = recordInTx.mock.calls[0]?.[2] as {
      payload: { fields_changed: string[] };
    };
    expect(event.payload.fields_changed).toEqual(
      expect.arrayContaining([
        'billingAddressLine1',
        'billingCity',
        'billingPostalCode',
        'billingCountry',
      ]),
    );
  });

  it('2. a partial group on a member with none (city only) ⇒ rejected, no write', async () => {
    const current = baseMember();
    const { deps, updateFieldsInTx } = depsFor(current);

    const result = await updateMember(
      memberId,
      { billing_city: 'Bangkok' },
      meta,
      deps,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe('billing_address_incomplete');
    }
    expect(updateFieldsInTx).not.toHaveBeenCalled();
  });

  it('3. NULLing only line1 on a member with a FULL group ⇒ rejected (the innocent-looking one)', async () => {
    const current = baseMember(FULL_BILLING);
    const { deps, updateFieldsInTx } = depsFor(current);

    const result = await updateMember(
      memberId,
      { billing_address_line1: null },
      meta,
      deps,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      // Must be the typed error, never the catch-all `server_error` a raw
      // Postgres CHECK violation would otherwise produce.
      expect(result.error.type).toBe('billing_address_incomplete');
    }
    expect(updateFieldsInTx).not.toHaveBeenCalled();
  });

  it('4. clearing the WHOLE group (all 7 null) ⇒ allowed', async () => {
    const current = baseMember(FULL_BILLING);
    const { deps, updateFieldsInTx } = depsFor(current);

    const result = await updateMember(
      memberId,
      {
        billing_address_line1: null,
        billing_address_line2: null,
        billing_sub_district: null,
        billing_city: null,
        billing_province: null,
        billing_postal_code: null,
        billing_country: null,
      },
      meta,
      deps,
    );

    expect(result.ok).toBe(true);
    expect(updateFieldsInTx).toHaveBeenCalledOnce();
  });

  it('5. a single-field edit inside a complete group ⇒ allowed (resulting state still complete)', async () => {
    const current = baseMember(FULL_BILLING);
    const { deps, updateFieldsInTx } = depsFor(current);

    const result = await updateMember(
      memberId,
      { billing_postal_code: '10110' },
      meta,
      deps,
    );

    expect(result.ok).toBe(true);
    expect(updateFieldsInTx).toHaveBeenCalledOnce();
  });

  it('6. an OPTIONAL field alone on a member with NO group ⇒ rejected (province enables the group)', async () => {
    const current = baseMember();
    const { deps, updateFieldsInTx } = depsFor(current);

    const result = await updateMember(
      memberId,
      { billing_province: 'Bangkok' },
      meta,
      deps,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe('billing_address_incomplete');
    }
    expect(updateFieldsInTx).not.toHaveBeenCalled();
  });

  it('7. an unrelated-field-only patch never trips the gate (even on a legacy-partial row)', async () => {
    // The check is gated on the patch touching a billing key — an edit to
    // an unrelated field must never be blocked by a (theoretically)
    // legacy-violating row.
    const current = baseMember({ billingCity: 'Bangkok' }); // partial (no line1)
    const { deps, updateFieldsInTx } = depsFor(current);

    const result = await updateMember(
      memberId,
      { company_name: 'Renamed Co' },
      meta,
      deps,
    );

    expect(result.ok).toBe(true);
    expect(updateFieldsInTx).toHaveBeenCalledOnce();
  });

  it('8. an invalid billing_country goes through the SAME ISO validator as the company country', async () => {
    const current = baseMember();
    const { deps, updateFieldsInTx } = depsFor(current);

    const result = await updateMember(
      memberId,
      {
        billing_address_line1: '9 Tax Rd',
        billing_city: 'Bangkok',
        billing_postal_code: '10500',
        billing_country: 'ZZ',
      },
      meta,
      deps,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe('invalid_country');
    }
    expect(updateFieldsInTx).not.toHaveBeenCalled();
  });

  it('9. the billing group may carry a DIFFERENT country than the member (SE billing on a TH member)', async () => {
    const current = baseMember();
    const { deps, updateFieldsInTx } = depsFor(current);

    const result = await updateMember(
      memberId,
      {
        billing_address_line1: 'Storgatan 1',
        billing_city: 'Stockholm',
        billing_postal_code: '111 22',
        billing_country: 'SE',
      },
      meta,
      deps,
    );

    expect(result.ok).toBe(true);
    expect(updateFieldsInTx).toHaveBeenCalledOnce();
    const patch = updateFieldsInTx.mock.calls[0]?.[2] as {
      billingCountry: string;
    };
    expect(patch.billingCountry).toBe('SE');
  });
});
