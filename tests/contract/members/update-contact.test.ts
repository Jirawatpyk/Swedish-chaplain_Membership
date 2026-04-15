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

vi.mock('@/lib/admin-context', () => ({
  requireAdminContext: (...args: unknown[]) => requireAdminContextMock(...args),
}));

const contactRepoFindByIdMock = vi.fn();
vi.mock('@/modules/members/members-deps', () => ({
  buildMembersDeps: vi.fn(() => ({
    contactRepo: {
      findById: (...args: unknown[]) => contactRepoFindByIdMock(...args),
      // The "no linked user" branch of the route calls `update` as a
      // fallback before returning 409; stub to ok() so the flow reaches
      // the 409 response.
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
  reserveIdempotencyRecord: vi.fn(async () => undefined),
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

  it('409 when email change requested on unlinked contact (US3.b.3 guard)', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    contactRepoFindByIdMock.mockResolvedValueOnce(ok(stubContact));
    const { PATCH } = await import(
      '@/app/api/members/[memberId]/contacts/[contactId]/route'
    );
    const res = await PATCH(makeRequest({ email: 'new@example.com' }), {
      params: routeParams(),
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe('not_supported');
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
});
