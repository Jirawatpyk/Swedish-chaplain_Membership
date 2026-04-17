import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ok, err } from '@/lib/result';

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
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
};

function makeDeps(overrides: DepsOverrides = {}): InviteColleagueDeps {
  const contactRepo = {
    findById: vi.fn(async () => {
      const r = overrides.findByIdResult;
      if (r instanceof Error) return err({ code: 'repo.unexpected' as const });
      if (r) return ok(r);
      return ok(makeContact());
    }),
    add: vi.fn(async () => {
      const r = overrides.addResult;
      if (r instanceof Error) return err({ code: 'repo.unexpected' as const });
      return ok(r ?? makeLinkedContact());
    }),
    linkUser: vi.fn(async () => {
      const r = overrides.linkUserResult;
      if (r instanceof Error) return err({ code: 'repo.unexpected' as const });
      return ok(r ?? makeLinkedContact());
    }),
    findByMember: vi.fn(),
    remove: vi.fn(),
    update: vi.fn(),
  };

  const createUser = vi.fn(async () => {
    if (overrides.createUserResult && 'code' in overrides.createUserResult) {
      return err(overrides.createUserResult as { code: string });
    }
    return ok(overrides.createUserResult ?? { user: { id: 'new-user-uuid' } });
  });

  const audit = {
    record: vi.fn(async () => {
      if (overrides.auditFail) return err({ code: 'repo.unexpected' as const });
      return ok(undefined);
    }),
    recordInTx: vi.fn(),
  };

  return {
    tenant,
    contactRepo,
    audit,
    createUser,
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

  it('returns server_error when contactRepo.add fails', async () => {
    const deps = makeDeps({ addResult: new Error('add fail') });
    const result = await inviteColleague(deps, baseInput);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.type).toBe('server_error');
  });

  it('returns server_error when contactRepo.linkUser fails', async () => {
    const deps = makeDeps({ linkUserResult: new Error('link fail') });
    const result = await inviteColleague(deps, baseInput);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.type).toBe('server_error');
  });

  it('returns server_error when audit.record fails', async () => {
    const deps = makeDeps({ auditFail: true });
    const result = await inviteColleague(deps, baseInput);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.type).toBe('server_error');
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
    expect(deps.audit.record).toHaveBeenCalledTimes(1);
  });
});
