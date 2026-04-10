/**
 * T111 — Disable-user contract test (contracts/auth-api.md § 8).
 *
 * Route: POST /api/auth/users/[id]/disable
 * Contract: 200 ok, 401 no-session, 403 forbidden (RBAC), 404 not-found,
 *           409 already-disabled / last-admin-protection.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { ok, err } from '@/lib/result';

const getCurrentSessionMock = vi.fn();
const requireRoleMock = vi.fn();
const disableUserMock = vi.fn();

vi.mock('@/lib/auth-session', () => ({
  getCurrentSession: (...args: unknown[]) => getCurrentSessionMock(...args),
}));

vi.mock('@/lib/rbac-guard', () => ({
  requireRole: (...args: unknown[]) => requireRoleMock(...args),
}));

vi.mock('@/modules/auth/application/disable-user', () => ({
  disableUser: (...args: unknown[]) => disableUserMock(...args),
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
  return new NextRequest('http://localhost/api/auth/users/target-1/disable', {
    method: 'POST',
    headers: { 'x-forwarded-for': '203.0.113.5' },
  });
}

const routeParams = Promise.resolve({ id: 'target-1' });

describe('contract: POST /api/auth/users/[id]/disable (T111)', () => {
  afterEach(() => { vi.clearAllMocks(); });

  it('200 on success — returns sessionsRevoked', async () => {
    getCurrentSessionMock.mockResolvedValueOnce(adminSession);
    requireRoleMock.mockResolvedValueOnce({ ok: true });
    disableUserMock.mockResolvedValueOnce(ok({ sessionsRevoked: 2 }));

    const { POST } = await import('@/app/api/auth/users/[id]/disable/route');
    const res = await POST(makeRequest(), { params: routeParams });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.sessionsRevoked).toBe(2);
  });

  it('401 when not signed in', async () => {
    getCurrentSessionMock.mockResolvedValueOnce(null);

    const { POST } = await import('@/app/api/auth/users/[id]/disable/route');
    const res = await POST(makeRequest(), { params: routeParams });

    expect(res.status).toBe(401);
  });

  it('403 when RBAC denies', async () => {
    getCurrentSessionMock.mockResolvedValueOnce(adminSession);
    requireRoleMock.mockResolvedValueOnce({ ok: false, reason: 'role-denied' });

    const { POST } = await import('@/app/api/auth/users/[id]/disable/route');
    const res = await POST(makeRequest(), { params: routeParams });

    expect(res.status).toBe(403);
  });

  it('404 when target user not found', async () => {
    getCurrentSessionMock.mockResolvedValueOnce(adminSession);
    requireRoleMock.mockResolvedValueOnce({ ok: true });
    disableUserMock.mockResolvedValueOnce(err({ code: 'not-found' }));

    const { POST } = await import('@/app/api/auth/users/[id]/disable/route');
    const res = await POST(makeRequest(), { params: routeParams });

    expect(res.status).toBe(404);
  });

  it('409 when already disabled', async () => {
    getCurrentSessionMock.mockResolvedValueOnce(adminSession);
    requireRoleMock.mockResolvedValueOnce({ ok: true });
    disableUserMock.mockResolvedValueOnce(err({ code: 'already-disabled' }));

    const { POST } = await import('@/app/api/auth/users/[id]/disable/route');
    const res = await POST(makeRequest(), { params: routeParams });

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe('already-disabled');
  });

  it('409 on last-admin-protection', async () => {
    getCurrentSessionMock.mockResolvedValueOnce(adminSession);
    requireRoleMock.mockResolvedValueOnce({ ok: true });
    disableUserMock.mockResolvedValueOnce(err({ code: 'last-admin-protection' }));

    const { POST } = await import('@/app/api/auth/users/[id]/disable/route');
    const res = await POST(makeRequest(), { params: routeParams });

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe('last-admin-protection');
  });
});
