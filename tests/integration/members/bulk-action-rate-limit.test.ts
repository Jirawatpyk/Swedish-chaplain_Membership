/**
 * T101 — Integration test: rate-limit audit emission at the route layer.
 *
 * Round-2 review C-1: rate limiting is now enforced at the ROUTE HANDLER
 * only — use case no longer has RateLimitPort dep. This test verifies
 * the route handler's rate-limit audit path end-to-end via mocked
 * rateLimiter.
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { ok } from '@/lib/result';

const requireAdminContextMock = vi.fn();
const rateLimitCheckMock = vi.fn();
const auditRecordMock = vi.fn().mockResolvedValue(ok(undefined));
const bulkActionMock = vi.fn();

vi.mock('@/lib/admin-context', () => ({
  requireAdminContext: (...args: unknown[]) => requireAdminContextMock(...args),
}));
vi.mock('@/modules/members/members-deps', () => ({
  buildMembersDeps: vi.fn(() => ({
    tenant: { slug: 'test-tenant' },
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
  resolveTenantFromRequest: () => ({ slug: 'test-tenant' }),
}));
vi.mock('@/lib/idempotency', () => ({
  parseIdempotencyKey: () => ({ ok: true, key: 'idem-rl' }),
  classifyIdempotencyRequest: vi.fn(async () => ({ kind: 'first' })),
  reserveIdempotencyRecord: vi.fn(async () => ({ ok: true, value: { kind: 'reserved' as const } })),
  rememberIdempotentResponse: vi.fn(async () => undefined),
  hashRequestBody: vi.fn(() => 'hash'),
}));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
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
    user: { id: 'admin-rl', email: 'a@b.co', role: 'admin', status: 'active', displayName: 'A' },
    session: { id: 's1' },
  },
  sourceIp: '203.0.113.5',
  requestId: 'req-rl',
};

function makeRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/members/bulk', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': 'idem-rl',
    },
    body: JSON.stringify(body),
  });
}

describe('integration: bulk action rate limit route (T101 / round-2 C-1)', () => {
  afterEach(() => vi.clearAllMocks());

  it('429 + audit emission when rate-limited at route layer', { timeout: 30_000 }, async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    rateLimitCheckMock.mockResolvedValueOnce({
      success: false,
      remaining: 0,
      reset: Date.now() + 600_000,
    });

    const { POST } = await import('@/app/api/members/bulk/route');
    const res = await POST(
      makeRequest({
        action: 'archive',
        member_ids: ['00000000-0000-0000-0000-000000000001'],
      }),
    );

    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error.code).toBe('bulk_rate_limit_exceeded');

    // Verify Retry-After matches the 600s window (round-2 review I-2)
    expect(res.headers.get('Retry-After')).toBe('600');

    // Verify audit event was emitted for the rate-limit breach
    expect(auditRecordMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        type: 'bulk_action_rate_limit_exceeded',
        actorUserId: 'admin-rl',
        payload: expect.objectContaining({
          action: 'archive',
        }),
      }),
    );

    // Use case MUST NOT be called when rate-limited
    expect(bulkActionMock).not.toHaveBeenCalled();
  });

  it('rate limit check uses correct key shape (bulk:tenant:actor)', { timeout: 30_000 }, async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    rateLimitCheckMock.mockResolvedValueOnce({
      success: false,
      remaining: 0,
      reset: Date.now() + 600_000,
    });

    const { POST } = await import('@/app/api/members/bulk/route');
    await POST(
      makeRequest({
        action: 'archive',
        member_ids: ['00000000-0000-0000-0000-000000000001'],
      }),
    );

    expect(rateLimitCheckMock).toHaveBeenCalledWith(
      'bulk:test-tenant:admin-rl',
      10,
      600,
    );
  });

  it('round-2 I-5: audit write failure does not mask the 429 response', { timeout: 30_000 }, async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    rateLimitCheckMock.mockResolvedValueOnce({
      success: false,
      remaining: 0,
      reset: Date.now() + 600_000,
    });
    // Simulate audit DB outage
    auditRecordMock.mockRejectedValueOnce(new Error('DB down'));

    const { POST } = await import('@/app/api/members/bulk/route');
    const res = await POST(
      makeRequest({
        action: 'archive',
        member_ids: ['00000000-0000-0000-0000-000000000001'],
      }),
    );

    // Still 429 — we prioritise client feedback over audit completeness
    expect(res.status).toBe(429);
  });
});
