/**
 * `requireAdminContext` unit test.
 *
 * The helper is the single gate for 3 admin lifecycle routes
 * (`/api/auth/users/[id]/{disable,enable,role}`). It has 4
 * reachable branches that directly govern HTTP status mapping:
 *
 *   1. `getCurrentSession()` returns null → 401 `no-session`
 *   2. `requireRole()` returns `{ ok: false }` → 403 `forbidden`
 *   3. Both succeed → `AdminContext`
 *   4. Either throws → 500 `server-error` (infrastructure failure)
 *
 * The 401-before-403 ordering is an enumeration-safety invariant
 * (see file comment in admin-context.ts). This test pins the
 * ordering so a future edit that swaps them fails here.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

// Mock the two helpers this module calls — every test tunes them.
const getCurrentSessionMock = vi.fn();
const requireRoleMock = vi.fn();

vi.mock('@/lib/auth-session', () => ({
  getCurrentSession: () => getCurrentSessionMock(),
}));

vi.mock('@/lib/rbac-guard', () => ({
  requireRole: (...args: unknown[]) => requireRoleMock(...args),
}));

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

const { requireAdminContext } = await import('@/lib/admin-context');

function makeRequest(): NextRequest {
  return new NextRequest('http://localhost/api/auth/users/u1/disable', {
    method: 'POST',
    headers: {
      'x-forwarded-for': '203.0.113.5',
      'x-request-id': '019d721d-0000-0000-0000-000000000001',
    },
  });
}

describe('requireAdminContext', () => {
  beforeEach(() => {
    getCurrentSessionMock.mockReset();
    requireRoleMock.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns 401 no-session when getCurrentSession returns null', async () => {
    getCurrentSessionMock.mockResolvedValueOnce(null);

    const result = await requireAdminContext(makeRequest());

    expect('response' in result).toBe(true);
    if (!('response' in result)) return;
    expect(result.response.status).toBe(401);
    const body = await result.response.json();
    expect(body.error).toBe('no-session');
    // requireRole must NOT have been called — 401-before-403 ordering
    // is an enumeration-safety invariant (anonymous probes must not
    // be able to infer role gating on a protected resource).
    expect(requireRoleMock).not.toHaveBeenCalled();
  });

  it('returns 403 forbidden when requireRole denies', async () => {
    getCurrentSessionMock.mockResolvedValueOnce({
      session: { id: 's1' },
      user: { id: 'u1', role: 'manager' },
    });
    requireRoleMock.mockResolvedValueOnce({ ok: false, reason: 'role-denied' });

    const result = await requireAdminContext(makeRequest());

    expect('response' in result).toBe(true);
    if (!('response' in result)) return;
    expect(result.response.status).toBe(403);
    const body = await result.response.json();
    expect(body.error).toBe('forbidden');
    // Default policy is { resource: 'auth:user', action: 'write' }
    expect(requireRoleMock).toHaveBeenCalledWith(
      expect.anything(),
      'auth:user',
      'write',
      expect.objectContaining({ sourceIp: '203.0.113.5' }),
    );
  });

  it('returns AdminContext on happy path', async () => {
    const session = {
      session: { id: 's1' },
      user: { id: 'u1', role: 'admin' },
    };
    getCurrentSessionMock.mockResolvedValueOnce(session);
    requireRoleMock.mockResolvedValueOnce({ ok: true });

    const result = await requireAdminContext(makeRequest());

    expect('response' in result).toBe(false);
    if ('response' in result) return;
    expect(result.current).toBe(session);
    expect(result.sourceIp).toBe('203.0.113.5');
    expect(result.requestId).toBe('019d721d-0000-0000-0000-000000000001');
  });

  it('forwards a custom policy override to requireRole', async () => {
    getCurrentSessionMock.mockResolvedValueOnce({
      session: { id: 's1' },
      user: { id: 'u1', role: 'admin' },
    });
    requireRoleMock.mockResolvedValueOnce({ ok: true });

    await requireAdminContext(makeRequest(), {
      resource: 'auth:audit',
      action: 'read',
    });

    expect(requireRoleMock).toHaveBeenCalledWith(
      expect.anything(),
      'auth:audit',
      'read',
      expect.anything(),
    );
  });

  it('returns 500 server-error when getCurrentSession throws', async () => {
    getCurrentSessionMock.mockRejectedValueOnce(new Error('Neon down'));

    const result = await requireAdminContext(makeRequest());

    expect('response' in result).toBe(true);
    if (!('response' in result)) return;
    expect(result.response.status).toBe(500);
    const body = await result.response.json();
    expect(body.error).toBe('server-error');
  });

  it('returns 500 server-error when requireRole throws', async () => {
    getCurrentSessionMock.mockResolvedValueOnce({
      session: { id: 's1' },
      user: { id: 'u1', role: 'admin' },
    });
    requireRoleMock.mockRejectedValueOnce(new Error('audit repo down'));

    const result = await requireAdminContext(makeRequest());

    expect('response' in result).toBe(true);
    if (!('response' in result)) return;
    expect(result.response.status).toBe(500);
  });
});
