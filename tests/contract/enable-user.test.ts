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

const requireAdminContextMock = vi.fn();
const enableUserMock = vi.fn();

vi.mock('@/lib/admin-context', () => ({
  requireAdminContext: (...args: unknown[]) => requireAdminContextMock(...args),
}));

vi.mock('@/modules/auth/application/enable-user', () => ({
  enableUser: (...args: unknown[]) => enableUserMock(...args),
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
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
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

  it('401 when requireAdminContext rejects with no-session', async () => {
    requireAdminContextMock.mockResolvedValueOnce({
      response: NextResponse.json({ error: 'no-session' }, { status: 401 }),
    });

    const { POST } = await import('@/app/api/auth/users/[id]/enable/route');
    const res = await POST(makeRequest(), { params: routeParams });

    expect(res.status).toBe(401);
    expect(enableUserMock).not.toHaveBeenCalled();
  });

  it('403 when requireAdminContext rejects with forbidden', async () => {
    requireAdminContextMock.mockResolvedValueOnce({
      response: NextResponse.json({ error: 'forbidden' }, { status: 403 }),
    });

    const { POST } = await import('@/app/api/auth/users/[id]/enable/route');
    const res = await POST(makeRequest(), { params: routeParams });

    expect(res.status).toBe(403);
    expect(enableUserMock).not.toHaveBeenCalled();
  });

  it('404 when target user not found', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    enableUserMock.mockResolvedValueOnce(err({ code: 'not-found' }));

    const { POST } = await import('@/app/api/auth/users/[id]/enable/route');
    const res = await POST(makeRequest(), { params: routeParams });

    expect(res.status).toBe(404);
  });

  it('409 when not-disabled (already active)', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    enableUserMock.mockResolvedValueOnce(err({ code: 'not-disabled' }));

    const { POST } = await import('@/app/api/auth/users/[id]/enable/route');
    const res = await POST(makeRequest(), { params: routeParams });

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe('not-disabled');
  });
});
