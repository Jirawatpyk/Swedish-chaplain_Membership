/**
 * CM (055-member-number) — createMember member-number wiring unit suite.
 *
 * CM-1 shape-only guard: a `CreateMemberDeps` value carrying a
 * `memberNumberAllocator` port compiles and the use-case accepts it.
 * CM-2 allocation order + handoff: `allocate(tx, tenantId)` runs as the
 * FIRST statement inside the `runInTenant(tx)` lambda, before the INSERT,
 * and threads the allocated number into the member draft.
 * CM-3 audit: a `member_number_assigned` event is recorded (inside the tx)
 * with the allocated number in the payload; an audit failure aborts cleanly.
 *
 * Mocks `@/lib/db` runInTenant to invoke the lambda with `{}` as tx
 * (mirrors w1-tx-rollback.test.ts) — the allocator + repo + audit are
 * mocked so ordering/handoff/audit assertions need no live DB.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ok, err } from '@/lib/result';

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/lib/db', () => ({
  runInTenant: vi.fn(async (_ctx: unknown, fn: (tx: unknown) => unknown) =>
    fn({}),
  ),
}));

import { createMember } from '@/modules/members/application/use-cases/create-member';
import type { CreateMemberDeps } from '@/modules/members/application/use-cases/create-member';
import { asTenantContext } from '@/modules/tenants';
import { asMemberId } from '@/modules/members/domain/member';
import { asContactId } from '@/modules/members/domain/contact';
import { asMemberNumber } from '@/modules/members/domain/value-objects/member-number';

const tenant = asTenantContext('test-tenant');

function makeBaseMember() {
  return {
    tenantId: tenant.slug as never,
    memberId: asMemberId('44444444-4444-4444-8444-444444444444'),
    memberNumber: asMemberNumber(7),
    companyName: 'New Co',
    legalEntityType: null,
    country: 'TH' as never,
    taxId: null,
    website: null,
    description: null,
    foundedYear: null,
    turnoverThb: null,
    planId: 'plan-1' as never,
    planYear: 2026,
    registrationDate: new Date('2026-06-05'),
    registrationFeePaid: false,
    lastActivityAt: null,
    notes: null,
    addressLine1: null,
    addressLine2: null,
    city: null,
    province: null,
    postalCode: null,
    status: 'active' as const,
    archivedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function makeBaseContact() {
  return {
    tenantId: tenant.slug as never,
    contactId: asContactId('55555555-5555-4555-8555-555555555555'),
    memberId: asMemberId('44444444-4444-4444-8444-444444444444'),
    firstName: 'Jane',
    lastName: 'Doe',
    email: 'jane@test.example' as never,
    phone: null,
    roleTitle: null,
    preferredLanguage: 'en' as const,
    isPrimary: true,
    dateOfBirth: null,
    linkedUserId: null,
    removedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function makeDeps(): CreateMemberDeps {
  return {
    tenant,
    memberRepo: {
      findSoftDuplicate: vi.fn().mockResolvedValue(ok(null)),
      createWithPrimaryContactInTx: vi
        .fn()
        .mockResolvedValue(
          ok({ member: makeBaseMember(), contact: makeBaseContact() }),
        ),
    } as unknown as CreateMemberDeps['memberRepo'],
    plans: {
      getPlan: vi.fn().mockResolvedValue(
        ok({
          tenantId: tenant.slug,
          planId: 'plan-1',
          planYear: 2026,
          planCategory: 'corporate',
          memberTypeScope: 'company',
          minTurnoverThb: null,
          maxTurnoverThb: null,
          maxDurationYears: null,
          maxMemberAge: null,
          includesCorporatePlanId: null,
          isSoftDeleted: false,
          annualFeeMinorUnits: 1_000_000,
          isActive: true,
        }),
      ),
    } as unknown as CreateMemberDeps['plans'],
    audit: {
      record: vi.fn(),
      recordInTx: vi.fn().mockResolvedValue(ok(undefined)),
    } as unknown as CreateMemberDeps['audit'],
    clock: { now: () => new Date('2026-06-05') },
    memberNumberAllocator: {
      allocate: vi.fn().mockResolvedValue(asMemberNumber(7)),
    },
    idFactory: {
      memberId: () => asMemberId('44444444-4444-4444-8444-444444444444'),
      contactId: () => asContactId('55555555-5555-4555-8555-555555555555'),
    },
  };
}

const input = {
  company_name: 'New Co',
  country: 'TH',
  plan_id: 'plan-1',
  plan_year: 2026,
  primary_contact: {
    first_name: 'Jane',
    last_name: 'Doe',
    email: 'jane@test.example',
    preferred_language: 'en' as const,
  },
};
const meta = { actorUserId: 'actor-uuid', requestId: 'req-cm1-001' };

describe('CM-1 — createMember accepts memberNumberAllocator dep', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns ok with allocator wired', async () => {
    const deps = makeDeps();
    const result = await createMember(input, meta, deps);
    expect(result.ok).toBe(true);
  });
});

describe('CM-2 — allocate runs first and threads memberNumber into the INSERT', () => {
  beforeEach(() => vi.clearAllMocks());

  it('calls allocate before createWithPrimaryContactInTx and passes the number', async () => {
    const deps = makeDeps();
    const calls: string[] = [];
    (deps.memberNumberAllocator.allocate as ReturnType<typeof vi.fn>).mockImplementation(
      async () => {
        calls.push('allocate');
        return asMemberNumber(7);
      },
    );
    (
      deps.memberRepo.createWithPrimaryContactInTx as ReturnType<typeof vi.fn>
    ).mockImplementation(
      async (_tx: unknown, draft: { member: { memberNumber: unknown } }) => {
        calls.push('insert');
        // handoff: the draft INSERT carries the allocated number
        expect(draft.member.memberNumber).toBe(7);
        return ok({ member: makeBaseMember(), contact: makeBaseContact() });
      },
    );

    const result = await createMember(input, meta, deps);
    expect(result.ok).toBe(true);
    // allocate is the FIRST statement inside the tx lambda
    expect(calls).toEqual(['allocate', 'insert']);
    // allocate received the tenant id (TenantContext.slug)
    expect(deps.memberNumberAllocator.allocate).toHaveBeenCalledWith(
      expect.anything(),
      tenant.slug,
    );
  });
});

describe('CM-3 — createMember emits member_number_assigned audit', () => {
  beforeEach(() => vi.clearAllMocks());

  it('records member_number_assigned with payload.member_number', async () => {
    const deps = makeDeps();
    const result = await createMember(input, meta, deps);
    expect(result.ok).toBe(true);

    const recordInTx = deps.audit.recordInTx as ReturnType<typeof vi.fn>;
    const types = recordInTx.mock.calls.map((c) => c[2].type);
    expect(types).toContain('member_number_assigned');

    const assigned = recordInTx.mock.calls.find(
      (c) => c[2].type === 'member_number_assigned',
    );
    expect(assigned).toBeDefined();
    expect(assigned![2].payload).toMatchObject({
      member_id: '44444444-4444-4444-8444-444444444444',
      member_number: 7,
    });
  });

  it('aborts cleanly when member_number_assigned audit fails (returns err, no swallow)', async () => {
    const deps = makeDeps();
    const recordInTx = deps.audit.recordInTx as ReturnType<typeof vi.fn>;
    // member_created ok, member_number_assigned fails (second call).
    recordInTx
      .mockResolvedValueOnce(ok(undefined))
      .mockResolvedValueOnce(err({ code: 'repo.unexpected' as const }));
    const result = await createMember(input, meta, deps);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.type).toBe('server_error');
  });
});

describe('CM-4 — allocator throw aborts the create cleanly (no orphan member row)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('allocate rejecting → server_error AND createWithPrimaryContactInTx NOT called', async () => {
    const deps = makeDeps();
    // allocate is the FIRST statement inside the runInTenant(tx) lambda. If it
    // rejects, the use-case's outer try/catch maps the non-UseCaseAbort throw to
    // server_error and the tx never reaches the INSERT — so no orphan member row
    // and no half-written audit trail. (Closes CM reviewer Minor.)
    (deps.memberNumberAllocator.allocate as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('allocator: advisory-lock acquisition failed'),
    );

    const result = await createMember(input, meta, deps);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.type).toBe('server_error');
    // Clean abort: the member INSERT was never attempted.
    expect(deps.memberRepo.createWithPrimaryContactInTx).not.toHaveBeenCalled();
    // And no audit row was written (allocate precedes every recordInTx call).
    expect(deps.audit.recordInTx).not.toHaveBeenCalled();
  });
});

describe('CM-5 — createMember persists the override reason on member_created (FR-006a)', () => {
  beforeEach(() => vi.clearAllMocks());

  function memberCreatedPayload(deps: CreateMemberDeps): Record<string, unknown> {
    const recordInTx = deps.audit.recordInTx as ReturnType<typeof vi.fn>;
    const call = recordInTx.mock.calls.find((c) => c[2].type === 'member_created');
    expect(call).toBeDefined();
    return call![2].payload as Record<string, unknown>;
  }

  it('member_created payload carries override_reason_code + note when an override is asserted', async () => {
    const deps = makeDeps();
    const result = await createMember(
      {
        ...input,
        override_reason_code: 'data_correction',
        override_reason_note: 'below plan band; approved by finance',
      },
      meta,
      deps,
    );
    expect(result.ok).toBe(true);
    expect(memberCreatedPayload(deps)).toMatchObject({
      override_reason_code: 'data_correction',
      override_reason_note: 'below plan band; approved by finance',
    });
  });

  it('member_created payload omits the override fields when no override is asserted', async () => {
    const deps = makeDeps();
    const result = await createMember(input, meta, deps);
    expect(result.ok).toBe(true);
    const payload = memberCreatedPayload(deps);
    expect(payload).not.toHaveProperty('override_reason_code');
    expect(payload).not.toHaveProperty('override_reason_note');
  });
});
