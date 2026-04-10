/**
 * T109 — POST /api/auth/invite contract test.
 *
 * Cases (contracts/auth-api.md § 6):
 *   - 201 created — admin invites new user
 *   - 400 invalid-input (missing email, malformed, invalid role)
 *   - 401 no-session
 *   - 403 forbidden (non-admin caller)
 *   - 409 email-taken
 *
 * Mocks `@/lib/admin-context` directly — the route uses
 * `requireAdminContext()` for its session + RBAC prologue (same
 * pattern as the 3 other admin lifecycle routes).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextResponse, NextRequest } from 'next/server';
import { POST } from '@/app/api/auth/invite/route';
import { ok, err } from '@/lib/result';

const createUserMock = vi.fn();
vi.mock('@/modules/auth/application/create-user', async () => {
  const actual = await vi.importActual<
    typeof import('@/modules/auth/application/create-user')
  >('@/modules/auth/application/create-user');
  return {
    ...actual,
    createUser: (...args: unknown[]) => createUserMock(...args),
  };
});

const requireAdminContextMock = vi.fn();
vi.mock('@/lib/admin-context', () => ({
  requireAdminContext: (...args: unknown[]) => requireAdminContextMock(...args),
}));

const adminContext = {
  current: {
    user: {
      id: '00000000-0000-0000-0000-000000000001',
      email: 'admin@test',
      role: 'admin',
      status: 'active',
      displayName: 'Admin',
    },
    session: { id: 'sess-1' },
  },
  sourceIp: '203.0.113.9',
  requestId: 'test-req-id',
};

function makeRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/auth/invite', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-forwarded-for': '203.0.113.9',
    },
    body: JSON.stringify(body),
  });
}

describe('POST /api/auth/invite', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('201 created on admin invite success', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    createUserMock.mockResolvedValueOnce(
      ok({
        user: {
          id: 'new-id',
          email: 'new@swecham.test',
          role: 'manager',
          status: 'pending',
          displayName: 'New User',
        },
        invitationId: 'a'.repeat(64),
      }),
    );

    const response = await POST(
      makeRequest({
        email: 'new@swecham.test',
        role: 'manager',
        displayName: 'New User',
      }),
    );
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.user.email).toBe('new@swecham.test');
    expect(body.user.role).toBe('manager');
    expect(body.user.status).toBe('pending');
  });

  it('401 when requireAdminContext rejects with no-session', async () => {
    requireAdminContextMock.mockResolvedValueOnce({
      response: NextResponse.json({ error: 'no-session' }, { status: 401 }),
    });

    const response = await POST(
      makeRequest({ email: 'x@y.com', role: 'manager' }),
    );
    expect(response.status).toBe(401);
    expect(createUserMock).not.toHaveBeenCalled();
  });

  it('403 when requireAdminContext rejects with forbidden (manager denied)', async () => {
    requireAdminContextMock.mockResolvedValueOnce({
      response: NextResponse.json({ error: 'forbidden' }, { status: 403 }),
    });

    const response = await POST(
      makeRequest({ email: 'x@y.com', role: 'member' }),
    );
    expect(response.status).toBe(403);
    expect(createUserMock).not.toHaveBeenCalled();
  });

  it('400 on invalid role', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);

    const response = await POST(
      makeRequest({ email: 'x@y.com', role: 'superuser' }),
    );
    expect(response.status).toBe(400);
  });

  it('400 on malformed email', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);

    const response = await POST(
      makeRequest({ email: 'not-an-email', role: 'member' }),
    );
    expect(response.status).toBe(400);
  });

  it('409 on email-taken', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    createUserMock.mockResolvedValueOnce(err({ code: 'email-taken' }));

    const response = await POST(
      makeRequest({ email: 'existing@swecham.test', role: 'manager' }),
    );
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.error).toBe('email-taken');
  });
});
