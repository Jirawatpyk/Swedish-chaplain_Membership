/**
 * T111 — Disable-user contract test (contracts/auth-api.md § 8).
 *
 * Route: POST /api/auth/users/[id]/disable
 * Contract: 200 ok, 401 no-session, 403 forbidden (RBAC), 404 not-found,
 *           409 already-disabled / last-admin-protection.
 *
 * Mocks `@/lib/admin-context` directly — the route delegates all
 * session + RBAC guarding to `requireApiPermission()`, so that's the
 * seam the contract test should mock. (`requireApiPermission` has its
 * own unit tests at `tests/unit/lib/admin-context.test.ts`.)
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextResponse, NextRequest } from 'next/server';
import { ok, err } from '@/lib/result';

const requireApiPermissionMock = vi.fn();
const disableUserMock = vi.fn();

vi.mock('@/lib/rbac', () => ({
  requireApiPermission: (...args: unknown[]) => requireApiPermissionMock(...args),
}));

vi.mock('@/modules/auth/application/disable-user', () => ({
  disableUser: (...args: unknown[]) => disableUserMock(...args),
}));

// 016 T028 — the route loads the TARGET row to pick the per-target permission
// (§ 7.1). Default null = step-2 gate skipped; the use-case mock still decides
// the outcome (pre-sweep contract). Mocked so no real repo/db is touched.
const findByIdMock = vi.fn(async (..._args: unknown[]): Promise<unknown> => null);
vi.mock('@/lib/auth-deps', () => ({
  userRepo: { findById: (...args: unknown[]) => findByIdMock(...args) },
}));

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

const adminContext = {
  current: {
    user: {
      id: 'admin-1',
      email: 'admin@swecham.se',
      role: 'admin',
      status: 'active',
      displayName: 'Admin',
    },
    session: { id: 'sess-1' },
  },
  sourceIp: '203.0.113.5',
  requestId: 'test-req-id',
};

function makeRequest(): NextRequest {
  return new NextRequest('http://localhost/api/auth/users/target-1/disable', {
    method: 'POST',
    headers: { 'x-forwarded-for': '203.0.113.5' },
  });
}

const routeParams = Promise.resolve({ id: 'target-1' });

describe('contract: POST /api/auth/users/[id]/disable (T111)', () => {
  afterEach(() => { vi.clearAllMocks(); });

  it('200 on success — returns sessionsRevoked', async () => {
    requireApiPermissionMock.mockResolvedValueOnce(adminContext);
    disableUserMock.mockResolvedValueOnce(ok({ sessionsRevoked: 2 }));

    const { POST } = await import('@/app/api/auth/users/[id]/disable/route');
    const res = await POST(makeRequest(), { params: routeParams });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.sessionsRevoked).toBe(2);
  });

  it('401 when requireApiPermission rejects with no-session', async () => {
    requireApiPermissionMock.mockResolvedValueOnce({
      response: NextResponse.json({ error: 'no-session' }, { status: 401 }),
    });

    const { POST } = await import('@/app/api/auth/users/[id]/disable/route');
    const res = await POST(makeRequest(), { params: routeParams });

    expect(res.status).toBe(401);
    // Use case MUST NOT be called on the rejection path.
    expect(disableUserMock).not.toHaveBeenCalled();
  });

  it('403 when requireApiPermission rejects with forbidden', async () => {
    requireApiPermissionMock.mockResolvedValueOnce({
      response: NextResponse.json({ error: 'forbidden' }, { status: 403 }),
    });

    const { POST } = await import('@/app/api/auth/users/[id]/disable/route');
    const res = await POST(makeRequest(), { params: routeParams });

    expect(res.status).toBe(403);
    expect(disableUserMock).not.toHaveBeenCalled();
  });

  it('404 when target user not found', async () => {
    requireApiPermissionMock.mockResolvedValueOnce(adminContext);
    disableUserMock.mockResolvedValueOnce(err({ code: 'not-found' }));

    const { POST } = await import('@/app/api/auth/users/[id]/disable/route');
    const res = await POST(makeRequest(), { params: routeParams });

    expect(res.status).toBe(404);
  });

  it('409 when already disabled', async () => {
    requireApiPermissionMock.mockResolvedValueOnce(adminContext);
    disableUserMock.mockResolvedValueOnce(err({ code: 'already-disabled' }));

    const { POST } = await import('@/app/api/auth/users/[id]/disable/route');
    const res = await POST(makeRequest(), { params: routeParams });

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe('already-disabled');
  });

  it('409 on last-admin-protection', async () => {
    requireApiPermissionMock.mockResolvedValueOnce(adminContext);
    disableUserMock.mockResolvedValueOnce(err({ code: 'last-admin-protection' }));

    const { POST } = await import('@/app/api/auth/users/[id]/disable/route');
    const res = await POST(makeRequest(), { params: routeParams });

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe('last-admin-protection');
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

      const { POST } = await import('@/app/api/auth/users/[id]/disable/route');
      const res = await POST(makeRequest(), { params: routeParams });

      expect(res.status).toBe(403);
      expect(disableUserMock).not.toHaveBeenCalled();
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
      disableUserMock.mockResolvedValueOnce(ok({ sessionsRevoked: 0 }));

      const { POST } = await import('@/app/api/auth/users/[id]/disable/route');
      await POST(makeRequest(), { params: routeParams });

      expect(requireApiPermissionMock).toHaveBeenCalledTimes(1);
    });
  });

  // N4 (Round 3) — B3 outer try/catch.
  it('500 with requestId when disable-user throws (infra error)', async () => {
    const { assertRoute500WithRequestId } = await import(
      './_helpers/assert-route-500'
    );
    requireApiPermissionMock.mockResolvedValueOnce(adminContext);
    disableUserMock.mockRejectedValueOnce(new Error('neon: connection terminated'));

    const { POST } = await import('@/app/api/auth/users/[id]/disable/route');
    const res = await POST(makeRequest(), { params: routeParams });

    await assertRoute500WithRequestId(res);
  });
});
