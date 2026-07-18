/**
 * Contract test: POST /api/auth/users/[id]/reissue-invite
 * (Staff Invitation Lifecycle, Task 2).
 *
 * Exposes Task 1's `resendStaffInvitation` use case over HTTP, admin-gated
 * via `requireAdminContext`. RA-1 (security) adds a per-(tenant, TARGET
 * userId) resend throttle — 3/hour, keyed on the target rather than the
 * acting admin so N admins can't collectively mail-bomb one inbox (the
 * DV-11 rule; mirrors the F3 resend-verification route's identical
 * per-document pattern) — gated with a non-consuming `peek` BEFORE the use
 * case runs, and consumed with `check` only after a confirmed send, so
 * 404/409 responses (no email sent) never spend a token. Mock style
 * follows tests/contract/plans/palette-search.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import { ok, err } from '@/lib/result';

const requireAdminContextMock = vi.fn();
const resendStaffInvitationMock = vi.fn();
const rateLimiterPeekMock = vi.fn();
const rateLimiterCheckMock = vi.fn();

vi.mock('@/lib/admin-context', () => ({
  requireAdminContext: (...args: unknown[]) => requireAdminContextMock(...args),
}));
vi.mock('@/modules/auth', () => ({
  resendStaffInvitation: (...args: unknown[]) => resendStaffInvitationMock(...args),
  asUserId: (id: string) => id,
}));
vi.mock('@/lib/tenant-context', () => ({
  resolveTenantFromRequest: () => ({ slug: 'test-swecham', __brand: true }),
}));
vi.mock('@/lib/auth-deps', () => ({
  rateLimiter: {
    peek: (...args: unknown[]) => rateLimiterPeekMock(...args),
    check: (...args: unknown[]) => rateLimiterCheckMock(...args),
  },
}));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

const adminContext = {
  current: {
    user: { id: 'admin-1', email: 'a@b.co', role: 'admin', status: 'active', displayName: 'A' },
    session: { id: 'sess-1' },
  },
  sourceIp: '203.0.113.5',
  requestId: 'req-reissue-1',
};

function makeRequest(id: string): NextRequest {
  return new NextRequest(`http://localhost/api/auth/users/${id}/reissue-invite`, {
    method: 'POST',
  });
}

function makeParams(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

describe('contract: POST /api/auth/users/[id]/reissue-invite (Task 2)', () => {
  beforeEach(() => {
    vi.resetModules();
    // Default: budget available on both peek + check. Individual tests
    // override for the rate-limited case.
    rateLimiterPeekMock.mockResolvedValue({
      success: true,
      remaining: 3,
      reset: Date.now() + 3_600_000,
      fellBack: false,
    });
    rateLimiterCheckMock.mockResolvedValue({
      success: true,
      remaining: 2,
      reset: Date.now() + 3_600_000,
      fellBack: false,
    });
  });
  afterEach(() => {
    vi.resetAllMocks();
  });

  it('200 — admin + ok, peeks + consumes the rate limiter with the per-(tenant,target) key, omits locale', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    resendStaffInvitationMock.mockResolvedValueOnce(ok({ email: 'pending@swecham.example' }));

    const { POST } = await import('@/app/api/auth/users/[id]/reissue-invite/route');
    const res = await POST(makeRequest('user-1'), makeParams('user-1'));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);

    // RA-1: budget 3/hour, keyed on (tenant, TARGET userId) — NOT the actor.
    // Gated with peek (non-consuming)...
    expect(rateLimiterPeekMock).toHaveBeenCalledWith(
      'reissue-invite:test-swecham:user-1',
      3,
      3600,
    );
    // ...and consumed with check ONLY because the send actually happened.
    expect(rateLimiterCheckMock).toHaveBeenCalledTimes(1);
    expect(rateLimiterCheckMock).toHaveBeenCalledWith(
      'reissue-invite:test-swecham:user-1',
      3,
      3600,
    );

    expect(resendStaffInvitationMock).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        actorUserId: 'admin-1',
        sourceIp: '203.0.113.5',
        requestId: 'req-reissue-1',
        // RA-6: no resolveLocaleFromRequest — pass undefined explicitly.
        locale: undefined,
        tenantId: 'test-swecham',
      }),
    );
  });

  it('409 — not-pending, does NOT consume a rate-limit token', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    resendStaffInvitationMock.mockResolvedValueOnce(err({ code: 'not-pending' }));

    const { POST } = await import('@/app/api/auth/users/[id]/reissue-invite/route');
    const res = await POST(makeRequest('user-1'), makeParams('user-1'));
    expect(res.status).toBe(409);
    expect(rateLimiterCheckMock).not.toHaveBeenCalled();
  });

  it('404 — user-not-found, does NOT consume a rate-limit token', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    resendStaffInvitationMock.mockResolvedValueOnce(err({ code: 'user-not-found' }));

    const { POST } = await import('@/app/api/auth/users/[id]/reissue-invite/route');
    const res = await POST(makeRequest('user-1'), makeParams('user-1'));
    expect(res.status).toBe(404);
    expect(rateLimiterCheckMock).not.toHaveBeenCalled();
  });

  it('500 — reissue-failed (default branch)', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    resendStaffInvitationMock.mockResolvedValueOnce(err({ code: 'reissue-failed' }));

    const { POST } = await import('@/app/api/auth/users/[id]/reissue-invite/route');
    const res = await POST(makeRequest('user-1'), makeParams('user-1'));
    expect(res.status).toBe(500);
  });

  it('401 — unauthenticated', async () => {
    requireAdminContextMock.mockResolvedValueOnce({
      response: NextResponse.json({ error: 'no-session' }, { status: 401 }),
    });

    const { POST } = await import('@/app/api/auth/users/[id]/reissue-invite/route');
    const res = await POST(makeRequest('user-1'), makeParams('user-1'));
    expect(res.status).toBe(401);
    expect(resendStaffInvitationMock).not.toHaveBeenCalled();
  });

  it('429 — peek reports the bucket full, with Retry-After header, use case + check never called', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    const reset = Date.now() + 120_000;
    rateLimiterPeekMock.mockResolvedValueOnce({
      success: false,
      remaining: 0,
      reset,
      fellBack: false,
    });

    const { POST } = await import('@/app/api/auth/users/[id]/reissue-invite/route');
    const res = await POST(makeRequest('user-1'), makeParams('user-1'));

    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBeTruthy();
    expect(resendStaffInvitationMock).not.toHaveBeenCalled();
    expect(rateLimiterCheckMock).not.toHaveBeenCalled();
  });
});
