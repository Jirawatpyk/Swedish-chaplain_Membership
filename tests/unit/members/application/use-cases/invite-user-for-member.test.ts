/**
 * Unit tests for `invite-user-for-member` use case (F1 spec:672-678 gap fix).
 *
 * Gap 2 scenarios deferred by the prior implementer:
 *   - `email_taken` error union branch
 *   - `invalid_email` error union branch (createUser path + asEmail path)
 *   - `server_error` propagation when createUser returns an unexpected code
 *   - Orphan-path: createUser succeeds BUT contactRepo.addInTx throws
 *     → assert user row is left as orphan and use case returns server_error
 *     (the W1 throw-to-rollback pattern from w1-tx-rollback.test.ts)
 *
 * Pattern: mirrors invite-colleague.test.ts (stubbed ports, synchronous
 * runInTenant mock). All assertions are at the boundary of the public
 * function — no production-code modifications.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ok, err } from '@/lib/result';

// ---------------------------------------------------------------------------
// runInTenant — invokes the callback synchronously with a dummy tx.
// The callback MUST throw (not return err) to trigger rollback. This mock
// faithfully re-throws — letting us assert the W1 orphan-path contract.
// ---------------------------------------------------------------------------
vi.mock('@/lib/db', () => ({
  runInTenant: vi.fn(async (_ctx: unknown, fn: (tx: unknown) => unknown) => {
    return await fn({});
  }),
}));

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  inviteUserForMember,
  type InviteUserForMemberDeps,
  type InviteUserForMemberInput,
} from '@/modules/members/application/use-cases/invite-user-for-member';
import { asTenantContext } from '@/modules/tenants';
import { asContactId } from '@/modules/members/domain/contact';
import { asMemberId } from '@/modules/members/domain/member';
import type { Contact } from '@/modules/members/domain/contact';
import type { Member } from '@/modules/members/domain/member';
import { runInTenant as runInTenantMock } from '@/lib/db';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const tenant = asTenantContext('swecham');
const memberId = asMemberId('11111111-1111-4111-8111-111111111111');
const newContactId = asContactId('22222222-2222-4222-8222-222222222222');
const NEW_USER_ID = 'new-user-uuid-001';

const baseInput: InviteUserForMemberInput = {
  memberId,
  email: 'jane.doe@example.com',
  displayName: 'Jane Doe',
  actorUserId: 'actor-admin-uuid',
  sourceIp: '10.0.0.1',
  requestId: 'req-unit-001',
  locale: 'en',
};

function makeMember(overrides: Partial<Member> = {}): Member {
  return {
    tenantId: 'swecham' as never,
    memberId,
    companyName: 'Acme Corp',
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
    status: 'active',
    archivedAt: null,
    lastActivityAt: null,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    ...overrides,
  } as unknown as Member;
}

function makeContact(overrides: Partial<Contact> = {}): Contact {
  return {
    tenantId: 'swecham' as never,
    contactId: newContactId,
    memberId,
    firstName: 'Jane',
    lastName: 'Doe',
    email: 'jane.doe@example.com' as never,
    phone: null,
    roleTitle: null,
    preferredLanguage: 'en',
    isPrimary: false,
    dateOfBirth: null,
    linkedUserId: NEW_USER_ID,
    removedAt: null,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    ...overrides,
  } as unknown as Contact;
}

// ---------------------------------------------------------------------------
// Deps builder
// ---------------------------------------------------------------------------
type DepsOverrides = {
  memberFindResult?: 'ok' | 'not_found' | 'unexpected';
  createUserResult?: 'ok' | 'email-taken' | 'invalid-input' | 'unexpected-code';
  addInTxResult?: 'ok' | 'conflict' | 'throw';
  linkUserInTxResult?: 'ok' | 'conflict';
  auditRecordResult?: 'ok' | 'fail';
  auditRecordInTxResult?: 'ok' | 'fail';
};

function makeDeps(overrides: DepsOverrides = {}): InviteUserForMemberDeps {
  const memberRepo = {
    findById: vi.fn(async () => {
      switch (overrides.memberFindResult ?? 'ok') {
        case 'not_found':
          return err({ code: 'repo.not_found' as const });
        case 'unexpected':
          return err({ code: 'repo.unexpected' as const });
        default:
          return ok(makeMember());
      }
    }),
  };

  const createUser = vi.fn(async () => {
    switch (overrides.createUserResult ?? 'ok') {
      case 'email-taken':
        return err({ code: 'email-taken' as const });
      case 'invalid-input':
        return err({ code: 'invalid-input' as const });
      case 'unexpected-code':
        return err({ code: 'invitation-create-failed' as const });
      default:
        return ok({ user: { id: NEW_USER_ID } });
    }
  });

  const contactRepo = {
    addInTx: vi.fn(async () => {
      switch (overrides.addInTxResult ?? 'ok') {
        case 'conflict':
          return err({ code: 'repo.conflict' as const, reason: 'email already exists' });
        case 'throw':
          // Simulate an infra-level throw (e.g. PG connection drop) instead
          // of a graceful err — the use case must still surface server_error
          // and log the orphan. The throw propagates out of runInTenant's
          // callback, landing in the outer try/catch of the use case.
          throw new Error('PG connection lost');
        default:
          return ok(makeContact());
      }
    }),
    linkUserInTx: vi.fn(async () => {
      if (overrides.linkUserInTxResult === 'conflict') {
        return err({ code: 'repo.conflict' as const, reason: 'already linked' });
      }
      return ok(makeContact());
    }),
  };

  const audit = {
    record: vi.fn(async () => ok(undefined)),
    recordInTx: vi.fn(async () => {
      if (overrides.auditRecordInTxResult === 'fail') {
        return err({ code: 'repo.unexpected' as const });
      }
      return ok(undefined);
    }),
  };

  return {
    tenant,
    memberRepo,
    contactRepo,
    audit,
    createUser,
    idFactory: { contactId: vi.fn(() => newContactId) },
  } as unknown as InviteUserForMemberDeps;
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('inviteUserForMember — error union coverage (Gap 2)', () => {
  beforeEach(() => vi.clearAllMocks());

  // -------------------------------------------------------------------------
  // Step 1: member ownership pre-check
  // -------------------------------------------------------------------------
  describe('member ownership pre-check', () => {
    it('returns member_not_found and emits cross_tenant_probe audit when member not in tenant', async () => {
      const deps = makeDeps({ memberFindResult: 'not_found' });
      const result = await inviteUserForMember(deps, baseInput);

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.type).toBe('member_not_found');
      // Must emit probe audit BEFORE returning — telemetry integrity.
      expect(deps.audit.record).toHaveBeenCalledTimes(1);
      const auditCall = (deps.audit.record as ReturnType<typeof vi.fn>).mock.calls[0]!;
      expect(auditCall[1]).toMatchObject({ type: 'member_cross_tenant_probe' });
      // createUser must NOT be called when memberId is foreign.
      expect(deps.createUser).not.toHaveBeenCalled();
    });

    it('returns server_error when memberRepo.findById returns unexpected repo error', async () => {
      const deps = makeDeps({ memberFindResult: 'unexpected' });
      const result = await inviteUserForMember(deps, baseInput);

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.type).toBe('server_error');
      // No cross-tenant probe audit for infrastructure errors (not a probe).
      expect(deps.audit.record).not.toHaveBeenCalled();
      expect(deps.createUser).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Step 2: email validation (asEmail domain check before createUser)
  // -------------------------------------------------------------------------
  describe('email validation', () => {
    it('returns invalid_email for a malformed email (domain-level asEmail check)', async () => {
      const deps = makeDeps();
      const result = await inviteUserForMember(deps, {
        ...baseInput,
        email: 'not-an-email-address',
      });

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.type).toBe('invalid_email');
      // Domain check fires before createUser — no F1 user should be created.
      expect(deps.createUser).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Step 3: createUser error branches — Gap 2 focus
  // -------------------------------------------------------------------------
  describe('createUser error branches', () => {
    it('returns email_taken when createUser responds with email-taken', async () => {
      const deps = makeDeps({ createUserResult: 'email-taken' });
      const result = await inviteUserForMember(deps, baseInput);

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.type).toBe('email_taken');
      // No contact row should be inserted when email is taken.
      expect(deps.contactRepo.addInTx).not.toHaveBeenCalled();
    });

    it('returns invalid_email when createUser responds with invalid-input', async () => {
      const deps = makeDeps({ createUserResult: 'invalid-input' });
      const result = await inviteUserForMember(deps, baseInput);

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.type).toBe('invalid_email');
      expect(deps.contactRepo.addInTx).not.toHaveBeenCalled();
    });

    it('returns server_error when createUser returns an unexpected error code', async () => {
      // Simulates a future F1 error code that is not yet mapped. The use
      // case must fall through to the server_error branch, not swallow it.
      const deps = makeDeps({ createUserResult: 'unexpected-code' });
      const result = await inviteUserForMember(deps, baseInput);

      expect(result.ok).toBe(false);
      if (!result.ok && result.error.type === 'server_error') {
        // The message must mention createUser for operational correlation.
        expect(result.error.message).toMatch(/createUser/);
      } else {
        throw new Error('expected server_error result');
      }
      expect(deps.contactRepo.addInTx).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Step 4: tx-level failures — orphan path (Gap 2 focus)
  // -------------------------------------------------------------------------
  describe('tx-level failures — orphan path', () => {
    it('returns server_error when contactRepo.addInTx throws (unexpected infra error) — F1 user becomes orphan', async () => {
      // This is the critical orphan scenario: createUser SUCCEEDS (F1 user
      // row + pending invitation created) but the second tx (contact row)
      // throws an unhandled error. The use case must:
      //   1. Catch the throw from runInTenant.
      //   2. Log the orphan breadcrumb (logger.error).
      //   3. Return err({ type: 'server_error' }) — not re-throw.
      const deps = makeDeps({ addInTxResult: 'throw' });
      const result = await inviteUserForMember(deps, baseInput);

      expect(result.ok).toBe(false);
      if (!result.ok && result.error.type === 'server_error') {
        expect(result.error.message).toMatch(/unexpected/);
      } else {
        throw new Error('expected server_error result');
      }
      // createUser was called (F1 user is now orphaned).
      expect(deps.createUser).toHaveBeenCalledTimes(1);
      // runInTenant was entered (the tx started).
      expect(runInTenantMock).toHaveBeenCalledTimes(1);
    });

    it('returns server_error when contactRepo.addInTx returns err (UseCaseAbort path)', async () => {
      // The W1 pattern: addInTx returns err → the use case throws
      // UseCaseAbort inside the tx callback → runInTenant propagates it →
      // outer catch returns server_error.
      const deps = makeDeps({ addInTxResult: 'conflict' });
      const result = await inviteUserForMember(deps, baseInput);

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.type).toBe('server_error');
      // linkUserInTx must NOT run after addInTx fails.
      expect(deps.contactRepo.linkUserInTx).not.toHaveBeenCalled();
    });

    it('returns server_error when contactRepo.linkUserInTx returns err — audit NOT called', async () => {
      const deps = makeDeps({ linkUserInTxResult: 'conflict' });
      const result = await inviteUserForMember(deps, baseInput);

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.type).toBe('server_error');
      // Throw from linkUserInTx short-circuits the callback before audit.
      expect(deps.audit.recordInTx).not.toHaveBeenCalled();
    });

    it('returns server_error when audit.recordInTx fails after add + link succeed', async () => {
      // W1 throw-to-rollback: add + link succeed, audit fails.
      // The use case must rollback and return err. The audit IS attempted
      // (so we exercise the failure branch), then the throw causes rollback.
      const deps = makeDeps({ auditRecordInTxResult: 'fail' });
      const result = await inviteUserForMember(deps, baseInput);

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.type).toBe('server_error');
      expect(deps.audit.recordInTx).toHaveBeenCalledTimes(1);
      expect(deps.contactRepo.addInTx).toHaveBeenCalledTimes(1);
      expect(deps.contactRepo.linkUserInTx).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // Happy path — all steps succeed
  // -------------------------------------------------------------------------
  describe('happy path', () => {
    it('returns ok with userId, contactId, and email on full success', async () => {
      const deps = makeDeps();
      const result = await inviteUserForMember(deps, baseInput);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.userId).toBe(NEW_USER_ID);
        expect(result.value.contactId).toBe(newContactId);
        expect(result.value.email).toBe('jane.doe@example.com');
      }
    });

    it('emits contact_created audit event inside the transaction', async () => {
      const deps = makeDeps();
      await inviteUserForMember(deps, baseInput);

      expect(deps.audit.recordInTx).toHaveBeenCalledTimes(1);
      const auditCall = (deps.audit.recordInTx as ReturnType<typeof vi.fn>).mock.calls[0]!;
      // auditCall[2] is the event object (tx, ctx, event)
      expect(auditCall[2]).toMatchObject({
        type: 'contact_created',
        actorUserId: baseInput.actorUserId,
        targetUserId: NEW_USER_ID,
      });
    });

    it('derives firstName + lastName from displayName when provided', async () => {
      const deps = makeDeps();
      await inviteUserForMember(deps, {
        ...baseInput,
        displayName: 'Anna Lindqvist',
      });

      // addInTx receives the contactDraft — inspect the call arg.
      const addCall = (deps.contactRepo.addInTx as ReturnType<typeof vi.fn>).mock.calls[0]!;
      const draft = addCall[1] as { firstName: string; lastName: string };
      expect(draft.firstName).toBe('Anna');
      expect(draft.lastName).toBe('Lindqvist');
    });

    it('falls back to email local-part as firstName when displayName is null', async () => {
      const deps = makeDeps();
      await inviteUserForMember(deps, {
        ...baseInput,
        displayName: null,
      });

      const addCall = (deps.contactRepo.addInTx as ReturnType<typeof vi.fn>).mock.calls[0]!;
      const draft = addCall[1] as { firstName: string; lastName: string };
      expect(draft.firstName).toBe('jane.doe');
      expect(draft.lastName).toBe('Member');
    });

    it('sets isPrimary=false on the new contact (admin-invited secondary)', async () => {
      const deps = makeDeps();
      await inviteUserForMember(deps, baseInput);

      const addCall = (deps.contactRepo.addInTx as ReturnType<typeof vi.fn>).mock.calls[0]!;
      const draft = addCall[1] as { isPrimary: boolean };
      expect(draft.isPrimary).toBe(false);
    });

    it('passes locale to createUser when provided', async () => {
      const deps = makeDeps();
      await inviteUserForMember(deps, { ...baseInput, locale: 'th' });

      expect(deps.createUser).toHaveBeenCalledWith(
        expect.objectContaining({ locale: 'th' }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // Security: tenant probe audit contains required payload fields
  // -------------------------------------------------------------------------
  describe('security: cross-tenant probe audit shape', () => {
    it('probe audit payload includes attempted_member_id, actor_tenant_id, context', async () => {
      const deps = makeDeps({ memberFindResult: 'not_found' });
      await inviteUserForMember(deps, baseInput);

      const auditCall = (deps.audit.record as ReturnType<typeof vi.fn>).mock.calls[0]!;
      const event = auditCall[1];
      expect(event.payload).toMatchObject({
        attempted_member_id: memberId,
        actor_tenant_id: tenant.slug,
        context: 'invite-user-for-member',
      });
    });
  });
});
