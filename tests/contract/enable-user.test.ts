/**
 * T112 — Enable-user contract test (contracts/auth-api.md § 9).
 *
 * Route: POST /api/auth/users/[id]/enable
 * Contract: 200 ok, 401 no-session, 403 forbidden (RBAC), 404 not-found,
 *           409 not-disabled.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { ok, err } from '@/lib/result';

const getCurrentSessionMock = vi.fn();
const requireRoleMock = vi.fn();
const enableUserMock = vi.fn();

vi.mock('@/lib/auth-session', () => ({
  getCurrentSession: (...args: unknown[]) => getCurrentSessionMock(...args),
}));

vi.mock('@/lib/rbac-guard', () => ({
  requireRole: (...args: unknown[]) => requireRoleMock(...args),
}));

vi.mock('@/modules/auth/application/enable-user', () => ({
  enableUser: (...args: unknown[]) => enableUserMock(...args),
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
    getCurrentSessionMock.mockResolvedValueOnce(adminSession);
    requireRoleMock.mockResolvedValueOnce({ ok: true });
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

  it('401 when not signed in', async () => {
    getCurrentSessionMock.mockResolvedValueOnce(null);

    const { POST } = await import('@/app/api/auth/users/[id]/enable/route');
    const res = await POST(makeRequest(), { params: routeParams });

    expect(res.status).toBe(401);
    expect(enableUserMock).not.toHaveBeenCalled();
  });

  it('403 when RBAC denies (manager trying to enable)', async () => {
    getCurrentSessionMock.mockResolvedValueOnce({
      user: { id: 'mgr-1', email: 'mgr@swecham.se', role: 'manager', status: 'active', displayName: 'Mgr' },
      session: { id: 'sess-mgr' },
    });
    requireRoleMock.mockResolvedValueOnce({ ok: false, reason: 'role-denied' });

    const { POST } = await import('@/app/api/auth/users/[id]/enable/route');
    const res = await POST(makeRequest(), { params: routeParams });

    expect(res.status).toBe(403);
    expect(enableUserMock).not.toHaveBeenCalled();
  });

  it('404 when target user not found', async () => {
    getCurrentSessionMock.mockResolvedValueOnce(adminSession);
    requireRoleMock.mockResolvedValueOnce({ ok: true });
    enableUserMock.mockResolvedValueOnce(err({ code: 'not-found' }));

    const { POST } = await import('@/app/api/auth/users/[id]/enable/route');
    const res = await POST(makeRequest(), { params: routeParams });

    expect(res.status).toBe(404);
  });

  it('409 when not-disabled (already active)', async () => {
    getCurrentSessionMock.mockResolvedValueOnce(adminSession);
    requireRoleMock.mockResolvedValueOnce({ ok: true });
    enableUserMock.mockResolvedValueOnce(err({ code: 'not-disabled' }));

    const { POST } = await import('@/app/api/auth/users/[id]/enable/route');
    const res = await POST(makeRequest(), { params: routeParams });

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe('not-disabled');
  });
});
