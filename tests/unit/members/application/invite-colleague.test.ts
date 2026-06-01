import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ok, err } from '@/lib/result';

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
// S1 refactor — runInTenant is mocked to invoke the callback synchronously
// with a dummy tx; the use case's orchestration logic (port calls +
// audit.recordInTx) is what the tests assert against.
vi.mock('@/lib/db', () => ({
  runInTenant: vi.fn(async (_ctx, fn) => fn({} as never)),
}));

import {
  inviteColleague,
  type InviteColleagueInput,
  type InviteColleagueDeps,
} from '@/modules/members/application/use-cases/invite-colleague';
import { asTenantContext } from '@/modules/tenants';
import { asContactId } from '@/modules/members/domain/contact';
import type { MemberId } from '@/modules/members/domain/member';
import type { Contact } from '@/modules/members/domain/contact';

const tenant = asTenantContext('swecham');
const memberId = 'member-uuid-001' as MemberId;
const actorContactId = asContactId('a1b2c3d4-e5f6-7890-abcd-ef1234567890');
const newContactId = asContactId('b2c3d4e5-f6a7-8901-bcde-f01234567891');

const baseInput: InviteColleagueInput = {
  memberId,
  actorUserId: 'actor-user-uuid',
  actorContactId,
  sourceIp: '10.0.0.1',
  requestId: 'req-001',
  body: {
    first_name: 'Jane',
    last_name: 'Doe',
    email: 'jane.doe@example.com',
    preferred_language: 'en',
  },
};

function makeContact(overrides: Partial<Contact> = {}): Contact {
  return {
    tenantId: 'swecham' as never,
    contactId: actorContactId,
    memberId,
    firstName: 'John',
    lastName: 'Smith',
    email: 'john.smith@example.com' as never,
    phone: null,
    roleTitle: null,
    preferredLanguage: 'en',
    isPrimary: true,
    dateOfBirth: null,
    linkedUserId: null,
    removedAt: null,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    ...overrides,
  } as unknown as Contact;
}

function makeLinkedContact(): Contact {
  return makeContact({ contactId: newContactId });
}

type DepsOverrides = {
  findByIdResult?: Contact | Error;
  createUserResult?: { user: { id: string } } | { code: string };
  addResult?: Contact | Error;
  linkUserResult?: Contact | Error;
  auditFail?: boolean;
  /** go-live #12-13 follow-up — force the SAGA compensation to fail. */
  compensationFails?: boolean;
};

function makeDeps(overrides: DepsOverrides = {}): InviteColleagueDeps {
  const contactRepo = {
    findById: vi.fn(async () => {
      const r = overrides.findByIdResult;
      if (r instanceof Error) return err({ code: 'repo.unexpected' as const });
      if (r) return ok(r);
      return ok(makeContact());
    }),
    addInTx: vi.fn(async () => {
      const r = overrides.addResult;
      if (r instanceof Error) return err({ code: 'repo.unexpected' as const });
      return ok(r ?? makeLinkedContact());
    }),
    linkUserInTx: vi.fn(async () => {
      const r = overrides.linkUserResult;
      if (r instanceof Error) return err({ code: 'repo.unexpected' as const });
      return ok(r ?? makeLinkedContact());
    }),
  };

  const createUser = vi.fn(async () => {
    if (overrides.createUserResult && 'code' in overrides.createUserResult) {
      return err(overrides.createUserResult as { code: string });
    }
    return ok(
      overrides.createUserResult ?? { user: { id: 'new-user-uuid' }, outboxRowId: 'outbox-new-user' },
    );
  });

  // go-live #12-13 (follow-up) — SAGA compensation port. Default succeeds;
  // `compensationFails` flips it to exercise the compensation-failed log branch.
  const deleteInvitedUser = vi.fn(async () => ({ ok: !overrides.compensationFails }));

  const audit = {
    record: vi.fn(async () => ok(undefined)),
    recordInTx: vi.fn(async () => {
      if (overrides.auditFail) return err({ code: 'repo.unexpected' as const });
      return ok(undefined);
    }),
  };

  return {
    tenant,
    contactRepo,
    audit,
    createUser,
    deleteInvitedUser,
    idFactory: { contactId: vi.fn(() => newContactId) },
  } as unknown as InviteColleagueDeps;
}

