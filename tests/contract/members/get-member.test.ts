/**
 * Contract test: GET /api/members/[memberId]
 *
 * Mocks all dependencies. Verifies every HTTP response branch:
 *   - 200 on successful fetch (member + contacts serialised)
 *   - 401 when admin-context gate returns a short-circuit response
 *   - 404 when memberId is not a valid UUID
 *   - 404 when use case reports not_found (incl. cross-tenant probe)
 *   - 500 when use case reports server_error
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import { ok, err } from '@/lib/result';

// ---------------------------------------------------------------------------
// Hoist mocks
// ---------------------------------------------------------------------------

const requireAdminContextMock = vi.fn();
const getMemberMock = vi.fn();
const buildMembersDepsMock = vi.fn(() => ({
  contactRepo: {},
  tokens: {},
  emails: {},
  clock: { now: () => new Date() },
}));

vi.mock('@/lib/admin-context', () => ({
  requireAdminContext: requireAdminContextMock,
}));

vi.mock('@/modules/members/members-deps', () => ({
  buildMembersDeps: buildMembersDepsMock,
}));

vi.mock('@/modules/members', async () => {
  const actual = await vi.importActual<typeof import('@/modules/members')>(
    '@/modules/members',
  );
  return {
    ...actual,
    getMember: getMemberMock,
  };
});

vi.mock('@/lib/tenant-context', () => ({
  resolveTenantFromRequest: () => ({ slug: 'test-swecham', __brand: true }),
}));

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const adminContext = {
  current: {
    user: { id: 'admin-1', email: 'a@b.co', role: 'admin', status: 'active' },
    session: { id: 's1' },
  },
  sourceIp: '203.0.113.5',
  requestId: 'req-1',
};

const MEMBER_ID = '11111111-1111-1111-1111-111111111111';

function makeRequest(): NextRequest {
  return new NextRequest(
    `http://localhost:3100/api/members/${MEMBER_ID}`,
    { method: 'GET' },
  );
}

const routeParams = Promise.resolve({ memberId: MEMBER_ID });

const MEMBER_FIXTURE = {
  member: {
    memberId: MEMBER_ID,
    memberNumber: 42,
    tenantId: 'test-swecham',
    companyName: 'Fogmaker AB',
    legalEntityType: 'limited',
    country: 'SE',
    taxId: null,
    website: null,
    description: null,
    foundedYear: null,
    turnoverThb: null,
    planId: 'plan-1',
    planYear: 2026,
    registrationDate: new Date('2026-01-15'),
    registrationFeePaid: true,
    status: 'active',
    archivedAt: null,
    notes: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    lastActivityAt: null,
  },
  contacts: [
    {
      contactId: 'c1',
      memberId: MEMBER_ID,
      tenantId: 'test-swecham',
      firstName: 'Anna',
      lastName: 'Svensson',
      email: 'anna@fogmaker.se',
      phone: null,
      roleTitle: 'CEO',
      preferredLanguage: 'sv',
      isPrimary: true,
      dateOfBirth: null,
      linkedUserId: null,
      removedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  ],
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('contract: GET /api/members/[memberId]', () => {
  afterEach(() => vi.clearAllMocks());

  it('200 — returns serialised member with contacts on success', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    getMemberMock.mockResolvedValueOnce(ok(MEMBER_FIXTURE));

    const { GET } = await import('@/app/api/members/[memberId]/route');
    const res = await GET(makeRequest(), { params: routeParams });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.member_id).toBe(MEMBER_ID);
    // Human-readable display id — MUST be present in the admin payload
    // (design §8.3: serializer divergence already bit tax_id once).
    expect(body.member_number).toBe(42);
    expect(body.contacts).toHaveLength(1);
    expect(body.contacts[0].first_name).toBe('Anna');
  });

  it('401 — admin-context gate short-circuits before reaching use case', async () => {
    requireAdminContextMock.mockResolvedValueOnce({
      response: NextResponse.json(
        { error: { code: 'unauthenticated', message: 'Not signed in.' } },
        { status: 401 },
      ),
    });

    const { GET } = await import('@/app/api/members/[memberId]/route');
    const res = await GET(makeRequest(), { params: routeParams });

    expect(res.status).toBe(401);
    expect(getMemberMock).not.toHaveBeenCalled();
  });

  it('404 — invalid UUID memberId param', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);

    const { GET } = await import('@/app/api/members/[memberId]/route');
    const res = await GET(
      new NextRequest('http://localhost:3100/api/members/not-a-uuid', { method: 'GET' }),
      { params: Promise.resolve({ memberId: 'not-a-uuid' }) },
    );

    expect(res.status).toBe(404);
    expect(getMemberMock).not.toHaveBeenCalled();
  });

  it('404 — use case reports not_found (cross-tenant probe)', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    getMemberMock.mockResolvedValueOnce(err({ type: 'not_found' }));

    const { GET } = await import('@/app/api/members/[memberId]/route');
    const res = await GET(makeRequest(), { params: routeParams });

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe('not_found');
  });

  it('500 — use case reports server_error', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    getMemberMock.mockResolvedValueOnce(
      err({ type: 'server_error', message: 'db timeout' }),
    );

    const { GET } = await import('@/app/api/members/[memberId]/route');
    const res = await GET(makeRequest(), { params: routeParams });

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe('server_error');
  });
});
