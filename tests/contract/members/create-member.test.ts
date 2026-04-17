/**
 * T040 — Contract test: POST /api/members (US1).
 *
 * Mocks the admin-context, idempotency helpers, tenant resolver, and the
 * `createMember` use case from `@/modules/members` so the handler runs
 * without touching the real DB / session. Asserts the response shape +
 * HTTP status for each branch of the route handler.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { ok, err } from '@/lib/result';

const requireAdminContextMock = vi.fn();
const createMemberMock = vi.fn();
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
    createMember: (...args: unknown[]) => createMemberMock(...args),
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

const validBody = {
  company_name: 'Fogmaker International',
  country: 'SE',
  plan_id: 'premium',
  plan_year: 2026,
  primary_contact: {
    first_name: 'Anna',
    last_name: 'Andersson',
    email: 'anna@fogmaker.se',
    preferred_language: 'sv' as const,
  },
};

function makeRequest(
  body: unknown,
  headers: Record<string, string> = { 'idempotency-key': 'idem-1' },
): NextRequest {
  return new NextRequest('http://localhost/api/members', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

describe('contract: POST /api/members (T040)', () => {
  afterEach(() => vi.clearAllMocks());

  it('201 happy path — returns member_id + primary_contact_id', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    buildMembersDepsMock.mockReturnValueOnce({});
    createMemberMock.mockResolvedValueOnce(
      ok({ memberId: 'mem-1', contactId: 'con-1' }),
    );
    const { POST } = await import('@/app/api/members/route');
    const res = await POST(makeRequest(validBody));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.member_id).toBe('mem-1');
    expect(body.primary_contact_id).toBe('con-1');
  });

  it('400 missing Idempotency-Key', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    buildMembersDepsMock.mockReturnValueOnce({});
    const { POST } = await import('@/app/api/members/route');
    const res = await POST(makeRequest(validBody, {}));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('missing_idempotency_key');
  });

  it('400 invalid_body when zod rejects payload', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    buildMembersDepsMock.mockReturnValueOnce({});
    createMemberMock.mockResolvedValueOnce(
      err({
        type: 'invalid_body',
        issues: [{ path: 'company_name', message: 'Required' }],
      }),
    );
    const { POST } = await import('@/app/api/members/route');
    const res = await POST(makeRequest({}));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('invalid_body');
  });

  it('404 plan_not_found', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    buildMembersDepsMock.mockReturnValueOnce({});
    createMemberMock.mockResolvedValueOnce(err({ type: 'plan_not_found' }));
    const { POST } = await import('@/app/api/members/route');
    const res = await POST(makeRequest(validBody));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe('plan_not_found');
  });

  it('409 soft_duplicate — gives the caller the existing member id', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    buildMembersDepsMock.mockReturnValueOnce({});
    createMemberMock.mockResolvedValueOnce(
      err({
        type: 'soft_duplicate',
        existingMemberId: 'mem-old',
        existingCompanyName: 'Fogmaker International',
      }),
    );
    const { POST } = await import('@/app/api/members/route');
    const res = await POST(makeRequest(validBody));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe('soft_duplicate');
    expect(body.error.details.existingMemberId).toBe('mem-old');
  });

  it('422 turnover_warning — admin must re-submit with override_reason', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    buildMembersDepsMock.mockReturnValueOnce({});
    createMemberMock.mockResolvedValueOnce(
      err({
        type: 'turnover_out_of_band',
        turnoverThb: 500,
        band: { minThb: 1000, maxThb: 10000 },
      }),
    );
    const { POST } = await import('@/app/api/members/route');
    const res = await POST(makeRequest(validBody));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error.code).toBe('turnover_warning');
  });
});
