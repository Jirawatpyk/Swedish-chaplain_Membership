/**
 * T113 — Change-role contract test (contracts/auth-api.md § 10).
 *
 * Route: POST /api/auth/users/[id]/role
 * Contract: 200 ok (returns sessionsRevoked), 400 invalid-role / role-portal-mismatch,
 *           401 no-session, 403 forbidden (RBAC), 404 not-found,
 *           409 same-role / last-admin-protection.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { ok, err } from '@/lib/result';

const getCurrentSessionMock = vi.fn();
const requireRoleMock = vi.fn();
const changeRoleMock = vi.fn();

vi.mock('@/lib/auth-session', () => ({
  getCurrentSession: (...args: unknown[]) => getCurrentSessionMock(...args),
}));

vi.mock('@/lib/rbac-guard', () => ({
  requireRole: (...args: unknown[]) => requireRoleMock(...args),
}));

vi.mock('@/modules/auth/application/change-role', () => ({
  changeRole: (...args: unknown[]) => changeRoleMock(...args),
}));

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

vi.mock('@/lib/request-id', () => ({
  requestIdFromHeaders: () => 'test-req-id',
}));

const adminSession = {
  user: { id: 'admin-1', email: 'admin@swecham.se', role: 'admin', status: 'active', displayName: 'Admin' },
  session: { id: 'sess-1' },
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
    getCurrentSessionMock.mockResolvedValueOnce(adminSession);
    requireRoleMock.mockResolvedValueOnce({ ok: true });
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
    getCurrentSessionMock.mockResolvedValueOnce(adminSession);
    requireRoleMock.mockResolvedValueOnce({ ok: true });

    const { POST } = await import('@/app/api/auth/users/[id]/role/route');
    const res = await POST(makeRequest({ newRole: 'superadmin' }), { params: routeParams });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('invalid-role');
    expect(changeRoleMock).not.toHaveBeenCalled();
  });

  it('400 on non-JSON body', async () => {
    getCurrentSessionMock.mockResolvedValueOnce(adminSession);
    requireRoleMock.mockResolvedValueOnce({ ok: true });

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

  it('401 when not signed in', async () => {
    getCurrentSessionMock.mockResolvedValueOnce(null);

    const { POST } = await import('@/app/api/auth/users/[id]/role/route');
    const res = await POST(makeRequest({ newRole: 'manager' }), { params: routeParams });

    expect(res.status).toBe(401);
  });

  it('403 when RBAC denies', async () => {
    getCurrentSessionMock.mockResolvedValueOnce(adminSession);
    requireRoleMock.mockResolvedValueOnce({ ok: false, reason: 'role-denied' });

    const { POST } = await import('@/app/api/auth/users/[id]/role/route');
    const res = await POST(makeRequest({ newRole: 'manager' }), { params: routeParams });

    expect(res.status).toBe(403);
  });

  it('404 when target user not found', async () => {
    getCurrentSessionMock.mockResolvedValueOnce(adminSession);
    requireRoleMock.mockResolvedValueOnce({ ok: true });
    changeRoleMock.mockResolvedValueOnce(err({ code: 'not-found' }));

    const { POST } = await import('@/app/api/auth/users/[id]/role/route');
    const res = await POST(makeRequest({ newRole: 'manager' }), { params: routeParams });

    expect(res.status).toBe(404);
  });

  it('409 on same-role', async () => {
    getCurrentSessionMock.mockResolvedValueOnce(adminSession);
    requireRoleMock.mockResolvedValueOnce({ ok: true });
    changeRoleMock.mockResolvedValueOnce(err({ code: 'same-role' }));

    const { POST } = await import('@/app/api/auth/users/[id]/role/route');
    const res = await POST(makeRequest({ newRole: 'manager' }), { params: routeParams });

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe('same-role');
  });

  it('400 on role-portal-mismatch (staff↔member boundary)', async () => {
    getCurrentSessionMock.mockResolvedValueOnce(adminSession);
    requireRoleMock.mockResolvedValueOnce({ ok: true });
    changeRoleMock.mockResolvedValueOnce(err({ code: 'role-portal-mismatch' }));

    const { POST } = await import('@/app/api/auth/users/[id]/role/route');
    const res = await POST(makeRequest({ newRole: 'member' }), { params: routeParams });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('role-portal-mismatch');
  });

  it('409 on last-admin-protection', async () => {
    getCurrentSessionMock.mockResolvedValueOnce(adminSession);
    requireRoleMock.mockResolvedValueOnce({ ok: true });
    changeRoleMock.mockResolvedValueOnce(err({ code: 'last-admin-protection' }));

    const { POST } = await import('@/app/api/auth/users/[id]/role/route');
    const res = await POST(makeRequest({ newRole: 'manager' }), { params: routeParams });

    expect(res.status).toBe(409);
  });
});
