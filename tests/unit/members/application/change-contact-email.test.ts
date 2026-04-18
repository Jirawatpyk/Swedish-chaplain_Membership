/**
 * Unit tests for `changeContactEmail` use case (FR-012a).
 *
 * Mocks `runInTenant` + all port dependencies. Integration-level tests
 * (real Postgres transaction, outbox rows) live in
 * tests/integration/members/change-contact-email.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ok, err } from '@/lib/result';

// Hoisted mock: must precede imports that transitively import these modules.
vi.mock('@/lib/db', () => ({
  runInTenant: vi.fn(
    async <T>(_ctx: unknown, fn: (tx: unknown) => Promise<T>): Promise<T> => {
      return fn(stubTx);
    },
  ),
}));
vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

// Stub transaction — satisfies `tx.insert(auditLog).values(...)`.
const stubTx = {
  insert: vi.fn(() => ({ values: vi.fn(async () => []) })),
};

import { changeContactEmail } from '@/modules/members/application/use-cases/change-contact-email';
import { asTenantContext } from '@/modules/tenants';
import type { ChangeContactEmailDeps } from '@/modules/members/application/use-cases/change-contact-email';
import type { Contact } from '@/modules/members/domain/contact';

const tenant = asTenantContext('test-tenant');

const contactId = 'c-001' as Contact['contactId'];
const userId = 'u-001';
const memberId = 'm-001' as Contact['memberId'];

function makeContact(overrides: Partial<Contact> = {}): Contact {
  return {
    tenantId: 'test-tenant' as Contact['tenantId'],
    contactId,
    memberId,
    firstName: 'Alice',
    lastName: 'Smith',
    email: 'alice@old.com' as Contact['email'],
    phone: null,
    roleTitle: null,
    preferredLanguage: 'en',
    isPrimary: true,
    dateOfBirth: null,
    linkedUserId: userId as Contact['linkedUserId'],
    removedAt: null,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    ...overrides,
  };
}

function makeDeps(overrides: Partial<{
  findByIdResult: unknown;
  contactUpdateResult: unknown;
  userUpdateResult: unknown;
  sessionResult: unknown;
  tokenInsertResult: unknown;
  emailEnqueueResult: unknown;
}> = {}): ChangeContactEmailDeps {
  const {
    findByIdResult = ok(makeContact()),
    contactUpdateResult = ok(undefined),
    userUpdateResult = ok({ oldEmail: 'alice@old.com' }),
    sessionResult = ok({ revokedCount: 2 }),
    tokenInsertResult = ok(undefined),
    emailEnqueueResult = ok({ outboxRowId: 'outbox-row-1' }),
  } = overrides;

  return {
    tenant,
    contactRepo: {
      findById: vi.fn(async () => findByIdResult),
      updateEmailInTx: vi.fn(async () => contactUpdateResult),
    } as unknown as ChangeContactEmailDeps['contactRepo'],
    userEmails: {
      updateInTx: vi.fn(async () => userUpdateResult),
    } as unknown as ChangeContactEmailDeps['userEmails'],
    sessions: {
      revokeAllForInTx: vi.fn(async () => sessionResult),
    } as unknown as ChangeContactEmailDeps['sessions'],
    tokens: {
      insertInTx: vi.fn(async () => tokenInsertResult),
    } as unknown as ChangeContactEmailDeps['tokens'],
    emails: {
      enqueueInTx: vi.fn(async () => emailEnqueueResult),
    } as unknown as ChangeContactEmailDeps['emails'],
    audit: {
      record: vi.fn(async () => ok(undefined)),
      recordInTx: vi.fn(async () => ok(undefined)),
    } as unknown as ChangeContactEmailDeps['audit'],
    clock: { now: () => new Date('2026-04-15T10:00:00Z') },
  };
}

const baseInput = {
  contactId,
  newEmailRaw: 'alice@new.com',
  actorUserId: userId,
  requestId: 'req-001',
  locale: 'en' as const,
};

describe('changeContactEmail — validation', () => {
  it('returns invalid_input for a malformed email', async () => {
    const result = await changeContactEmail(makeDeps(), {
      ...baseInput,
      newEmailRaw: 'not-an-email',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('invalid_input');
    }
  });
});

describe('changeContactEmail — contact lookup failures', () => {
  it('returns not_found when contact is missing', async () => {
    const result = await changeContactEmail(
      makeDeps({ findByIdResult: err({ code: 'repo.not_found' }) }),
      baseInput,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('not_found');
  });

  it('returns server_error on unexpected repo error', async () => {
    const result = await changeContactEmail(
      makeDeps({ findByIdResult: err({ code: 'repo.unexpected', cause: new Error('db down') }) }),
      baseInput,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('server_error');
  });

  it('returns not_found when contact has no linkedUserId', async () => {
    const result = await changeContactEmail(
      makeDeps({ findByIdResult: ok(makeContact({ linkedUserId: null })) }),
      baseInput,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('not_found');
  });
});

describe('changeContactEmail — transaction port failures', () => {
  it('returns not_found when contactRepo.updateEmailInTx throws repo.not_found', async () => {
    const result = await changeContactEmail(
      makeDeps({ contactUpdateResult: err({ code: 'repo.not_found' }) }),
      baseInput,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('not_found');
  });

  it('returns conflict when contactRepo.updateEmailInTx throws repo.conflict', async () => {
    const result = await changeContactEmail(
      makeDeps({
        contactUpdateResult: err({ code: 'repo.conflict', reason: 'email_taken' }),
      }),
      baseInput,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('conflict');
      if (result.error.code === 'conflict') {
        expect(result.error.reason).toBe('email_taken');
      }
    }
  });

  it('returns server_error when userEmails.updateInTx fails', async () => {
    const result = await changeContactEmail(
      makeDeps({
        userUpdateResult: err({ code: 'repo.unexpected', cause: new Error('user update failed') }),
      }),
      baseInput,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('server_error');
  });

  it('returns server_error when sessions.revokeAllForInTx fails', async () => {
    const result = await changeContactEmail(
      makeDeps({
        sessionResult: err({ code: 'repo.unexpected' }),
      }),
      baseInput,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('server_error');
  });

  it('returns server_error when tokens.insertInTx (verification) fails', async () => {
    const result = await changeContactEmail(
      makeDeps({
        tokenInsertResult: err({ code: 'repo.unexpected' }),
      }),
      baseInput,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('server_error');
  });

  it('returns server_error when emails.enqueueInTx fails', async () => {
    const result = await changeContactEmail(
      makeDeps({
        emailEnqueueResult: err({ code: 'repo.unexpected' }),
      }),
      baseInput,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('server_error');
  });

  it('returns server_error when revert tokens.insertInTx (second call) fails', async () => {
    const deps = makeDeps();
    (deps.emails.enqueueInTx as ReturnType<typeof vi.fn>)
      .mockResolvedValue(ok({ outboxRowId: 'outbox-v' }));
    (deps.tokens.insertInTx as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(ok(undefined))
      .mockResolvedValueOnce(err({ code: 'repo.unexpected' }));
    const result = await changeContactEmail(deps, baseInput);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('server_error');
  });

  it('returns server_error when revert emails.enqueueInTx (second call) fails', async () => {
    const deps = makeDeps();
    (deps.tokens.insertInTx as ReturnType<typeof vi.fn>)
      .mockResolvedValue(ok(undefined));
    (deps.emails.enqueueInTx as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(ok({ outboxRowId: 'outbox-v' }))
      .mockResolvedValueOnce(err({ code: 'repo.unexpected' }));
    const result = await changeContactEmail(deps, baseInput);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('server_error');
  });

  it('returns server_error on unhandled exception inside tx', async () => {
    const deps = makeDeps();
    (deps.contactRepo.updateEmailInTx as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('unexpected crash'),
    );
    const result = await changeContactEmail(deps, baseInput);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('server_error');
  });

  it('returns server_error when audit.recordInTx fails (final tx step)', async () => {
    const deps = makeDeps();
    // Drive the entire happy path until step (vi+audit) — first 5 ports
    // succeed, audit returns repo.unexpected → use case must rollback
    // and surface server_error. Closes the last branch in
    // change-contact-email.ts (line 253) so the file hits 100% branch
    // coverage per the F3 threshold.
    (deps.tokens.insertInTx as ReturnType<typeof vi.fn>).mockResolvedValue(
      ok(undefined),
    );
    (deps.emails.enqueueInTx as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(ok({ outboxRowId: 'outbox-v' }))
      .mockResolvedValueOnce(ok({ outboxRowId: 'outbox-r' }));
    (deps.audit.recordInTx as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      err({ code: 'repo.unexpected', cause: new Error('audit insert failed') }),
    );
    const result = await changeContactEmail(deps, baseInput);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('server_error');
  });
});

describe('changeContactEmail — happy path', () => {
  let deps: ChangeContactEmailDeps;

  beforeEach(() => {
    vi.clearAllMocks();
    // Token inserts called twice (verification + revert), enqueue called twice.
    deps = makeDeps({
      emailEnqueueResult: ok({ outboxRowId: 'outbox-v' }),
    });
    // Second call to enqueueInTx returns a different outbox ID.
    (deps.emails.enqueueInTx as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(ok({ outboxRowId: 'outbox-v' }))
      .mockResolvedValueOnce(ok({ outboxRowId: 'outbox-r' }));
    (deps.tokens.insertInTx as ReturnType<typeof vi.fn>)
      .mockResolvedValue(ok(undefined));
  });

  it('returns ok with expected shape', async () => {
    const result = await changeContactEmail(deps, baseInput);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.contactId).toBe(contactId);
      expect(result.value.userId).toBe(userId);
      expect(result.value.newEmail).toBe('alice@new.com');
      expect(result.value.oldEmail).toBe('alice@old.com');
      expect(result.value.sessionsRevoked).toBe(2);
      expect(result.value.verificationOutboxRowId).toBe('outbox-v');
      expect(result.value.revertOutboxRowId).toBe('outbox-r');
    }
  });

  it('writes an audit row via AuditPort.recordInTx inside the transaction', async () => {
    await changeContactEmail(deps, baseInput);
    expect(deps.audit.recordInTx).toHaveBeenCalledWith(
      expect.anything(),
      deps.tenant,
      expect.objectContaining({ type: 'member_contact_email_changed' }),
    );
  });

  it('revokes sessions inside the transaction', async () => {
    await changeContactEmail(deps, baseInput);
    expect(deps.sessions.revokeAllForInTx).toHaveBeenCalledWith(
      stubTx,
      userId,
      'email_change',
    );
  });
});