describe('inviteColleague use case', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns server_error when contactRepo.findById fails', async () => {
    const deps = makeDeps({ findByIdResult: new Error('DB down') });
    const result = await inviteColleague(deps, baseInput);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.type).toBe('server_error');
  });

  it('returns not_primary when actor is not the primary contact', async () => {
    const deps = makeDeps({
      findByIdResult: makeContact({ isPrimary: false }),
    });
    const result = await inviteColleague(deps, baseInput);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe('not_primary');
    }
  });

  it('returns not_primary when actor belongs to a different member', async () => {
    const deps = makeDeps({
      findByIdResult: makeContact({ memberId: 'other-member' as MemberId }),
    });
    const result = await inviteColleague(deps, baseInput);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.type).toBe('not_primary');
  });

  it('returns invalid_email when email is invalid format', async () => {
    const deps = makeDeps();
    const result = await inviteColleague(deps, {
      ...baseInput,
      body: { ...baseInput.body, email: 'not-an-email' },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.type).toBe('invalid_email');
  });

  it('returns invalid_email when createUser returns invalid-input', async () => {
    const deps = makeDeps({ createUserResult: { code: 'invalid-input' } });
    const result = await inviteColleague(deps, baseInput);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.type).toBe('invalid_email');
  });

  it('returns email_taken when createUser returns email-taken', async () => {
    const deps = makeDeps({ createUserResult: { code: 'email-taken' } });
    const result = await inviteColleague(deps, baseInput);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.type).toBe('email_taken');
  });

  it('returns server_error when createUser returns other error', async () => {
    const deps = makeDeps({ createUserResult: { code: 'invitation-create-failed' } });
    const result = await inviteColleague(deps, baseInput);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.type).toBe('server_error');
  });

  // go-live #12-13 (follow-up) — a controlled repo failure in the contact tx is
  // a compensated rollback → link_failed (retry safe), NOT server_error.
  it('returns link_failed when contactRepo.add fails (compensated rollback)', async () => {
    const deps = makeDeps({ addResult: new Error('add fail') });
    const result = await inviteColleague(deps, baseInput);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.type).toBe('link_failed');
  });

  it('returns link_failed when contactRepo.linkUser fails (compensated rollback)', async () => {
    const deps = makeDeps({ linkUserResult: new Error('link fail') });
    const result = await inviteColleague(deps, baseInput);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.type).toBe('link_failed');
  });

  it('returns link_failed when audit.record fails (compensated rollback)', async () => {
    const deps = makeDeps({ auditFail: true });
    const result = await inviteColleague(deps, baseInput);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.type).toBe('link_failed');
  });

  it('returns ok with contact and userId on success', async () => {
    const linked = makeLinkedContact();
    const deps = makeDeps({
      linkUserResult: linked,
      createUserResult: { user: { id: 'new-user-uuid' } },
    });
    const result = await inviteColleague(deps, baseInput);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.contact).toBe(linked);
      expect(result.value.userId).toBe('new-user-uuid');
    }
    expect(deps.audit.recordInTx).toHaveBeenCalledTimes(1);
    // Happy path never compensates.
    expect(deps.deleteInvitedUser).not.toHaveBeenCalled();
  });

  // go-live #12-13 (follow-up) — SAGA compensation: when the contact tx rolls
  // back AFTER createUser committed, the orphaned F1 user is rolled back too.
  it('compensates the orphaned F1 user when the contact tx fails (link)', async () => {
    const deps = makeDeps({ linkUserResult: new Error('link fail') });
    const result = await inviteColleague(deps, baseInput);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.type).toBe('link_failed');
    // The just-created user (+ its queued invite email) is rolled back by id.
    expect(deps.deleteInvitedUser).toHaveBeenCalledOnce();
    expect(deps.deleteInvitedUser).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'new-user-uuid',
        outboxRowId: 'outbox-new-user',
        targetEmail: 'jane.doe@example.com',
        requestId: 'req-001',
      }),
    );
  });

  it('also compensates when the add-contact step fails', async () => {
    const deps = makeDeps({ addResult: new Error('add fail') });
    const result = await inviteColleague(deps, baseInput);
    expect(result.ok).toBe(false);
    expect(deps.deleteInvitedUser).toHaveBeenCalledOnce();
  });

  it('still returns link_failed when the compensation itself fails (orphan logged)', async () => {
    // The returned code is decided by abort-vs-throw, not by compensation success;
    // a failed compensation is logged but the caller still sees link_failed.
    const deps = makeDeps({ linkUserResult: new Error('link fail'), compensationFails: true });
    const result = await inviteColleague(deps, baseInput);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.type).toBe('link_failed');
    expect(deps.deleteInvitedUser).toHaveBeenCalledOnce();
  });
});
