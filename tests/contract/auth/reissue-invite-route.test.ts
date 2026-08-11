/**
 * Contract test: POST /api/auth/users/[id]/reissue-invite
 * (Staff Invitation Lifecycle, Task 2).
 *
 * Exposes Task 1's `resendStaffInvitation` use case over HTTP, admin-gated
 * via `requireApiPermission`. RA-1 (security) adds a per-(tenant, TARGET
 * userId) resend throttle — 3/hour, keyed on the target rather than the
 * acting admin so N admins can't collectively mail-bomb one inbox (the
 * DV-11 rule; mirrors the F3 resend-verification route's identical
 * per-document pattern) — enforced with a single ATOMIC `check` call
 * BEFORE the use case runs. A peek-then-consume variant was tried and
 * reverted: it lets N concurrent requests all pass a non-consuming peek
 * before any of them consumes a token, bypassing the budget entirely.
 * The atomic-check-first shape accepts that a 404/409 (no email sent)
 * still spends a token — fail-closed and harmless. Mock style follows
 * tests/contract/plans/palette-search.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import { ok, err } from '@/lib/result';

const requireApiPermissionMock = vi.fn();
const resendStaffInvitationMock = vi.fn();
const rateLimiterCheckMock = vi.fn();

vi.mock('@/lib/rbac', () => ({
  requireApiPermission: (...args: unknown[]) => requireApiPermissionMock(...args),
}));
vi.mock('@/modules/auth', () => ({
  resendStaffInvitation: (...args: unknown[]) => resendStaffInvitationMock(...args),
  asUserId: (id: string) => id,
  // Real predicate shape — the route's § 7.1 step-2 branch keys on it.
  isStaffRole: (r: string) => ['super_admin', 'admin', 'manager', 'marketing'].includes(r),
}));
vi.mock('@/lib/tenant-context', () => ({
  resolveTenantFromRequest: () => ({ slug: 'test-swecham', __brand: true }),
}));
// 016 T028 — userRepo.findById added: the route loads the TARGET row to pick
// the per-target permission (§ 7.1). Default null = step-2 gate skipped.
const findByIdMock = vi.fn(async (..._args: unknown[]): Promise<unknown> => null);
vi.mock('@/lib/auth-deps', () => ({
  rateLimiter: {
    check: (...args: unknown[]) => rateLimiterCheckMock(...args),
  },
  userRepo: { findById: (...args: unknown[]) => findByIdMock(...args) },
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
    // Default: budget available. Individual tests override for the
    // rate-limited case.
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

  it('200 — admin + ok, checks the rate limiter with the per-(tenant,target) key BEFORE the use case, omits locale', async () => {
    requireApiPermissionMock.mockResolvedValueOnce(adminContext);
    resendStaffInvitationMock.mockResolvedValueOnce(ok({ email: 'pending@swecham.example' }));

    const { POST } = await import('@/app/api/auth/users/[id]/reissue-invite/route');
    const res = await POST(makeRequest('user-1'), makeParams('user-1'));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);

    // RA-1: budget 3/hour, keyed on (tenant, TARGET userId) — NOT the
    // actor. Atomic consume BEFORE the use case runs.
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

  it('409 — not-pending, rate-limit token was still consumed (accepted tradeoff — fail-closed)', async () => {
    requireApiPermissionMock.mockResolvedValueOnce(adminContext);
    resendStaffInvitationMock.mockResolvedValueOnce(err({ code: 'not-pending' }));

    const { POST } = await import('@/app/api/auth/users/[id]/reissue-invite/route');
    const res = await POST(makeRequest('user-1'), makeParams('user-1'));
    expect(res.status).toBe(409);
    expect(rateLimiterCheckMock).toHaveBeenCalledTimes(1);
  });

  it('404 — user-not-found, rate-limit token was still consumed (accepted tradeoff — fail-closed)', async () => {
    requireApiPermissionMock.mockResolvedValueOnce(adminContext);
    resendStaffInvitationMock.mockResolvedValueOnce(err({ code: 'user-not-found' }));

    const { POST } = await import('@/app/api/auth/users/[id]/reissue-invite/route');
    const res = await POST(makeRequest('user-1'), makeParams('user-1'));
    expect(res.status).toBe(404);
    expect(rateLimiterCheckMock).toHaveBeenCalledTimes(1);
  });

  it('500 — reissue-failed (default branch)', async () => {
    requireApiPermissionMock.mockResolvedValueOnce(adminContext);
    resendStaffInvitationMock.mockResolvedValueOnce(err({ code: 'reissue-failed' }));

    const { POST } = await import('@/app/api/auth/users/[id]/reissue-invite/route');
    const res = await POST(makeRequest('user-1'), makeParams('user-1'));
    expect(res.status).toBe(500);
  });

  it('401 — unauthenticated', async () => {
    requireApiPermissionMock.mockResolvedValueOnce({
      response: NextResponse.json({ error: 'no-session' }, { status: 401 }),
    });

    const { POST } = await import('@/app/api/auth/users/[id]/reissue-invite/route');
    const res = await POST(makeRequest('user-1'), makeParams('user-1'));
    expect(res.status).toBe(401);
    expect(resendStaffInvitationMock).not.toHaveBeenCalled();
  });

  it('429 — check reports the bucket full, with Retry-After header, use case never called', async () => {
    requireApiPermissionMock.mockResolvedValueOnce(adminContext);
    const reset = Date.now() + 120_000;
    rateLimiterCheckMock.mockResolvedValueOnce({
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
  });

  /**
   * 016 review C2 — the § 7.1 step-2 gate was implemented but never EXECUTED:
   * `findByIdMock` resolves `null` everywhere, so the staff-target branch was
   * always false and deleting the block left the suite green. On the flag-ON
   * leg that is privilege escalation — a plain admin holds
   * `users.member_accounts` and would sail through step 1 onto a staff row.
   */
  describe('§ 7.1 step-2 per-TARGET escalation gate', () => {
    it('staff-role TARGET consults users.manage and returns its rejection', async () => {
      requireApiPermissionMock
        .mockResolvedValueOnce(adminContext)
        .mockResolvedValueOnce({
          response: NextResponse.json({ error: 'forbidden' }, { status: 403 }),
        });
      findByIdMock.mockResolvedValueOnce({ id: 'target-1', role: 'super_admin' });

      const { POST } = await import('@/app/api/auth/users/[id]/reissue-invite/route');
      const res = await POST(makeRequest('user-1'), makeParams('user-1'));

      expect(res.status).toBe(403);
      expect(resendStaffInvitationMock).not.toHaveBeenCalled();
      expect(requireApiPermissionMock).toHaveBeenCalledTimes(2);
      expect(requireApiPermissionMock).toHaveBeenNthCalledWith(
        2,
        expect.anything(),
        'users.manage',
        { kind: 'mappedLegacy', resource: 'auth:user', action: 'write' },
      );
    });

    it('member TARGET never consults users.manage (step 1 alone authorises)', async () => {
      requireApiPermissionMock.mockResolvedValue(adminContext);
      findByIdMock.mockResolvedValueOnce({ id: 'target-1', role: 'member' });
      resendStaffInvitationMock.mockResolvedValueOnce(ok({ email: 'pending@swecham.example' }));

      const { POST } = await import('@/app/api/auth/users/[id]/reissue-invite/route');
      await POST(makeRequest('user-1'), makeParams('user-1'));

      expect(requireApiPermissionMock).toHaveBeenCalledTimes(1);
    });
  });

});
