/**
 * T134 — Contract test: POST /api/members/[memberId]/archive +
 * POST /api/members/[memberId]/undelete (US7).
 *
 * Mocks the admin-context, idempotency helpers, tenant resolver, and the
 * `archiveMember` + `undeleteMember` use cases so the handlers run
 * without touching the real DB / session. Asserts response shape +
 * HTTP status for each branch.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { ok, err } from '@/lib/result';

const requireAdminContextMock = vi.fn();
const archiveMemberMock = vi.fn();
const undeleteMemberMock = vi.fn();
const buildMembersDepsMock = vi.fn();

vi.mock('@/lib/admin-context', () => ({
  requireAdminContext: (...args: unknown[]) => requireAdminContextMock(...args),
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
    archiveMember: (...args: unknown[]) => archiveMemberMock(...args),
    undeleteMember: (...args: unknown[]) => undeleteMemberMock(...args),
  };
});
vi.mock('@/lib/tenant-context', () => ({
  resolveTenantFromRequest: () => ({ slug: 'test-swecham', __brand: true }),
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
    user: {
      id: 'admin-1',
      email: 'a@b.co',
      role: 'admin',
      status: 'active',
      displayName: 'A',
    },
    session: { id: 's1' },
  },
  sourceIp: '203.0.113.5',
  requestId: 'req-1',
};

const MEMBER_ID = '11111111-1111-4111-8111-111111111111';

function makeRequest(
  path: string,
  body: unknown,
  headers: Record<string, string> = { 'idempotency-key': 'idem-1' },
): NextRequest {
  if (body === undefined) {
    return new NextRequest(`http://localhost${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
    });
  }
  return new NextRequest(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

const archivedMember = {
  tenantId: 'test-swecham',
  memberId: MEMBER_ID,
  companyName: 'Fogmaker International',
  legalEntityType: null,
  country: 'SE',
  taxId: null,
  website: null,
  description: null,
  foundedYear: null,
  turnoverThb: null,
  planId: 'premium',
  planYear: 2026,
  registrationDate: new Date('2026-01-01'),
  registrationFeePaid: false,
  lastActivityAt: new Date('2026-04-01'),
  notes: null,
  status: 'archived' as const,
  archivedAt: new Date('2026-04-10'),
  createdAt: new Date('2026-01-01'),
  updatedAt: new Date('2026-04-10'),
};

const activeMember = { ...archivedMember, status: 'active' as const, archivedAt: null };

describe('contract: POST /api/members/[memberId]/archive (T134)', () => {
  afterEach(() => vi.clearAllMocks());

  async function invokeArchive(body: unknown, headers?: Record<string, string>) {
    const { POST } = await import(
      '@/app/api/members/[memberId]/archive/route'
    );
    return POST(makeRequest(`/api/members/${MEMBER_ID}/archive`, body, headers), {
      params: Promise.resolve({ memberId: MEMBER_ID }),
    });
  }

  it('200 happy path — archive succeeds', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    buildMembersDepsMock.mockReturnValueOnce({});
    archiveMemberMock.mockResolvedValueOnce(ok(archivedMember));
    const res = await invokeArchive({ reason: 'Company closed' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('archived');
    expect(body.member_id).toBe(MEMBER_ID);
  });

  it('200 happy path without reason (empty body allowed)', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    buildMembersDepsMock.mockReturnValueOnce({});
    archiveMemberMock.mockResolvedValueOnce(ok(archivedMember));
    const res = await invokeArchive({});
    expect(res.status).toBe(200);
  });

  it('400 missing Idempotency-Key', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    const res = await invokeArchive({}, {});
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('missing_idempotency_key');
  });

  it('400 invalid_body when zod rejects payload', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    buildMembersDepsMock.mockReturnValueOnce({});
    archiveMemberMock.mockResolvedValueOnce(
      err({
        type: 'invalid_body',
        issues: [{ path: 'reason', message: 'Too long' }],
      }),
    );
    const res = await invokeArchive({ reason: 'x'.repeat(501) });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('invalid_body');
  });

  it('404 not_found — cross-tenant or missing member', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    buildMembersDepsMock.mockReturnValueOnce({});
    archiveMemberMock.mockResolvedValueOnce(err({ type: 'not_found' }));
    const res = await invokeArchive({});
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe('not_found');
  });

  it('409 state_error — already archived', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    buildMembersDepsMock.mockReturnValueOnce({});
    archiveMemberMock.mockResolvedValueOnce(
      err({
        type: 'state_error',
        code: 'state.cannot_archive_already_archived',
      }),
    );
    const res = await invokeArchive({});
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe('state_error');
  });

  it('500 server_error on unexpected failure', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    buildMembersDepsMock.mockReturnValueOnce({});
    archiveMemberMock.mockResolvedValueOnce(
      err({ type: 'server_error', message: 'boom' }),
    );
    const res = await invokeArchive({});
    expect(res.status).toBe(500);
  });
});

describe('contract: POST /api/members/[memberId]/undelete (T134)', () => {
  afterEach(() => vi.clearAllMocks());

  async function invokeUndelete(headers?: Record<string, string>) {
    const { POST } = await import(
      '@/app/api/members/[memberId]/undelete/route'
    );
    return POST(
      makeRequest(`/api/members/${MEMBER_ID}/undelete`, undefined, headers),
      { params: Promise.resolve({ memberId: MEMBER_ID }) },
    );
  }

  it('200 happy path — undelete succeeds', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    buildMembersDepsMock.mockReturnValueOnce({});
    undeleteMemberMock.mockResolvedValueOnce(ok(activeMember));
    const res = await invokeUndelete();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('active');
  });

  it('400 missing Idempotency-Key', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    const res = await invokeUndelete({});
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('missing_idempotency_key');
  });

  it('403 archive_window_expired — > 90 days', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    buildMembersDepsMock.mockReturnValueOnce({});
    undeleteMemberMock.mockResolvedValueOnce(
      err({
        type: 'state_error',
        code: 'state.undelete_window_expired',
        daysSinceArchive: 95,
      }),
    );
    const res = await invokeUndelete();
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe('archive_window_expired');
    expect(body.error.details.daysSinceArchive).toBe(95);
  });

  it('404 not_found', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    buildMembersDepsMock.mockReturnValueOnce({});
    undeleteMemberMock.mockResolvedValueOnce(err({ type: 'not_found' }));
    const res = await invokeUndelete();
    expect(res.status).toBe(404);
  });

  it('409 state_error — not archived', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    buildMembersDepsMock.mockReturnValueOnce({});
    undeleteMemberMock.mockResolvedValueOnce(
      err({
        type: 'state_error',
        code: 'state.undelete_only_from_archived',
      }),
    );
    const res = await invokeUndelete();
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe('state_error');
  });

  it('500 server_error', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    buildMembersDepsMock.mockReturnValueOnce({});
    undeleteMemberMock.mockResolvedValueOnce(
      err({ type: 'server_error', message: 'boom' }),
    );
    const res = await invokeUndelete();
    expect(res.status).toBe(500);
  });
});
