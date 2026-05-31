/**
 * Contract test: POST /api/members/[memberId]/contacts (addContact).
 *
 * The add-contact route is now driven in production by the admin
 * ContactFormDialog (member detail page), but previously had no contract
 * coverage — only the PATCH (update-contact) route did. Mocks the
 * Application use case + idempotency layer and verifies the route's
 * status/body mapping:
 *   - 201 happy path → serialised contact
 *   - 400 missing Idempotency-Key
 *   - 400 invalid_body (zod)
 *   - 400 validation_error (domain invalid_email / invalid_phone)
 *   - 409 conflict
 *   - 500 server_error
 *   - 401 auth gate pass-through
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { ok, err } from '@/lib/result';

const requireAdminContextMock = vi.fn();
const addContactMock = vi.fn();

vi.mock('@/lib/admin-context', () => ({
  requireAdminContext: (...args: unknown[]) => requireAdminContextMock(...args),
}));

vi.mock('@/modules/members/members-deps', () => ({
  buildMembersDeps: vi.fn(() => ({})),
}));

vi.mock('@/modules/members', async () => {
  const actual = await vi.importActual<typeof import('@/modules/members')>(
    '@/modules/members',
  );
  return {
    ...actual,
    addContact: (...args: unknown[]) => addContactMock(...args),
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
  reserveIdempotencyRecord: vi.fn(async () => ({
    ok: true,
    value: { kind: 'reserved' as const },
  })),
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
  requestId: 'req-add',
};

const memberId = '11111111-2222-3333-4444-555555555555';
const contactId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

const createdContact = {
  tenantId: 'test',
  contactId,
  memberId,
  firstName: 'Bob',
  lastName: 'B',
  email: 'bob@example.com',
  phone: null,
  roleTitle: 'Finance',
  preferredLanguage: 'en' as const,
  isPrimary: false,
  dateOfBirth: null,
  linkedUserId: null,
  inviteBouncedAt: null,
  removedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

function makeRequest(
  body: unknown,
  opts: { idempotencyKey?: string | null } = {},
): NextRequest {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const key = opts.idempotencyKey === undefined ? 'idem-add' : opts.idempotencyKey;
  if (key) headers['idempotency-key'] = key;
  return new NextRequest(
    `http://localhost/api/members/${memberId}/contacts`,
    { method: 'POST', headers, body: JSON.stringify(body) },
  );
}

const routeParams = async () => ({ memberId });

const validBody = {
  first_name: 'Bob',
  last_name: 'B',
  email: 'bob@example.com',
  role_title: 'Finance',
  preferred_language: 'en',
};

describe('contract: POST /api/members/[memberId]/contacts (addContact)', () => {
  afterEach(() => vi.clearAllMocks());

  it('201 happy path → serialised contact', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    addContactMock.mockResolvedValueOnce(ok(createdContact));
    const { POST } = await import(
      '@/app/api/members/[memberId]/contacts/route'
    );
    const res = await POST(makeRequest(validBody), { params: routeParams() });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.contact_id).toBe(contactId);
    expect(body.first_name).toBe('Bob');
    expect(body.role_title).toBe('Finance');
    expect(body.is_primary).toBe(false);
  });

  it('400 when Idempotency-Key header is missing', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    const { POST } = await import(
      '@/app/api/members/[memberId]/contacts/route'
    );
    const res = await POST(makeRequest(validBody, { idempotencyKey: null }), {
      params: routeParams(),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('missing_idempotency_key');
    expect(addContactMock).not.toHaveBeenCalled();
  });

  it('400 invalid_body (zod shape)', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    addContactMock.mockResolvedValueOnce(
      err({
        type: 'invalid_body',
        issues: [{ path: 'first_name', message: 'required' }],
      }),
    );
    const { POST } = await import(
      '@/app/api/members/[memberId]/contacts/route'
    );
    const res = await POST(makeRequest({ last_name: 'B' }), {
      params: routeParams(),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('invalid_body');
  });

  it('400 validation_error on invalid_email', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    addContactMock.mockResolvedValueOnce(err({ type: 'invalid_email' }));
    const { POST } = await import(
      '@/app/api/members/[memberId]/contacts/route'
    );
    const res = await POST(
      makeRequest({ ...validBody, email: 'not-an-email' }),
      { params: routeParams() },
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('validation_error');
  });

  it('409 conflict', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    addContactMock.mockResolvedValueOnce(
      err({ type: 'conflict', reason: 'duplicate' }),
    );
    const { POST } = await import(
      '@/app/api/members/[memberId]/contacts/route'
    );
    const res = await POST(makeRequest(validBody), { params: routeParams() });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe('conflict');
  });

  it('500 server_error', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    addContactMock.mockResolvedValueOnce(
      err({ type: 'server_error', message: 'boom' }),
    );
    const { POST } = await import(
      '@/app/api/members/[memberId]/contacts/route'
    );
    const res = await POST(makeRequest(validBody), { params: routeParams() });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe('server_error');
  });

  it('401 when admin-context short-circuits (auth gate)', async () => {
    const { NextResponse } = await import('next/server');
    requireAdminContextMock.mockResolvedValueOnce({
      response: NextResponse.json({ error: 'no-session' }, { status: 401 }),
    });
    const { POST } = await import(
      '@/app/api/members/[memberId]/contacts/route'
    );
    const res = await POST(makeRequest(validBody), { params: routeParams() });
    expect(res.status).toBe(401);
    expect(addContactMock).not.toHaveBeenCalled();
  });
});
