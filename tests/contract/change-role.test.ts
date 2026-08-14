/**
 * T113 — Change-role contract test (contracts/auth-api.md § 10).
 *
 * Route: POST /api/auth/users/[id]/role
 * Contract: 200 ok (returns sessionsRevoked), 400 invalid-role / role-portal-mismatch,
 *           401 no-session, 403 forbidden (RBAC), 404 not-found,
 *           409 same-role / last-admin-protection.
 *
 * Mocks `@/lib/admin-context` directly — see `disable-user.test.ts`
 * for the rationale.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextResponse, NextRequest } from 'next/server';
import { ok, err } from '@/lib/result';

const requireApiPermissionMock = vi.fn();
const changeRoleMock = vi.fn();

vi.mock('@/lib/rbac', () => ({
  requireApiPermission: (...args: unknown[]) => requireApiPermissionMock(...args),
}));

// The route handler imports `changeRole` + `asUserId` from the
// `@/modules/auth` public barrel (Constitution Principle III —
// Clean Architecture barrel enforcement). The mock stubs the
// barrel DIRECTLY (no `importActual`) — `importActual` triggers
// eager resolution of the full barrel and is brittle under
// full-suite worker-pool module caching. Since the route only
// imports `changeRole` and `asUserId` from the barrel, stubbing
// just those two is enough.
// 016 re-review — the route's § 7.1 step-2 branch keys on `isStaffRole`. Import
// the REAL predicate from its deep Domain module (pure, no infra) rather than
// re-implementing the allow-list: a hand-copied list would stay green if the
// real predicate ever changed. Deep import (not the barrel) keeps the author's
// original reason to avoid `importActual` on the barrel — eager full-barrel
// resolution is brittle under full-suite worker-pool module caching.
import { isStaffRole as realIsStaffRole } from '@/modules/auth/domain/role';
vi.mock('@/modules/auth', () => ({
  changeRole: (...args: unknown[]) => changeRoleMock(...args),
  asUserId: (s: string) => s,
  isStaffRole: (r: string) => realIsStaffRole(r as never),
}));

// 016 T028 — the route loads the TARGET row to pick the per-target permission
// (§ 7.1). Default null = target missing → step-2 gate skipped; the use-case
// mock still decides the outcome, which is the pre-sweep contract.
const findByIdMock = vi.fn(async (..._args: unknown[]) => null);
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

function makeRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/auth/users/target-1/role', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-forwarded-for': '203.0.113.5',
    },
    body: JSON.stringify(body),
  });
}

const routeParams = Promise.resolve({ id: 'target-1' });

describe('contract: POST /api/auth/users/[id]/role (T113)', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('200 on success — returns sessionsRevoked', async () => {
    requireApiPermissionMock.mockResolvedValue(adminContext);
    changeRoleMock.mockResolvedValueOnce(ok({ sessionsRevoked: 3 }));

    const { POST } = await import('@/app/api/auth/users/[id]/role/route');
    const res = await POST(makeRequest({ newRole: 'manager' }), { params: routeParams });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.sessionsRevoked).toBe(3);
    expect(changeRoleMock).toHaveBeenCalledWith(
      expect.objectContaining({ newRole: 'manager', actorUserId: 'admin-1' }),
    );
  });

  it('400 on invalid-role (not in enum)', async () => {
    requireApiPermissionMock.mockResolvedValue(adminContext);

    const { POST } = await import('@/app/api/auth/users/[id]/role/route');
    const res = await POST(makeRequest({ newRole: 'superadmin' }), { params: routeParams });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('invalid-role');
    expect(changeRoleMock).not.toHaveBeenCalled();
  });

  it('400 on non-JSON body', async () => {
    requireApiPermissionMock.mockResolvedValue(adminContext);

    const { POST } = await import('@/app/api/auth/users/[id]/role/route');
    const res = await POST(
      new NextRequest('http://localhost/api/auth/users/target-1/role', {
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        body: 'not json',
      }),
      { params: routeParams },
    );

    expect(res.status).toBe(400);
  });

  it('401 when requireApiPermission rejects with no-session', async () => {
    requireApiPermissionMock.mockResolvedValue({
      response: NextResponse.json({ error: 'no-session' }, { status: 401 }),
    });

    const { POST } = await import('@/app/api/auth/users/[id]/role/route');
    const res = await POST(makeRequest({ newRole: 'manager' }), { params: routeParams });

    expect(res.status).toBe(401);
    expect(changeRoleMock).not.toHaveBeenCalled();
  });

  it('403 when requireApiPermission rejects with forbidden', async () => {
    requireApiPermissionMock.mockResolvedValue({
      response: NextResponse.json({ error: 'forbidden' }, { status: 403 }),
    });

    const { POST } = await import('@/app/api/auth/users/[id]/role/route');
    const res = await POST(makeRequest({ newRole: 'manager' }), { params: routeParams });

    expect(res.status).toBe(403);
    expect(changeRoleMock).not.toHaveBeenCalled();
  });

  it('404 when target user not found', async () => {
    requireApiPermissionMock.mockResolvedValue(adminContext);
    changeRoleMock.mockResolvedValueOnce(err({ code: 'not-found' }));

    const { POST } = await import('@/app/api/auth/users/[id]/role/route');
    const res = await POST(makeRequest({ newRole: 'manager' }), { params: routeParams });

    expect(res.status).toBe(404);
  });

  it('409 on same-role', async () => {
    requireApiPermissionMock.mockResolvedValue(adminContext);
    changeRoleMock.mockResolvedValueOnce(err({ code: 'same-role' }));

    const { POST } = await import('@/app/api/auth/users/[id]/role/route');
    const res = await POST(makeRequest({ newRole: 'manager' }), { params: routeParams });

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe('same-role');
  });

  it('400 on role-portal-mismatch (staff↔member boundary)', async () => {
    requireApiPermissionMock.mockResolvedValue(adminContext);
    changeRoleMock.mockResolvedValueOnce(err({ code: 'role-portal-mismatch' }));

    const { POST } = await import('@/app/api/auth/users/[id]/role/route');
    const res = await POST(makeRequest({ newRole: 'member' }), { params: routeParams });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('role-portal-mismatch');
  });

  it('409 on last-admin-protection', async () => {
    requireApiPermissionMock.mockResolvedValue(adminContext);
    changeRoleMock.mockResolvedValueOnce(err({ code: 'last-admin-protection' }));

    const { POST } = await import('@/app/api/auth/users/[id]/role/route');
    const res = await POST(makeRequest({ newRole: 'manager' }), { params: routeParams });

    expect(res.status).toBe(409);
  });

  /**
   * 016 review C2 — the § 7.1 step-2 gate was implemented but never EXECUTED
   * by any test: `findByIdMock` resolves `null` everywhere, so
   * `if (target && isStaffRole(target.role))` was always false and deleting
   * the whole block left the suite green. Post-cutover on the flag-ON leg that
   * is privilege escalation — a plain admin holds `users.member_accounts` and
   * would sail through step 1 to demote a super_admin.
   *
   * These three cases pin the branch by OUTCOME, not by call shape:
   * a staff target must consult `users.manage` and honour its rejection;
   * a member target must not consult it at all.
   */
  describe('§ 7.1 step-2 per-TARGET escalation gate', () => {
    it('staff-role TARGET consults users.manage and returns its rejection', async () => {
      requireApiPermissionMock
        .mockResolvedValueOnce(adminContext) // step 1 — users.member_accounts
        .mockResolvedValueOnce({
          // step 2 — users.manage (super-admin-only on the ON leg)
          response: NextResponse.json({ error: 'forbidden' }, { status: 403 }),
        });
      findByIdMock.mockResolvedValueOnce({ id: 'target-1', role: 'super_admin' } as never);

      const { POST } = await import('@/app/api/auth/users/[id]/role/route');
      const res = await POST(makeRequest({ newRole: 'manager' }), { params: routeParams });

      expect(res.status).toBe(403);
      expect(changeRoleMock).not.toHaveBeenCalled();
      expect(requireApiPermissionMock).toHaveBeenCalledTimes(2);
      expect(requireApiPermissionMock).toHaveBeenNthCalledWith(
        2,
        expect.anything(),
        'users.manage',
      );
    });

    it('member TARGET never consults users.manage (step 1 alone authorises)', async () => {
      requireApiPermissionMock.mockResolvedValue(adminContext);
      findByIdMock.mockResolvedValueOnce({ id: 'target-1', role: 'member' } as never);
      changeRoleMock.mockResolvedValueOnce(ok({ sessionsRevoked: 0 }));

      const { POST } = await import('@/app/api/auth/users/[id]/role/route');
      const res = await POST(makeRequest({ newRole: 'member' }), { params: routeParams });

      expect(res.status).toBe(200);
      expect(requireApiPermissionMock).toHaveBeenCalledTimes(1);
    });

    it('PROMOTING a member to a staff role consults users.manage (direction-independent)', async () => {
      // The target row is a member, but the REQUESTED role is staff — without
      // the `isStaffRole(newRole)` half of the condition an admin could mint a
      // new super_admin through the member-accounts key alone.
      requireApiPermissionMock
        .mockResolvedValueOnce(adminContext)
        .mockResolvedValueOnce({
          response: NextResponse.json({ error: 'forbidden' }, { status: 403 }),
        });
      findByIdMock.mockResolvedValueOnce({ id: 'target-1', role: 'member' } as never);

      const { POST } = await import('@/app/api/auth/users/[id]/role/route');
      const res = await POST(makeRequest({ newRole: 'admin' }), { params: routeParams });

      expect(res.status).toBe(403);
      expect(changeRoleMock).not.toHaveBeenCalled();
      expect(requireApiPermissionMock).toHaveBeenCalledTimes(2);
    });

    it('ACCEPTS super_admin as a target role (PR 3 assignable) and reaches the use case', async () => {
      // super_admin joined the route enum in 016 PR 3. A staff→super_admin change
      // passes step 1 + the step-2 users.manage gate and calls changeRole —
      // proving the zod widening reached the SERVER, not just the picker UI.
      requireApiPermissionMock.mockResolvedValue(adminContext);
      findByIdMock.mockResolvedValueOnce({ id: 'target-1', role: 'admin' } as never);
      changeRoleMock.mockResolvedValueOnce(ok({ sessionsRevoked: 2 }));

      const { POST } = await import('@/app/api/auth/users/[id]/role/route');
      const res = await POST(makeRequest({ newRole: 'super_admin' }), { params: routeParams });

      expect(res.status).toBe(200);
      expect(changeRoleMock).toHaveBeenCalledWith(
        expect.objectContaining({ newRole: 'super_admin' }),
      );
      expect(requireApiPermissionMock).toHaveBeenCalledTimes(2);
    });
  });

  // N4 (Round 3) — B3 outer try/catch.
  it('500 with requestId when change-role throws (infra error)', async () => {
    const { assertRoute500WithRequestId } = await import(
      './_helpers/assert-route-500'
    );
    requireApiPermissionMock.mockResolvedValue(adminContext);
    changeRoleMock.mockRejectedValueOnce(new Error('neon: connection terminated'));

    const { POST } = await import('@/app/api/auth/users/[id]/role/route');
    const res = await POST(makeRequest({ newRole: 'manager' }), { params: routeParams });

    await assertRoute500WithRequestId(res);
  });
});
