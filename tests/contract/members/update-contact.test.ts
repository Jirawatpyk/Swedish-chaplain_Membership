/**
 * T071 partial — Contract test: PATCH /api/members/[memberId]/contacts/[contactId].
 *
 * Mocks the Application use cases. Verifies:
 *   - 200 non-email update → body is serialised contact
 *   - 409 when email is changed on an unlinked contact (US3.b.3 guard)
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

vi.mock('@/lib/admin-context', () => ({
  requireAdminContext: (...args: unknown[]) => requireAdminContextMock(...args),
}));

const contactRepoFindByIdMock = vi.fn();
vi.mock('@/modules/members/members-deps', () => ({
  buildMembersDeps: vi.fn(() => ({
    contactRepo: {
      // Called twice on the unlinked email path: once to route (linked vs
      // unlinked), once on the fall-through re-read for the response shape.
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
  rememberIdempotentResponse: vi.fn(async () => undefined),
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
    // 1st findById routes to the unlinked path; 2nd (fall-through re-read)
    // supplies the response body with the updated email.
    contactRepoFindByIdMock
      .mockResolvedValueOnce(ok(stubContact))
      .mockResolvedValueOnce(ok({ ...stubContact, email: 'new@example.com' }));
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
});
