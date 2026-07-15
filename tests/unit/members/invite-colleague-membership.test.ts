/**
 * 059-membership-suspension Task 6 — `inviteColleague` membership-access
 * gate.
 *
 * Every colleague invite mints a brand-new F1 auth account via
 * `createUser` — a suspended or terminated member must never reach that
 * account-provisioning path. The gate lives INSIDE the use case (not just
 * the route), checked FIRST — before the actor-contact lookup and before
 * any `createUser` call — so a blocked member's request never touches F1.
 *
 * Mirrors the test shape of `tests/unit/members/application/invite-
 * colleague.test.ts` (deps-building via a local `makeDeps` helper), but
 * isolated to the new `membershipAccess` precondition so that file's own
 * suite doesn't have to grow unrelated cases.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ok, err } from '@/lib/result';

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
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

function makePrimaryContact(): Contact {
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
  } as unknown as Contact;
}

function makeLinkedContact(): Contact {
  return { ...makePrimaryContact(), contactId: newContactId } as Contact;
}

type AccessStub =
  | { access: 'full' | 'suspended' | 'terminated'; reason: string }
  | 'lookup_error';

function makeDeps(accessStub: AccessStub): InviteColleagueDeps {
  const contactRepo = {
    findById: vi.fn(async () => ok(makePrimaryContact())),
    addInTx: vi.fn(async () => ok(makeLinkedContact())),
    linkUserInTx: vi.fn(async () => ok(makeLinkedContact())),
  };

  const createUser = vi.fn(async () =>
    ok({ user: { id: 'new-user-uuid' }, outboxRowId: 'outbox-new-user' }),
  );

  const deleteInvitedUser = vi.fn(async () => ({ ok: true }));

  const audit = {
    record: vi.fn(async () => ok(undefined)),
    recordInTx: vi.fn(async () => ok(undefined)),
  };

  const membershipAccess = {
    getMembershipAccess: vi.fn(async () =>
      accessStub === 'lookup_error'
        ? err({ kind: 'membership_access.lookup_error' as const })
        : ok(accessStub),
    ),
  };

  return {
    tenant,
    contactRepo,
    audit,
    createUser,
    deleteInvitedUser,
    membershipAccess,
    idFactory: { contactId: vi.fn(() => newContactId) },
  } as unknown as InviteColleagueDeps;
}

describe('inviteColleague — membership-access gate (Task 6)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('blocks a suspended member and never mints a new F1 account', async () => {
    const deps = makeDeps({ access: 'suspended', reason: 'unpaid' });
    const result = await inviteColleague(deps, baseInput);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.type).toBe('membership_suspended');
    expect(deps.createUser).not.toHaveBeenCalled();
    // Fail fast — checked BEFORE the actor-contact lookup too.
    expect(deps.contactRepo.findById).not.toHaveBeenCalled();
  });

  it('blocks a terminated member the same way', async () => {
    const deps = makeDeps({ access: 'terminated', reason: 'grace_expired' });
    const result = await inviteColleague(deps, baseInput);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.type).toBe('membership_suspended');
    expect(deps.createUser).not.toHaveBeenCalled();
  });

  it('fails CLOSED (server_error) when the membership-access lookup errors', async () => {
    const deps = makeDeps('lookup_error');
    const result = await inviteColleague(deps, baseInput);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe('server_error');
      if (result.error.type === 'server_error') {
        expect(result.error.message).toContain('membership_access_error');
      }
    }
    expect(deps.createUser).not.toHaveBeenCalled();
  });

  it('allows the invite to proceed when access is full', async () => {
    const deps = makeDeps({ access: 'full', reason: 'in_good_standing' });
    const result = await inviteColleague(deps, baseInput);
    expect(result.ok).toBe(true);
    expect(deps.createUser).toHaveBeenCalledTimes(1);
  });
});
