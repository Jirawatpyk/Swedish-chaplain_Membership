/**
 * T071 partial — Contract test: PATCH /api/members/[memberId]/contacts/[contactId].
 *
 * Mocks the Application use cases. Verifies:
 *   - 200 non-email update → body is serialised contact
 *   - 200 in-place email update on an unlinked contact (the former US3.b.3
 *     409 guard was replaced by updateUnlinkedContactEmail — imported members
 *     have no portal login, so the email is a plain contact field)
 *   - 409 when the NEW email is already in use (unlinked path)
 *   - 400 invalid body (validation)
 *   - 404 on unknown contact
 *   - 401/403 auth gate pass-through
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { ok, err } from '@/lib/result';

const requireAdminContextMock = vi.fn();
const updateContactFieldsMock = vi.fn();
const changeContactEmailMock = vi.fn();
const updateUnlinkedContactEmailMock = vi.fn();
// Hoisted so the partial-save test can assert the 200 was persisted for replay
// (a fresh-key retry must NOT re-emit the committed email audit).
const rememberIdempotentResponseMock = vi.hoisted(() =>
  vi.fn(async () => undefined),
);

vi.mock('@/lib/admin-context', () => ({
  requireAdminContext: (...args: unknown[]) => requireAdminContextMock(...args),
}));

const contactRepoFindByIdMock = vi.fn();
vi.mock('@/modules/members/members-deps', () => ({
  buildMembersDeps: vi.fn(() => ({
    contactRepo: {
      // Called ONCE on the unlinked email path (route linked-vs-unlinked). The
      // unlinked path returns updateUnlinkedContactEmail's value directly (no
      // response re-read); only the LINKED path re-reads.
      findById: (...args: unknown[]) => contactRepoFindByIdMock(...args),
      update: vi.fn(async () => ok({})),
    },
    // Fields touched by the route code — present but not exercised.
    userEmails: {},
    sessions: {},
    tokens: {},
    emails: {},
    clock: { now: () => new Date() },
  })),
}));
vi.mock('@/modules/members', async () => {
  const actual = await vi.importActual<typeof import('@/modules/members')>(
    '@/modules/members',
  );
  return {
    ...actual,
    updateContactFields: (...args: unknown[]) => updateContactFieldsMock(...args),
    updateUnlinkedContactEmail: (...args: unknown[]) =>
      updateUnlinkedContactEmailMock(...args),
    changeContactEmail: (...args: unknown[]) => changeContactEmailMock(...args),
    // `removeContact` is defined by the barrel but not exercised here;
    // re-export it from the actual module so the import doesn't break.
    removeContact: actual.removeContact,
  };
});
vi.mock('@/lib/tenant-context', () => ({
  resolveTenantFromRequest: () => ({ slug: 'test', __brand: true }),
}));
vi.mock('@/lib/idempotency', () => ({
  parseIdempotencyKey: (headers: Headers) => {
    const key = headers.get('idempotency-key');
    if (!key) return { ok: false, reason: 'missing' };
    return { ok: true, key };
  },
  classifyIdempotencyRequest: vi.fn(async () => ({ kind: 'first' })),
  reserveIdempotencyRecord: vi.fn(async () => ({ ok: true, value: { kind: 'reserved' as const } })),
  rememberIdempotentResponse: rememberIdempotentResponseMock,
  hashRequestBody: vi.fn(() => 'hash'),
}));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

const adminContext = {
  current: {
    user: { id: 'admin-1', email: 'a@b.co', role: 'admin', status: 'active' },
    session: { id: 's1' },
  },
  sourceIp: '203.0.113.5',
  requestId: 'req-uc',
};

const memberId = '11111111-2222-3333-4444-555555555555';
const contactId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

const stubContact = {
  tenantId: 'test',
  contactId,
  memberId,
  firstName: 'Alice',
  lastName: 'A',
  email: 'alice@old.example',
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

const stubLinkedContact = { ...stubContact, linkedUserId: 'user-123' };

function makeRequest(body: unknown): NextRequest {
  return new NextRequest(
    `http://localhost/api/members/${memberId}/contacts/${contactId}`,
    {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': 'idem-uc',
      },
      body: JSON.stringify(body),
    },
  );
}

const routeParams = async () => ({ memberId, contactId });

describe('contract: PATCH /api/members/[memberId]/contacts/[contactId] (T071)', () => {
  afterEach(() => vi.clearAllMocks());

  it('200 on non-email update', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    updateContactFieldsMock.mockResolvedValueOnce(
      ok({ ...stubContact, firstName: 'Alicia' }),
    );
    const { PATCH } = await import(
      '@/app/api/members/[memberId]/contacts/[contactId]/route'
    );
    const res = await PATCH(makeRequest({ first_name: 'Alicia' }), {
      params: routeParams(),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.first_name).toBe('Alicia');
  });

  it('200 when email change requested on unlinked contact — in-place update', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    // findById routes to the unlinked path; the route then returns the
    // updateUnlinkedContactEmail value directly for the response body (no
    // fall-through re-read on the unlinked path — that avoids a post-commit
    // re-read whose transient failure would 404 a committed change).
    contactRepoFindByIdMock.mockResolvedValueOnce(ok(stubContact));
    updateUnlinkedContactEmailMock.mockResolvedValueOnce(
      ok({ ...stubContact, email: 'new@example.com' }),
    );
    const { PATCH } = await import(
      '@/app/api/members/[memberId]/contacts/[contactId]/route'
    );
    const res = await PATCH(makeRequest({ email: 'new@example.com' }), {
      params: routeParams(),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.email).toBe('new@example.com');
    // Regression guard (final-review MUST): the unlinked path must NOT re-read
    // for the response — it returns the use-case value in hand. A re-read would
    // let a transient failure 404 a committed change + skip the idempotency
    // record (duplicate audit on retry). findById is called exactly once here.
    expect(contactRepoFindByIdMock).toHaveBeenCalledTimes(1);
  });

  it('409 conflict when the new email is already in use (unlinked path)', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    contactRepoFindByIdMock.mockResolvedValue(ok(stubContact));
    updateUnlinkedContactEmailMock.mockResolvedValueOnce(
      err({ type: 'conflict', reason: 'email_taken' }),
    );
    const { PATCH } = await import(
      '@/app/api/members/[memberId]/contacts/[contactId]/route'
    );
    const res = await PATCH(makeRequest({ email: 'taken@example.com' }), {
      params: routeParams(),
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe('conflict');
  });

  it('400 validation_error when the new email is malformed (unlinked path)', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    contactRepoFindByIdMock.mockResolvedValue(ok(stubContact));
    updateUnlinkedContactEmailMock.mockResolvedValueOnce(
      err({ type: 'invalid_email' }),
    );
    const { PATCH } = await import(
      '@/app/api/members/[memberId]/contacts/[contactId]/route'
    );
    const res = await PATCH(makeRequest({ email: 'not-an-email' }), {
      params: routeParams(),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('validation_error');
  });

  it('400 invalid body', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    updateContactFieldsMock.mockResolvedValueOnce(
      err({
        type: 'invalid_body',
        issues: [{ path: 'first_name', message: 'too short' }],
      }),
    );
    const { PATCH } = await import(
      '@/app/api/members/[memberId]/contacts/[contactId]/route'
    );
    const res = await PATCH(makeRequest({ first_name: '' }), {
      params: routeParams(),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('invalid_body');
  });

  it('404 when use case reports not_found', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    updateContactFieldsMock.mockResolvedValueOnce(err({ type: 'not_found' }));
    const { PATCH } = await import(
      '@/app/api/members/[memberId]/contacts/[contactId]/route'
    );
    const res = await PATCH(makeRequest({ first_name: 'Alicia' }), {
      params: routeParams(),
    });
    expect(res.status).toBe(404);
  });

  it('401 when no session — admin-context short-circuits', async () => {
    const { NextResponse } = await import('next/server');
    requireAdminContextMock.mockResolvedValueOnce({
      response: NextResponse.json({ error: 'no-session' }, { status: 401 }),
    });
    const { PATCH } = await import(
      '@/app/api/members/[memberId]/contacts/[contactId]/route'
    );
    const res = await PATCH(makeRequest({ first_name: 'X' }), {
      params: routeParams(),
    });
    expect(res.status).toBe(401);
  });

  // --- Linked-user email-change branch (FR-012a atomic txn) ------------------

  it('200 on linked-user email change — changeContactEmail success', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    contactRepoFindByIdMock.mockResolvedValue(ok(stubLinkedContact));
    changeContactEmailMock.mockResolvedValueOnce(
      ok({
        contactId,
        userId: 'user-123',
        oldEmail: 'alice@old.example',
        newEmail: 'alice@new.example',
        verificationOutboxRowId: 'outbox-v',
        revertOutboxRowId: 'outbox-r',
        sessionsRevoked: 2,
      }),
    );
    const { PATCH } = await import(
      '@/app/api/members/[memberId]/contacts/[contactId]/route'
    );
    const res = await PATCH(
      makeRequest({ email: 'alice@new.example' }),
      { params: routeParams() },
    );
    // After email change the route re-reads the contact for the
    // response shape. changeContactEmailMock ok → route falls through
    // to the non-email path which re-fetches via contactRepo.findById.
    expect(res.status).toBe(200);
    expect(changeContactEmailMock).toHaveBeenCalledTimes(1);
  });

  it('400 on linked-user email change — invalid_input', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    contactRepoFindByIdMock.mockResolvedValueOnce(ok(stubLinkedContact));
    changeContactEmailMock.mockResolvedValueOnce(
      err({ code: 'invalid_input', field: 'email' }),
    );
    const { PATCH } = await import(
      '@/app/api/members/[memberId]/contacts/[contactId]/route'
    );
    const res = await PATCH(makeRequest({ email: 'not-an-email' }), {
      params: routeParams(),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('validation_error');
    expect(body.error.details.field).toBe('email');
  });

  it('404 on linked-user email change — not_found', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    contactRepoFindByIdMock.mockResolvedValueOnce(ok(stubLinkedContact));
    changeContactEmailMock.mockResolvedValueOnce(err({ code: 'not_found' }));
    const { PATCH } = await import(
      '@/app/api/members/[memberId]/contacts/[contactId]/route'
    );
    const res = await PATCH(makeRequest({ email: 'alice@new.example' }), {
      params: routeParams(),
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe('not_found');
  });

  it('409 on linked-user email change — conflict (email_taken)', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    contactRepoFindByIdMock.mockResolvedValueOnce(ok(stubLinkedContact));
    changeContactEmailMock.mockResolvedValueOnce(
      err({ code: 'conflict', reason: 'email_taken' }),
    );
    const { PATCH } = await import(
      '@/app/api/members/[memberId]/contacts/[contactId]/route'
    );
    const res = await PATCH(makeRequest({ email: 'taken@example.com' }), {
      params: routeParams(),
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe('conflict');
    expect(body.error.reason).toBe('email_taken');
  });

  it('500 on linked-user email change — server_error', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    contactRepoFindByIdMock.mockResolvedValueOnce(ok(stubLinkedContact));
    changeContactEmailMock.mockResolvedValueOnce(
      err({ code: 'server_error', cause: new Error('db timeout') }),
    );
    const { PATCH } = await import(
      '@/app/api/members/[memberId]/contacts/[contactId]/route'
    );
    const res = await PATCH(makeRequest({ email: 'alice@new.example' }), {
      params: routeParams(),
    });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe('server_error');
  });

  // --- Partial-save marker (finding 6/8) -------------------------------------
  // A combined PATCH runs email (section 1) then non-email fields (section 2)
  // as two txns. When section 1 commits but section 2 fails, return 200 with
  // the email-updated contact + a `field_update_failed` marker so the admin
  // knows the email persisted (and a retry replays via rememberIdempotentResponse
  // rather than re-emitting the email audit).

  it('200 + field_update_failed when unlinked email commits but field update fails', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    contactRepoFindByIdMock.mockResolvedValueOnce(ok(stubContact)); // unlinked
    updateUnlinkedContactEmailMock.mockResolvedValueOnce(
      ok({ ...stubContact, email: 'new@example.com' }),
    );
    updateContactFieldsMock.mockResolvedValueOnce(err({ type: 'server_error' }));
    const { PATCH } = await import(
      '@/app/api/members/[memberId]/contacts/[contactId]/route'
    );
    const res = await PATCH(
      makeRequest({ email: 'new@example.com', first_name: 'Alicia' }),
      { params: routeParams() },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    // The committed email is reflected; the marker names the failed section.
    expect(body.email).toBe('new@example.com');
    expect(body.field_update_failed).toBe('server_error');
    // The unlinked path returns the use-case value in hand — no re-read.
    expect(contactRepoFindByIdMock).toHaveBeenCalledTimes(1);
    // Persist the 200 so a fresh-key retry replays it (no duplicate email audit).
    expect(rememberIdempotentResponseMock).toHaveBeenCalledTimes(1);
  });

  it('200 + field_update_failed when linked email commits but field update fails (re-reads)', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    contactRepoFindByIdMock
      .mockResolvedValueOnce(ok(stubLinkedContact)) // section 1 lookup → linked
      .mockResolvedValueOnce(
        ok({ ...stubLinkedContact, email: 'alice@new.example' }),
      ); // partial-save re-read for the response shape
    changeContactEmailMock.mockResolvedValueOnce(
      ok({
        contactId,
        userId: 'user-123',
        oldEmail: 'alice@old.example',
        newEmail: 'alice@new.example',
        verificationOutboxRowId: 'outbox-v',
        revertOutboxRowId: 'outbox-r',
        sessionsRevoked: 1,
      }),
    );
    updateContactFieldsMock.mockResolvedValueOnce(err({ type: 'server_error' }));
    const { PATCH } = await import(
      '@/app/api/members/[memberId]/contacts/[contactId]/route'
    );
    const res = await PATCH(
      makeRequest({ email: 'alice@new.example', first_name: 'Alicia', locale: 'th' }),
      { params: routeParams() },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.email).toBe('alice@new.example');
    expect(body.field_update_failed).toBe('server_error');
    expect(rememberIdempotentResponseMock).toHaveBeenCalledTimes(1);
  });

  it('field-only update that fails still returns the error (no partial-save marker)', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    updateContactFieldsMock.mockResolvedValueOnce(err({ type: 'server_error' }));
    const { PATCH } = await import(
      '@/app/api/members/[memberId]/contacts/[contactId]/route'
    );
    const res = await PATCH(makeRequest({ first_name: 'Alicia' }), {
      params: routeParams(),
    });
    // No email changed → the section-2 error is returned as-is (unaffected).
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe('server_error');
    expect(body.field_update_failed).toBeUndefined();
  });
});
