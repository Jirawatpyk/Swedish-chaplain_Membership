/**
 * T114 — Contract test: GET + PATCH /api/portal/profile (US5).
 *
 * Mocks the member-context, tenant resolver, and the use cases so the
 * handler runs without touching the real DB / session. Asserts response
 * shape + HTTP status for each branch.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { ok, err } from '@/lib/result';

// --- Mocks -------------------------------------------------------------------

const requireMemberContextMock = vi.fn();
const getMemberMock = vi.fn();
const memberSelfUpdateMock = vi.fn();
const buildMembersDepsMock = vi.fn();

vi.mock('@/lib/member-context', () => ({
  requireMemberContext: (...args: unknown[]) =>
    requireMemberContextMock(...args),
}));
vi.mock('@/modules/members/members-deps', () => ({
  buildMembersDeps: (...args: unknown[]) => buildMembersDepsMock(...args),
}));
vi.mock('@/modules/members', async () => {
  const actual = await vi.importActual<typeof import('@/modules/members')>(
    '@/modules/members',
  );
  return {
    ...actual,
    getMember: (...args: unknown[]) => getMemberMock(...args),
  };
});
vi.mock(
  '@/modules/members/application/use-cases/member-self-update',
  async () => {
    const actual = await vi.importActual<
      typeof import('@/modules/members/application/use-cases/member-self-update')
    >('@/modules/members/application/use-cases/member-self-update');
    return {
      ...actual,
      memberSelfUpdate: (...args: unknown[]) =>
        memberSelfUpdateMock(...args),
    };
  },
);
vi.mock('@/lib/idempotency', () => ({
  parseIdempotencyKey: (headers: Headers) => {
    const key = headers.get('idempotency-key');
    if (!key) return { ok: false, reason: 'missing' };
    return { ok: true, key };
  },
}));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

// --- Test fixtures -----------------------------------------------------------

const now = new Date('2026-04-16T10:00:00Z');

const memberContext = {
  current: {
    user: {
      id: 'user-1',
      email: 'member@example.com',
      role: 'member',
      status: 'active',
      displayName: 'Test Member',
    },
    session: { id: 's-1' },
  },
  tenant: { slug: 'test-swecham', __brand: true },
  member: {
    memberId: 'mem-1',
    companyName: 'Test Corp',
    legalEntityType: null,
    country: 'TH',
    website: null,
    description: null,
    planId: 'plan-1',
    planYear: 2026,
    registrationDate: now,
    registrationFeePaid: false,
    status: 'active',
    lastActivityAt: null,
    notes: null,
    taxId: null,
    foundedYear: null,
    turnoverThb: null,
    archivedAt: null,
    tenantId: 'test-swecham',
    createdAt: now,
    updatedAt: now,
  },
  memberId: 'mem-1',
  primaryContact: {
    contactId: 'con-1',
    memberId: 'mem-1',
    tenantId: 'test-swecham',
    firstName: 'Test',
    lastName: 'User',
    email: 'member@example.com',
    phone: null,
    roleTitle: null,
    preferredLanguage: 'en',
    isPrimary: true,
    dateOfBirth: null,
    linkedUserId: 'user-1',
    removedAt: null,
    createdAt: now,
    updatedAt: now,
  },
  primaryContactId: 'con-1',
  sourceIp: '127.0.0.1',
  requestId: 'req-1',
};

const mockDeps = {
  memberRepo: {},
  contactRepo: {},
  audit: {},
};

// --- Helpers -----------------------------------------------------------------

function makeGetRequest(): NextRequest {
  return new NextRequest('http://localhost/api/portal/profile', {
    method: 'GET',
  });
}

function makePatchRequest(
  body: unknown,
  headers: Record<string, string> = { 'idempotency-key': 'idem-1' },
): NextRequest {
  return new NextRequest('http://localhost/api/portal/profile', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

// --- Tests -------------------------------------------------------------------

describe('contract: GET /api/portal/profile (T114)', () => {
  afterEach(() => vi.clearAllMocks());

  it('200 returns member + contacts (notes redacted)', async () => {
    requireMemberContextMock.mockResolvedValueOnce(memberContext);
    buildMembersDepsMock.mockReturnValueOnce(mockDeps);
    getMemberMock.mockResolvedValueOnce(
      ok({
        member: memberContext.member,
        contacts: [memberContext.primaryContact],
      }),
    );
    const { GET } = await import('@/app/api/portal/profile/route');
    const res = await GET(makeGetRequest());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.member_id).toBe('mem-1');
    expect(body.company_name).toBe('Test Corp');
    // Notes MUST be omitted (contract #12 redaction)
    expect(body.notes).toBeUndefined();
    expect(body.contacts).toHaveLength(1);
    expect(body.contacts[0].contact_id).toBe('con-1');
  });

  it('401 when no session', async () => {
    requireMemberContextMock.mockResolvedValueOnce({
      response: new Response(JSON.stringify({ error: 'no-session' }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      }),
    });
    const { GET } = await import('@/app/api/portal/profile/route');
    const res = await GET(makeGetRequest());
    expect(res.status).toBe(401);
  });

  it('403 when non-member role', async () => {
    requireMemberContextMock.mockResolvedValueOnce({
      response: new Response(JSON.stringify({ error: 'forbidden' }), {
        status: 403,
        headers: { 'content-type': 'application/json' },
      }),
    });
    const { GET } = await import('@/app/api/portal/profile/route');
    const res = await GET(makeGetRequest());
    expect(res.status).toBe(403);
  });
});

describe('contract: PATCH /api/portal/profile (T114)', () => {
  afterEach(() => vi.clearAllMocks());

  it('200 updates whitelisted fields', async () => {
    requireMemberContextMock.mockResolvedValueOnce(memberContext);
    buildMembersDepsMock.mockReturnValueOnce(mockDeps);
    memberSelfUpdateMock.mockResolvedValueOnce(
      ok({
        member: { ...memberContext.member, website: 'https://new.com' },
        contact: memberContext.primaryContact,
      }),
    );
    const { PATCH } = await import('@/app/api/portal/profile/route');
    const res = await PATCH(
      makePatchRequest({ website: 'https://new.com' }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.website).toBe('https://new.com');
  });

  it('400 missing Idempotency-Key', async () => {
    requireMemberContextMock.mockResolvedValueOnce(memberContext);
    const { PATCH } = await import('@/app/api/portal/profile/route');
    const res = await PATCH(
      makePatchRequest({ website: 'https://x.com' }, {}),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('missing_idempotency_key');
  });

  it('403 forbidden-field rejection with audit (FR-014)', async () => {
    requireMemberContextMock.mockResolvedValueOnce(memberContext);
    buildMembersDepsMock.mockReturnValueOnce(mockDeps);
    memberSelfUpdateMock.mockResolvedValueOnce(
      err({
        type: 'forbidden',
        reason: 'forbidden fields: plan_id, status',
      }),
    );
    const { PATCH } = await import('@/app/api/portal/profile/route');
    const res = await PATCH(
      makePatchRequest({ plan_id: 'hacked', status: 'active' }),
    );
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe('forbidden');
  });

  it('400 validation_error on bad input', async () => {
    requireMemberContextMock.mockResolvedValueOnce(memberContext);
    buildMembersDepsMock.mockReturnValueOnce(mockDeps);
    memberSelfUpdateMock.mockResolvedValueOnce(
      err({
        type: 'validation_error',
        issues: [{ path: ['primary_contact', 'phone'], message: 'invalid' }],
      }),
    );
    const { PATCH } = await import('@/app/api/portal/profile/route');
    const res = await PATCH(
      makePatchRequest({ primary_contact: { phone: 'bad' } }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('validation_error');
  });
});
