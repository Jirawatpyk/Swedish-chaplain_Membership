/**
 * T111 — Disable-user contract test (contracts/auth-api.md § 8).
 *
 * Route: POST /api/auth/users/[id]/disable
 * Contract: 200 ok, 401 no-session, 403 forbidden (RBAC), 404 not-found,
 *           409 already-disabled / last-admin-protection.
 *
 * Mocks `@/lib/admin-context` directly — the route delegates all
 * session + RBAC guarding to `requireAdminContext()`, so that's the
 * seam the contract test should mock. (`requireAdminContext` has its
 * own unit tests at `tests/unit/lib/admin-context.test.ts`.)
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextResponse, NextRequest } from 'next/server';
import { ok, err } from '@/lib/result';

const requireAdminContextMock = vi.fn();
const disableUserMock = vi.fn();

vi.mock('@/lib/admin-context', () => ({
  requireAdminContext: (...args: unknown[]) => requireAdminContextMock(...args),
}));

vi.mock('@/modules/auth/application/disable-user', () => ({
  disableUser: (...args: unknown[]) => disableUserMock(...args),
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
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    disableUserMock.mockResolvedValueOnce(ok({ sessionsRevoked: 2 }));

    const { POST } = await import('@/app/api/auth/users/[id]/disable/route');
    const res = await POST(makeRequest(), { params: routeParams });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.sessionsRevoked).toBe(2);
  });

  it('401 when requireAdminContext rejects with no-session', async () => {
    requireAdminContextMock.mockResolvedValueOnce({
      response: NextResponse.json({ error: 'no-session' }, { status: 401 }),
    });

    const { POST } = await import('@/app/api/auth/users/[id]/disable/route');
    const res = await POST(makeRequest(), { params: routeParams });

    expect(res.status).toBe(401);
    // Use case MUST NOT be called on the rejection path.
    expect(disableUserMock).not.toHaveBeenCalled();
  });

  it('403 when requireAdminContext rejects with forbidden', async () => {
    requireAdminContextMock.mockResolvedValueOnce({
      response: NextResponse.json({ error: 'forbidden' }, { status: 403 }),
    });

    const { POST } = await import('@/app/api/auth/users/[id]/disable/route');
    const res = await POST(makeRequest(), { params: routeParams });

    expect(res.status).toBe(403);
    expect(disableUserMock).not.toHaveBeenCalled();
  });

  it('404 when target user not found', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    disableUserMock.mockResolvedValueOnce(err({ code: 'not-found' }));

    const { POST } = await import('@/app/api/auth/users/[id]/disable/route');
    const res = await POST(makeRequest(), { params: routeParams });

    expect(res.status).toBe(404);
  });

  it('409 when already disabled', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    disableUserMock.mockResolvedValueOnce(err({ code: 'already-disabled' }));

    const { POST } = await import('@/app/api/auth/users/[id]/disable/route');
    const res = await POST(makeRequest(), { params: routeParams });

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe('already-disabled');
  });

  it('409 on last-admin-protection', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    disableUserMock.mockResolvedValueOnce(err({ code: 'last-admin-protection' }));

    const { POST } = await import('@/app/api/auth/users/[id]/disable/route');
    const res = await POST(makeRequest(), { params: routeParams });

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe('last-admin-protection');
  });
});
