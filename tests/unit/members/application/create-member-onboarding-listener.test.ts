/**
 * F8-completion Slice 1 · Task 1.6 — createMember onboarding listener
 * (post-launch new-member arm).
 *
 * `createMember` gains an OPTIONAL `onboardingListeners` array invoked
 * POST-COMMIT — AFTER the create tx (member + contact + audit rows) has
 * committed durably. This is the ONLY swallow site in the whole
 * F8-completion effort: there is no tx to roll back and no webhook retry
 * to heal it, so a listener failure must NEVER fail the already-committed
 * create. The use-case logs + bumps a counter + returns `ok`.
 *
 * Mirrors `change-plan.ts:manualPlanChangeListeners` exactly (post-commit,
 * per-listener try/catch, never fails the use-case) — see
 * `change-plan-post-commit-listeners.test.ts` for the integration twin.
 *
 * Harness mirrors `create-member-number-wiring.test.ts`: mocks
 * `@/lib/db` runInTenant (lambda invoked with `{}` as tx) + `@/lib/logger`
 * + `@/lib/metrics` (so the counter increment is observable). No live DB.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ok } from '@/lib/result';

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/lib/db', () => ({
  runInTenant: vi.fn(async (_ctx: unknown, fn: (tx: unknown) => unknown) =>
    fn({}),
  ),
}));
const bootstrapCycleCreateFailedAdd = vi.fn();
vi.mock('@/lib/metrics', () => ({
  renewalsMetrics: {
    bootstrapCycleCreateFailed: {
      add: (...args: unknown[]) => bootstrapCycleCreateFailedAdd(...args),
    },
  },
}));

import { createMember } from '@/modules/members/application/use-cases/create-member';
import type {
  CreateMemberDeps,
  CreateMemberListenerEvent,
} from '@/modules/members/application/use-cases/create-member';
import { asTenantContext } from '@/modules/tenants';
import { asMemberId } from '@/modules/members/domain/member';
import { asContactId } from '@/modules/members/domain/contact';
import { asMemberNumber } from '@/modules/members/domain/value-objects/member-number';

const tenant = asTenantContext('test-tenant');
const MEMBER_ID = '44444444-4444-4444-8444-444444444444';
const REG_DATE = new Date('2026-06-05T00:00:00.000Z');

function makeBaseMember() {
  return {
    tenantId: tenant.slug as never,
    memberId: asMemberId(MEMBER_ID),
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
    registrationDate: REG_DATE,
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
    memberId: asMemberId(MEMBER_ID),
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
    clock: { now: () => REG_DATE },
    memberNumberAllocator: {
      allocate: vi.fn().mockResolvedValue(asMemberNumber(7)),
    },
    idFactory: {
      memberId: () => asMemberId(MEMBER_ID),
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
const meta = { actorUserId: 'actor-uuid', requestId: 'req-onboard-001' };

describe('Task 1.6 — createMember onboarding listener (post-commit)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    bootstrapCycleCreateFailedAdd.mockReset();
  });

  it('invokes the listener post-commit with the new member id + registration date + plan id', async () => {
    const deps = makeDeps();
    const seen: CreateMemberListenerEvent[] = [];
    const listener = vi.fn(async (evt: CreateMemberListenerEvent) => {
      seen.push(evt);
    });

    const result = await createMember(input, meta, {
      ...deps,
      onboardingListeners: [listener],
    });

    expect(result.ok).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      tenantId: tenant.slug,
      memberId: MEMBER_ID,
      planId: 'plan-1',
      correlationId: meta.requestId,
    });
    // registrationDate is threaded as an ISO 8601 UTC string.
    expect(seen[0]!.registrationDate).toBe(REG_DATE.toISOString());
  });

  it('a THROWING listener is swallowed — the use-case still returns ok + the bootstrap counter increments', async () => {
    const deps = makeDeps();
    const throwingListener = vi.fn(async () => {
      throw new Error('synthetic_onboarding_listener_failure');
    });

    const result = await createMember(input, meta, {
      ...deps,
      onboardingListeners: [throwingListener],
    });

    // The member create already committed — the listener failure is
    // best-effort and does NOT surface as an error.
    expect(result.ok).toBe(true);
    expect(throwingListener).toHaveBeenCalledTimes(1);
    // The OTel counter increments exactly once with the tenant label
    // (uuid/slug only — never the member entity/PII; Task 1.8).
    expect(bootstrapCycleCreateFailedAdd).toHaveBeenCalledTimes(1);
    expect(bootstrapCycleCreateFailedAdd).toHaveBeenCalledWith(1, {
      tenant_id: tenant.slug,
    });
  });

  it('runs every listener even when an earlier one throws (per-listener fault isolation)', async () => {
    const deps = makeDeps();
    const throwingListener = vi.fn(async () => {
      throw new Error('first_listener_failure');
    });
    const okListener = vi.fn(async () => {});

    const result = await createMember(input, meta, {
      ...deps,
      onboardingListeners: [throwingListener, okListener],
    });

    expect(result.ok).toBe(true);
    expect(throwingListener).toHaveBeenCalledTimes(1);
    // The second listener still runs despite the first throwing.
    expect(okListener).toHaveBeenCalledTimes(1);
    expect(bootstrapCycleCreateFailedAdd).toHaveBeenCalledTimes(1);
  });

  it('no onboardingListeners → unchanged behaviour (no counter, returns ok)', async () => {
    const deps = makeDeps();
    const result = await createMember(input, meta, deps);
    expect(result.ok).toBe(true);
    expect(bootstrapCycleCreateFailedAdd).not.toHaveBeenCalled();
  });
});
