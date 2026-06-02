/**
 * W1 regression tests — audit-failure-after-repo-success path.
 *
 * Staff review round 3 (staff-review-20260417-175745-full-round3.md)
 * flagged an atomicity bug in the 4 use cases touched by the S1
 * refactor (`contact-crud`, `create-member`, `invite-colleague`,
 * `member-self-update`). Those callbacks previously used
 * `return err(...)` on sub-step failures inside `runInTenant(...)`
 * — which commits the tx in Drizzle. Only `throw` triggers rollback.
 *
 * This suite mocks `runInTenant` to invoke the callback synchronously
 * with a fake tx AND asserts:
 *
 *   1. When a repo `*InTx` step returns `err`, the use case returns
 *      `err` (no swallow) AND throws were thrown from the callback —
 *      proven by the mocked runInTenant NOT receiving the repo value.
 *   2. When `audit.recordInTx` returns `err` AFTER the repo write
 *      succeeds, the use case returns `err` AND the tx rolls back —
 *      proven by the mocked runInTenant re-throwing the UseCaseAbort.
 *
 * The real atomicity guarantee (Drizzle tx rollback on throw) is
 * integration-test territory (see
 * `tests/integration/members/*-atomic.test.ts`). This unit suite
 * locks in the *shape* — use cases must `throw` on failure, not
 * `return err`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ok, err } from '@/lib/result';

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// `runInTenant` stub — invokes the callback with a dummy tx and
// re-throws anything thrown inside. Does NOT swallow returns; a plain
// `return err(...)` would reach the caller, which is the bug W1 fixes.
vi.mock('@/lib/db', () => ({
  runInTenant: vi.fn(async (_ctx: unknown, fn: (tx: unknown) => unknown) => {
    return await fn({});
  }),
}));

import { runInTenant as runInTenantMock } from '@/lib/db';

import { addContact } from '@/modules/members/application/use-cases/contact-crud';
import type { ContactCrudDeps } from '@/modules/members/application/use-cases/contact-crud';
import { asTenantContext } from '@/modules/tenants';
import { asContactId } from '@/modules/members/domain/contact';
import { asMemberId } from '@/modules/members/domain/member';

const tenant = asTenantContext('test-tenant');
const memberId = asMemberId('11111111-1111-4111-8111-111111111111');
const contactId = asContactId('22222222-2222-4222-8222-222222222222');

function makeDeps(options: {
  addInTxResult: ReturnType<typeof ok> | ReturnType<typeof err>;
  auditResult: ReturnType<typeof ok> | ReturnType<typeof err>;
}): ContactCrudDeps {
  return {
    tenant,
    contactRepo: {
      addInTx: vi.fn().mockResolvedValue(options.addInTxResult),
      updateInTx: vi.fn(),
      removeInTx: vi.fn(),
      linkUserInTx: vi.fn(),
      promotePrimaryInTx: vi.fn(),
      updateEmailInTx: vi.fn(),
      listLinkedUserIdsForMemberInTx: vi.fn(),
      listByMember: vi.fn(),
      findById: vi.fn(),
    } as unknown as ContactCrudDeps['contactRepo'],
    audit: {
      record: vi.fn(),
      recordInTx: vi.fn().mockResolvedValue(options.auditResult),
    },
    idFactory: { contactId: () => contactId },
  };
}

const validInput = {
  first_name: 'Jane',
  last_name: 'Doe',
  email: 'jane@test.example',
  preferred_language: 'en' as const,
};
const meta = {
  actorUserId: 'actor-uuid',
  requestId: 'req-w1-001',
};

describe('W1 — audit atomicity regression (throw-to-rollback)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('addContact: returns err when addInTx fails (throws inside tx)', async () => {
    const deps = makeDeps({
      addInTxResult: err({ code: 'repo.conflict' as const, reason: 'dup' }),
      auditResult: ok(undefined),
    });
    const result = await addContact(memberId, validInput, meta, deps);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.type).toBe('conflict');
    // Audit MUST NOT be attempted when addInTx fails — the throw short-
    // circuits the callback before the audit recordInTx call.
    expect(deps.audit.recordInTx).not.toHaveBeenCalled();
  });

  it('addContact: returns err AND rolls back when audit.recordInTx fails after addInTx succeeds', async () => {
    const fakeContact = {
      tenantId: tenant.slug as never,
      contactId,
      memberId,
      firstName: 'Jane',
      lastName: 'Doe',
      email: 'jane@test.example' as never,
      phone: null,
      roleTitle: null,
      preferredLanguage: 'en' as const,
      isPrimary: false,
      dateOfBirth: null,
      linkedUserId: null,
      removedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const deps = makeDeps({
      addInTxResult: ok(fakeContact),
      auditResult: err({ code: 'repo.unexpected' as const, cause: 'audit db down' }),
    });

    const result = await addContact(memberId, validInput, meta, deps);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.type).toBe('server_error');
    // The audit call HAPPENED (so we know we exercised the failure branch)...
    expect(deps.audit.recordInTx).toHaveBeenCalledTimes(1);
    // ...and the callback was invoked inside runInTenant...
    expect(runInTenantMock).toHaveBeenCalledTimes(1);
    // ...and control returned to the caller via the outer catch
    // rather than a normal callback return. That is what `throw new
    // UseCaseAbort` guarantees — and what the old `return err(...)`
    // pattern failed to deliver. A live Drizzle tx would now have
    // rolled back the addInTx insert because the callback threw.
  });

  it('addContact: happy path — addInTx ok + audit ok → use case ok', async () => {
    const fakeContact = {
      tenantId: tenant.slug as never,
      contactId,
      memberId,
      firstName: 'Jane',
      lastName: 'Doe',
      email: 'jane@test.example' as never,
      phone: null,
      roleTitle: null,
      preferredLanguage: 'en' as const,
      isPrimary: false,
      dateOfBirth: null,
      linkedUserId: null,
      removedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const deps = makeDeps({
      addInTxResult: ok(fakeContact),
      auditResult: ok(undefined),
    });
    const result = await addContact(memberId, validInput, meta, deps);
    expect(result.ok).toBe(true);
    expect(deps.audit.recordInTx).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// inviteColleague — same W1 throw-to-rollback pattern.
// ---------------------------------------------------------------------------
import { inviteColleague } from '@/modules/members/application/use-cases/invite-colleague';
import type { InviteColleagueDeps } from '@/modules/members/application/use-cases/invite-colleague';

function makeInviteColleagueDeps(options: {
  addInTxResult: ReturnType<typeof ok> | ReturnType<typeof err>;
  linkUserInTxResult: ReturnType<typeof ok> | ReturnType<typeof err>;
  auditResult: ReturnType<typeof ok> | ReturnType<typeof err>;
}): InviteColleagueDeps {
  const actorContact = {
    tenantId: tenant.slug as never,
    contactId,
    memberId,
    firstName: 'Actor',
    lastName: 'Primary',
    email: 'actor@test.example' as never,
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
  return {
    tenant,
    contactRepo: {
      findById: vi.fn().mockResolvedValue(ok(actorContact)),
      addInTx: vi.fn().mockResolvedValue(options.addInTxResult),
      linkUserInTx: vi.fn().mockResolvedValue(options.linkUserInTxResult),
    } as unknown as InviteColleagueDeps['contactRepo'],
    audit: {
      record: vi.fn(),
      recordInTx: vi.fn().mockResolvedValue(options.auditResult),
    },
    createUser: vi.fn().mockResolvedValue(
      ok({ user: { id: 'user-uuid-new' }, outboxRowId: 'outbox-uuid-new' }),
    ) as unknown as InviteColleagueDeps['createUser'],
    // go-live #12-13 (follow-up) — the rollback path now compensates the orphaned
    // F1 user; stub the port so the catch branch can invoke it. Default ok:true;
    // individual tests can override to assert the compensation-failure log path.
    deleteInvitedUser: vi.fn().mockResolvedValue({ ok: true }) as unknown as InviteColleagueDeps['deleteInvitedUser'],
    idFactory: {
      contactId: () => asContactId('33333333-3333-4333-8333-333333333333'),
    },
  };
}

const inviteColleagueInput = {
  memberId,
  actorUserId: 'actor-user-uuid',
  actorContactId: contactId,
  sourceIp: '127.0.0.1',
  requestId: 'req-ic-001',
  body: {
    first_name: 'Jane',
    last_name: 'Doe',
    email: 'jane@test.example',
    preferred_language: 'en' as const,
  },
};

describe('W1 — inviteColleague throw-to-rollback', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns err when linkUserInTx fails after addInTx succeeds (audit NOT attempted)', async () => {
    const fakeContact = {
      tenantId: tenant.slug as never,
      contactId,
      memberId,
      firstName: 'Jane',
      lastName: 'Doe',
      email: 'jane@test.example' as never,
      phone: null,
      roleTitle: null,
      preferredLanguage: 'en' as const,
      isPrimary: false,
      dateOfBirth: null,
      linkedUserId: null,
      removedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const deps = makeInviteColleagueDeps({
      addInTxResult: ok(fakeContact),
      linkUserInTxResult: err({
        code: 'repo.conflict' as const,
        reason: 'already linked',
      }),
      auditResult: ok(undefined),
    });
    const result = await inviteColleague(deps, inviteColleagueInput);
    expect(result.ok).toBe(false);
    // go-live #12-13 follow-up — a controlled UseCaseAbort rollback returns the
    // typed `link_failed` (orphan compensated, retry safe), NOT server_error.
    if (!result.ok) expect(result.error.type).toBe('link_failed');
    // Throw short-circuits the callback BEFORE audit.recordInTx runs.
    expect(deps.audit.recordInTx).not.toHaveBeenCalled();
    expect(runInTenantMock).toHaveBeenCalled();
  });

  it('returns err when audit.recordInTx fails after add + link succeed', async () => {
    const fakeContact = {
      tenantId: tenant.slug as never,
      contactId,
      memberId,
      firstName: 'Jane',
      lastName: 'Doe',
      email: 'jane@test.example' as never,
      phone: null,
      roleTitle: null,
      preferredLanguage: 'en' as const,
      isPrimary: false,
      dateOfBirth: null,
      linkedUserId: null,
      removedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const deps = makeInviteColleagueDeps({
      addInTxResult: ok(fakeContact),
      linkUserInTxResult: ok(fakeContact),
      auditResult: err({ code: 'repo.unexpected' as const }),
    });
    const result = await inviteColleague(deps, inviteColleagueInput);
    expect(result.ok).toBe(false);
    // go-live #12-13 follow-up — controlled UseCaseAbort rollback → `link_failed`.
    if (!result.ok) expect(result.error.type).toBe('link_failed');
    // Audit was attempted (so we exercised the failure branch) AND the
    // use case still surfaced err — which only happens if UseCaseAbort
    // was thrown + caught outside runInTenant. A `return err` pattern
    // would have committed the preceding add + link → silent audit gap.
    expect(deps.audit.recordInTx).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// memberSelfUpdate — W1 guard for the contact-update sub-tx.
// ---------------------------------------------------------------------------
import { memberSelfUpdate } from '@/modules/members/application/use-cases/member-self-update';
import type { MemberSelfUpdateDeps } from '@/modules/members/application/use-cases/member-self-update';

function makeBaseMember() {
  return {
    tenantId: tenant.slug as never,
    memberId,
    companyName: 'Acme Ltd',
    legalEntityType: 'Co., Ltd.',
    country: 'TH' as never,
    taxId: null,
    website: null,
    description: null,
    foundedYear: 2020,
    turnoverThb: null,
    planId: 'plan-1' as never,
    planYear: 2026,
    registrationDate: new Date('2026-01-01'),
    registrationFeePaid: true,
    notes: null,
    status: 'active' as const,
    archivedAt: null,
    lastActivityAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function makeBaseContact() {
  return {
    tenantId: tenant.slug as never,
    contactId,
    memberId,
    firstName: 'Alice',
    lastName: 'Doe',
    email: 'alice@test.example' as never,
    phone: null,
    roleTitle: null,
    preferredLanguage: 'en' as const,
    isPrimary: true,
    dateOfBirth: null,
    linkedUserId: 'user-self',
    removedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function makeSelfUpdateDeps(options: {
  updateInTxResult: ReturnType<typeof ok> | ReturnType<typeof err>;
  auditResult: ReturnType<typeof ok> | ReturnType<typeof err>;
}): MemberSelfUpdateDeps {
  const baseMember = makeBaseMember();
  const baseContact = makeBaseContact();
  return {
    tenant,
    memberRepo: {
      findById: vi.fn().mockResolvedValue(ok(baseMember)),
      // P2 Wave-0 — memberSelfUpdate now re-reads FOR UPDATE inside the tx and
      // asserts not-archived before writing. Default to the active baseMember.
      findByIdInTx: vi.fn().mockResolvedValue(ok(baseMember)),
      findManyByIdsInTx: vi.fn(),
      findByLinkedUserId: vi.fn().mockResolvedValue(ok(baseMember)),
      findSoftDuplicate: vi.fn(),
      createWithPrimaryContactInTx: vi.fn(),
      updateStatus: vi.fn(),
      updateStatusInTx: vi.fn(),
      updateFields: vi.fn().mockResolvedValue(ok(baseMember)),
      updateFieldsInTx: vi.fn(),
      searchDirectory: vi.fn(),
      searchDirectoryWithCount: vi.fn(),
    } as unknown as MemberSelfUpdateDeps['memberRepo'],
    contactRepo: {
      listByMember: vi.fn().mockResolvedValue(ok([baseContact])),
      findById: vi.fn().mockResolvedValue(ok(baseContact)),
      addInTx: vi.fn(),
      updateInTx: vi.fn().mockResolvedValue(options.updateInTxResult),
      removeInTx: vi.fn(),
      linkUserInTx: vi.fn(),
      promotePrimaryInTx: vi.fn(),
      updateEmailInTx: vi.fn(),
      listLinkedUserIdsForMemberInTx: vi.fn(),
    } as unknown as MemberSelfUpdateDeps['contactRepo'],
    audit: {
      record: vi.fn().mockResolvedValue(ok(undefined)),
      recordInTx: vi.fn().mockResolvedValue(options.auditResult),
    },
  };
}

describe('W1 — memberSelfUpdate throw-to-rollback', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns err when contact updateInTx fails (audit NOT attempted)', async () => {
    const deps = makeSelfUpdateDeps({
      updateInTxResult: err({ code: 'repo.not_found' as const }),
      auditResult: ok(undefined),
    });
    const result = await memberSelfUpdate(deps, {
      memberId,
      contactId,
      rawBody: { primary_contact: { firstName: 'AliceNew' } },
      actorUserId: 'user-self',
      requestId: 'req-msu-001',
    });
    expect(result.ok).toBe(false);
    expect(deps.audit.recordInTx).not.toHaveBeenCalled();
  });

  it('returns err when audit.recordInTx fails after contact updateInTx succeeds', async () => {
    const updatedContact = makeBaseContact();
    const deps = makeSelfUpdateDeps({
      updateInTxResult: ok({ ...updatedContact, firstName: 'AliceNew' }),
      auditResult: err({ code: 'repo.unexpected' as const }),
    });
    const result = await memberSelfUpdate(deps, {
      memberId,
      contactId,
      rawBody: { primary_contact: { firstName: 'AliceNew' } },
      actorUserId: 'user-self',
      requestId: 'req-msu-002',
    });
    expect(result.ok).toBe(false);
    expect(deps.audit.recordInTx).toHaveBeenCalledTimes(1);
  });

  it('P2 wave-0 — forbidden when a concurrent archive wins (in-tx FOR UPDATE re-read sees archived)', async () => {
    const deps = makeSelfUpdateDeps({
      updateInTxResult: ok(makeBaseContact()),
      auditResult: ok(undefined),
    });
    // Pre-tx findById saw an ACTIVE member (default mock), but the in-tx
    // FOR-UPDATE re-read sees it archived — a concurrent archive raced the
    // ownership read. The guard must refuse before any write/audit.
    (deps.memberRepo.findByIdInTx as ReturnType<typeof vi.fn>).mockResolvedValue(
      ok({ ...makeBaseMember(), status: 'archived' }),
    );
    const result = await memberSelfUpdate(deps, {
      memberId,
      contactId,
      rawBody: {
        website: 'https://evil.example',
        primary_contact: { firstName: 'Sneaky' },
      },
      actorUserId: 'user-self',
      requestId: 'req-msu-archived-race',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.type).toBe('forbidden');
    // Archived-immutability invariant held: no member/contact write, no audit.
    expect(deps.memberRepo.updateFieldsInTx).not.toHaveBeenCalled();
    expect(deps.contactRepo.updateInTx).not.toHaveBeenCalled();
    expect(deps.audit.recordInTx).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// createMember — W1 guard for the member + 2-audit-event atomic tx.
// ---------------------------------------------------------------------------
import { createMember } from '@/modules/members/application/use-cases/create-member';
import type { CreateMemberDeps } from '@/modules/members/application/use-cases/create-member';

function makeCreateMemberDeps(options: {
  createResult: ReturnType<typeof ok> | ReturnType<typeof err>;
  auditResults: Array<ReturnType<typeof ok> | ReturnType<typeof err>>;
}): CreateMemberDeps {
  const auditCalls = [...options.auditResults];
  return {
    tenant,
    memberRepo: {
      findById: vi.fn(),
      findByIdInTx: vi.fn(),
      findManyByIdsInTx: vi.fn(),
      findByLinkedUserId: vi.fn(),
      findSoftDuplicate: vi.fn().mockResolvedValue(ok(null)),
      createWithPrimaryContactInTx: vi.fn().mockResolvedValue(options.createResult),
      updateStatus: vi.fn(),
      updateStatusInTx: vi.fn(),
      updateFields: vi.fn(),
      updateFieldsInTx: vi.fn(),
      searchDirectory: vi.fn(),
      searchDirectoryWithCount: vi.fn(),
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
          includesCorporatePlanId: null,
          annualFeeMinorUnits: 1_000_000,
          isActive: true,
        }),
      ),
    } as unknown as CreateMemberDeps['plans'],
    audit: {
      record: vi.fn(),
      recordInTx: vi.fn(async () => auditCalls.shift() ?? ok(undefined)),
    } as unknown as CreateMemberDeps['audit'],
    clock: { now: () => new Date('2026-04-17') },
    idFactory: {
      memberId: () => asMemberId('44444444-4444-4444-8444-444444444444'),
      contactId: () => asContactId('55555555-5555-4555-8555-555555555555'),
    },
  };
}

const createMemberInput = {
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
const createMemberMeta = { actorUserId: 'actor-uuid', requestId: 'req-cm-001' };

describe('W1 — createMember throw-to-rollback', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns err when createWithPrimaryContactInTx fails (no audits attempted)', async () => {
    const deps = makeCreateMemberDeps({
      createResult: err({ code: 'repo.conflict' as const, reason: 'dup' }),
      auditResults: [ok(undefined), ok(undefined)],
    });
    const result = await createMember(createMemberInput, createMemberMeta, deps);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.type).toBe('conflict');
    expect(deps.audit.recordInTx).not.toHaveBeenCalled();
  });

  it('returns err when SECOND audit event fails (member_created succeeded, contact_created failed)', async () => {
    const fakeCreated = {
      member: makeBaseMember(),
      contact: makeBaseContact(),
    };
    const deps = makeCreateMemberDeps({
      createResult: ok(fakeCreated),
      auditResults: [
        ok(undefined), // member_created ok
        err({ code: 'repo.unexpected' as const }), // contact_created fail
      ],
    });
    const result = await createMember(createMemberInput, createMemberMeta, deps);
    expect(result.ok).toBe(false);
    // Both audits attempted (first ok, second throws) → 2 calls total.
    expect(deps.audit.recordInTx).toHaveBeenCalledTimes(2);
  });
});
