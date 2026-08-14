/**
 * T112 — Enable-user contract test (contracts/auth-api.md § 9).
 *
 * Route: POST /api/auth/users/[id]/enable
 * Contract: 200 ok, 401 no-session, 403 forbidden (RBAC), 404 not-found,
 *           409 not-disabled.
 *
 * Mocks `@/lib/admin-context` directly — see `disable-user.test.ts`
 * for the rationale.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextResponse, NextRequest } from 'next/server';
import { ok, err } from '@/lib/result';

const requireApiPermissionMock = vi.fn();
const enableUserMock = vi.fn();

vi.mock('@/lib/rbac', () => ({
  requireApiPermission: (...args: unknown[]) => requireApiPermissionMock(...args),
}));

vi.mock('@/modules/auth/application/enable-user', () => ({
  enableUser: (...args: unknown[]) => enableUserMock(...args),
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
  return new NextRequest('http://localhost/api/auth/users/target-1/enable', {
    method: 'POST',
    headers: { 'x-forwarded-for': '203.0.113.5' },
  });
}

const routeParams = Promise.resolve({ id: 'target-1' });

describe('contract: POST /api/auth/users/[id]/enable (T112)', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('200 on success', async () => {
    requireApiPermissionMock.mockResolvedValueOnce(adminContext);
    enableUserMock.mockResolvedValueOnce(ok({ userId: 'target-1' }));

    const { POST } = await import('@/app/api/auth/users/[id]/enable/route');
    const res = await POST(makeRequest(), { params: routeParams });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(enableUserMock).toHaveBeenCalledWith(
      expect.objectContaining({ actorUserId: 'admin-1', requestId: 'test-req-id' }),
    );
  });

  it('401 when requireApiPermission rejects with no-session', async () => {
    requireApiPermissionMock.mockResolvedValueOnce({
      response: NextResponse.json({ error: 'no-session' }, { status: 401 }),
    });

    const { POST } = await import('@/app/api/auth/users/[id]/enable/route');
    const res = await POST(makeRequest(), { params: routeParams });

    expect(res.status).toBe(401);
    expect(enableUserMock).not.toHaveBeenCalled();
  });

  it('403 when requireApiPermission rejects with forbidden', async () => {
    requireApiPermissionMock.mockResolvedValueOnce({
      response: NextResponse.json({ error: 'forbidden' }, { status: 403 }),
    });

    const { POST } = await import('@/app/api/auth/users/[id]/enable/route');
    const res = await POST(makeRequest(), { params: routeParams });

    expect(res.status).toBe(403);
    expect(enableUserMock).not.toHaveBeenCalled();
  });

  it('404 when target user not found', async () => {
    requireApiPermissionMock.mockResolvedValueOnce(adminContext);
    enableUserMock.mockResolvedValueOnce(err({ code: 'not-found' }));

    const { POST } = await import('@/app/api/auth/users/[id]/enable/route');
    const res = await POST(makeRequest(), { params: routeParams });

    expect(res.status).toBe(404);
  });

  it('409 when not-disabled (already active)', async () => {
    requireApiPermissionMock.mockResolvedValueOnce(adminContext);
    enableUserMock.mockResolvedValueOnce(err({ code: 'not-disabled' }));

    const { POST } = await import('@/app/api/auth/users/[id]/enable/route');
    const res = await POST(makeRequest(), { params: routeParams });

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe('not-disabled');
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

      const { POST } = await import('@/app/api/auth/users/[id]/enable/route');
      const res = await POST(makeRequest(), { params: routeParams });

      expect(res.status).toBe(403);
      expect(enableUserMock).not.toHaveBeenCalled();
      expect(requireApiPermissionMock).toHaveBeenCalledTimes(2);
      expect(requireApiPermissionMock).toHaveBeenNthCalledWith(
        2,
        expect.anything(),
        'users.manage',
      );
    });

    it('member TARGET never consults users.manage (step 1 alone authorises)', async () => {
      requireApiPermissionMock.mockResolvedValue(adminContext);
      findByIdMock.mockResolvedValueOnce({ id: 'target-1', role: 'member' });
      enableUserMock.mockResolvedValueOnce(ok({ userId: 'target-1' }));

      const { POST } = await import('@/app/api/auth/users/[id]/enable/route');
      await POST(makeRequest(), { params: routeParams });

      expect(requireApiPermissionMock).toHaveBeenCalledTimes(1);
    });
  });

  // N4 (Round 3) — B3 outer try/catch.
  it('500 with requestId when enable-user throws (infra error)', async () => {
    const { assertRoute500WithRequestId } = await import(
      './_helpers/assert-route-500'
    );
    requireApiPermissionMock.mockResolvedValueOnce(adminContext);
    enableUserMock.mockRejectedValueOnce(new Error('neon: connection terminated'));

    const { POST } = await import('@/app/api/auth/users/[id]/enable/route');
    const res = await POST(makeRequest(), { params: routeParams });

    await assertRoute500WithRequestId(res);
  });
});
