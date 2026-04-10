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

const requireAdminContextMock = vi.fn();
const changeRoleMock = vi.fn();

vi.mock('@/lib/admin-context', () => ({
  requireAdminContext: (...args: unknown[]) => requireAdminContextMock(...args),
}));

vi.mock('@/modules/auth/application/change-role', () => ({
  changeRole: (...args: unknown[]) => changeRoleMock(...args),
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
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
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
    requireAdminContextMock.mockResolvedValueOnce(adminContext);

    const { POST } = await import('@/app/api/auth/users/[id]/role/route');
    const res = await POST(makeRequest({ newRole: 'superadmin' }), { params: routeParams });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('invalid-role');
    expect(changeRoleMock).not.toHaveBeenCalled();
  });

  it('400 on non-JSON body', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);

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

  it('401 when requireAdminContext rejects with no-session', async () => {
    requireAdminContextMock.mockResolvedValueOnce({
      response: NextResponse.json({ error: 'no-session' }, { status: 401 }),
    });

    const { POST } = await import('@/app/api/auth/users/[id]/role/route');
    const res = await POST(makeRequest({ newRole: 'manager' }), { params: routeParams });

    expect(res.status).toBe(401);
    expect(changeRoleMock).not.toHaveBeenCalled();
  });

  it('403 when requireAdminContext rejects with forbidden', async () => {
    requireAdminContextMock.mockResolvedValueOnce({
      response: NextResponse.json({ error: 'forbidden' }, { status: 403 }),
    });

    const { POST } = await import('@/app/api/auth/users/[id]/role/route');
    const res = await POST(makeRequest({ newRole: 'manager' }), { params: routeParams });

    expect(res.status).toBe(403);
    expect(changeRoleMock).not.toHaveBeenCalled();
  });

  it('404 when target user not found', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    changeRoleMock.mockResolvedValueOnce(err({ code: 'not-found' }));

    const { POST } = await import('@/app/api/auth/users/[id]/role/route');
    const res = await POST(makeRequest({ newRole: 'manager' }), { params: routeParams });

    expect(res.status).toBe(404);
  });

  it('409 on same-role', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    changeRoleMock.mockResolvedValueOnce(err({ code: 'same-role' }));

    const { POST } = await import('@/app/api/auth/users/[id]/role/route');
    const res = await POST(makeRequest({ newRole: 'manager' }), { params: routeParams });

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe('same-role');
  });

  it('400 on role-portal-mismatch (staff↔member boundary)', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    changeRoleMock.mockResolvedValueOnce(err({ code: 'role-portal-mismatch' }));

    const { POST } = await import('@/app/api/auth/users/[id]/role/route');
    const res = await POST(makeRequest({ newRole: 'member' }), { params: routeParams });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('role-portal-mismatch');
  });

  it('409 on last-admin-protection', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    changeRoleMock.mockResolvedValueOnce(err({ code: 'last-admin-protection' }));

    const { POST } = await import('@/app/api/auth/users/[id]/role/route');
    const res = await POST(makeRequest({ newRole: 'manager' }), { params: routeParams });

    expect(res.status).toBe(409);
  });
});
