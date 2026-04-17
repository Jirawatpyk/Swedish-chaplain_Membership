/**
 * T099 — Contract test: POST /api/members/bulk (US4).
 *
 * Covers:
 *   - 200 happy path (archive action)
 *   - 200 happy path (change_plan action)
 *   - 400 bulk_cap_exceeded (>100 member_ids)
 *   - 400 missing Idempotency-Key
 *   - 429 rate-limited
 *   - 403 non-admin rejected
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { ok, err } from '@/lib/result';

const requireAdminContextMock = vi.fn();
const bulkActionMock = vi.fn();
const rateLimitCheckMock = vi.fn();

vi.mock('@/lib/admin-context', () => ({
  requireAdminContext: (...args: unknown[]) => requireAdminContextMock(...args),
}));
const auditRecordMock = vi.fn().mockResolvedValue({ ok: true, value: undefined });
vi.mock('@/modules/members/members-deps', () => ({
  buildMembersDeps: vi.fn(() => ({
    tenant: { slug: 'test' },
    memberRepo: {},
    contactRepo: {},
    audit: { record: auditRecordMock, recordInTx: auditRecordMock },
    plans: {},
    emails: {},
    sessions: {},
    userEmails: {},
    tokens: {},
    clock: { now: () => new Date() },
    idFactory: { memberId: () => 'id', contactId: () => 'id' },
  })),
}));
vi.mock('@/modules/members', async () => {
  const actual = await vi.importActual<typeof import('@/modules/members')>(
    '@/modules/members',
  );
  return {
    ...actual,
    bulkAction: (...args: unknown[]) => bulkActionMock(...args),
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
// Mock the rate limiter at both the barrel and the deep path to handle
// the import no matter which module resolution Vitest picks up.
vi.mock('@/modules/auth/infrastructure/rate-limit/upstash-rate-limiter', () => ({
  rateLimiter: { check: (...args: unknown[]) => rateLimitCheckMock(...args) },
}));
vi.mock('@/modules/auth', async () => {
  const actual = await vi.importActual<typeof import('@/modules/auth')>(
    '@/modules/auth',
  );
  return {
    ...actual,
    rateLimiter: { check: (...args: unknown[]) => rateLimitCheckMock(...args) },
  };
});

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
  requestId: 'req-bulk-1',
};

const forbiddenContext = {
  response: new (await import('next/server')).NextResponse(
    JSON.stringify({ error: 'forbidden' }),
    { status: 403 },
  ),
};

function makeRequest(
  body: unknown,
  headers: Record<string, string> = { 'idempotency-key': 'idem-bulk' },
): NextRequest {
  return new NextRequest('http://localhost/api/members/bulk', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

describe('contract: POST /api/members/bulk (T099 / US4)', () => {
  afterEach(() => vi.clearAllMocks());

  it('200 on archive action — happy path', { timeout: 30_000 }, async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    rateLimitCheckMock.mockResolvedValueOnce({
      success: true,
      remaining: 9,
      reset: Date.now() + 600_000,
    });
    bulkActionMock.mockResolvedValueOnce(
      ok({ updatedCount: 3, auditEventCount: 3 }),
    );
    const { POST } = await import('@/app/api/members/bulk/route');
    const res = await POST(
      makeRequest({
        action: 'archive',
        member_ids: ['id-1', 'id-2', 'id-3'],
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.updated_count).toBe(3);
    expect(body.audit_event_count).toBe(3);
  });

  it('200 on change_plan action — happy path', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    rateLimitCheckMock.mockResolvedValueOnce({
      success: true,
      remaining: 8,
      reset: Date.now() + 600_000,
    });
    bulkActionMock.mockResolvedValueOnce(
      ok({ updatedCount: 5, auditEventCount: 5 }),
    );
    const { POST } = await import('@/app/api/members/bulk/route');
    const res = await POST(
      makeRequest({
        action: 'change_plan',
        member_ids: ['id-1', 'id-2', 'id-3', 'id-4', 'id-5'],
        params: { new_plan_id: 'plan-premium', new_plan_year: 2026 },
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.updated_count).toBe(5);
  });

  it('400 bulk_cap_exceeded when > 100 member_ids', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    const ids = Array.from({ length: 101 }, (_, i) => `id-${i}`);
    const { POST } = await import('@/app/api/members/bulk/route');
    const res = await POST(
      makeRequest({ action: 'archive', member_ids: ids }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('bulk_cap_exceeded');
  });

  it('400 missing Idempotency-Key', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    const { POST } = await import('@/app/api/members/bulk/route');
    const res = await POST(makeRequest({ action: 'archive', member_ids: ['id-1'] }, {}));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('missing_idempotency_key');
  });

  it('429 rate-limited', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    rateLimitCheckMock.mockResolvedValueOnce({
      success: false,
      remaining: 0,
      reset: Date.now() + 300_000,
    });
    bulkActionMock.mockResolvedValueOnce(
      err({ type: 'rate_limited' }),
    );
    const { POST } = await import('@/app/api/members/bulk/route');
    const res = await POST(
      makeRequest({
        action: 'archive',
        member_ids: ['id-1'],
      }),
    );
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error.code).toBe('bulk_rate_limit_exceeded');
  });

  it('403 non-admin rejected', async () => {
    requireAdminContextMock.mockResolvedValueOnce(forbiddenContext);
    const { POST } = await import('@/app/api/members/bulk/route');
    const res = await POST(
      makeRequest({ action: 'archive', member_ids: ['id-1'] }),
    );
    expect(res.status).toBe(403);
  });
});
