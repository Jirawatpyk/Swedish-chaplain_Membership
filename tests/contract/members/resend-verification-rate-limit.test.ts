/**
 * Contract test: rate-limit on
 * POST /api/members/[memberId]/contacts/[contactId]/resend-verification
 *
 * Verifies that the route:
 *   - returns 429 `{ error: 'rate_limited' }` + `Retry-After` header when the
 *     per-(actorUserId, contactId) Upstash bucket is exhausted.
 *   - returns 200 with the standard success body when the limiter allows.
 *
 * Mock strategy: mirrors resend-verification.test.ts (same admin-gate + deps
 * mocks). Additionally mocks `@/lib/auth-deps` to intercept `rateLimiter`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { ok } from '@/lib/result';

// ---------------------------------------------------------------------------
// Hoist mocks — must be declared before any import that pulls the real impls
// ---------------------------------------------------------------------------

const checkRl = vi.fn();

vi.mock('@/lib/auth-deps', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth-deps')>('@/lib/auth-deps');
  return {
    ...actual,
    rateLimiter: { check: (...a: unknown[]) => checkRl(...a) },
  };
});

const requireAdminContextMock = vi.fn();
const resendVerificationEmailMock = vi.fn();
const buildMembersDepsMock = vi.fn(() => ({
  contactRepo: {},
  tokens: {},
  emails: {},
  userEmails: {},
  audit: {},
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
    resendVerificationEmail: resendVerificationEmailMock,
  };
});

vi.mock('@/lib/tenant-context', () => ({
  resolveTenantFromRequest: () => ({ slug: 'test-swecham', __brand: true }),
}));

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const adminContext = {
  current: {
    user: { id: 'admin-1', email: 'a@b.co', role: 'admin', status: 'active' },
    session: { id: 's1' },
  },
  sourceIp: '203.0.113.5',
  requestId: 'req-1',
};

const memberId = '11111111-1111-1111-1111-111111111111';
const contactId = '22222222-2222-2222-2222-222222222222';

function makeRequest(): NextRequest {
  return new NextRequest(
    `http://localhost:3100/api/members/${memberId}/contacts/${contactId}/resend-verification`,
    { method: 'POST' },
  );
}

const routeParams = async () => ({ memberId, contactId });

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('contract: resend-verification rate limit', () => {
  afterEach(() => vi.clearAllMocks());

  it('returns 429 { error: "rate_limited" } + Retry-After when limiter denies', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    checkRl.mockResolvedValueOnce({ success: false, reset: Date.now() + 60_000 });

    const { POST } = await import(
      '@/app/api/members/[memberId]/contacts/[contactId]/resend-verification/route'
    );
    const res = await POST(makeRequest(), { params: routeParams() });

    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error).toBe('rate_limited');
    expect(res.headers.get('Retry-After')).not.toBeNull();
    // Use case must NOT be called when rate-limited
    expect(resendVerificationEmailMock).not.toHaveBeenCalled();
  });

  it('proceeds to 200 when limiter allows', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    checkRl.mockResolvedValueOnce({ success: true, reset: Date.now() + 3600_000 });
    resendVerificationEmailMock.mockResolvedValueOnce(
      ok({
        userId: 'user-42',
        contactId,
        newEmail: 'contact@example.com',
        outboxRowId: 'outbox-1',
        invalidatedPrior: 0,
      }),
    );

    const { POST } = await import(
      '@/app/api/members/[memberId]/contacts/[contactId]/resend-verification/route'
    );
    const res = await POST(makeRequest(), { params: routeParams() });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.outbox_row_id).toBe('outbox-1');
    expect(body.invalidated_prior).toBe(0);
    // Limiter was called with the correct per-contact key (no userId —
    // per-DOCUMENT pattern prevents multi-admin inbox bombing).
    expect(checkRl).toHaveBeenCalledWith(
      `resend-verify:test-swecham:${contactId}`,
      3,
      3600,
    );
  });
});
