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
 * `requireApiPermission()` for its session + RBAC prologue (same
 * pattern as the 3 other admin lifecycle routes).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextResponse, NextRequest } from 'next/server';
import { POST } from '@/app/api/auth/invite/route';
import { mappedLegacy } from '@/modules/auth/domain/permissions/legacy-shim';
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

const requireApiPermissionMock = vi.fn();
vi.mock('@/lib/rbac', () => ({
  requireApiPermission: (...args: unknown[]) => requireApiPermissionMock(...args),
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
    requireApiPermissionMock.mockResolvedValue(adminContext);
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

  it('401 when requireApiPermission rejects with no-session', async () => {
    requireApiPermissionMock.mockResolvedValueOnce({
      response: NextResponse.json({ error: 'no-session' }, { status: 401 }),
    });

    const response = await POST(
      makeRequest({ email: 'x@y.com', role: 'manager' }),
    );
    expect(response.status).toBe(401);
    expect(createUserMock).not.toHaveBeenCalled();
  });

  it('403 when requireApiPermission rejects with forbidden (manager denied)', async () => {
    requireApiPermissionMock.mockResolvedValueOnce({
      response: NextResponse.json({ error: 'forbidden' }, { status: 403 }),
    });

    const response = await POST(
      makeRequest({ email: 'x@y.com', role: 'member' }),
    );
    expect(response.status).toBe(403);
    expect(createUserMock).not.toHaveBeenCalled();
  });

  it('400 on invalid role', async () => {
    requireApiPermissionMock.mockResolvedValue(adminContext);

    const response = await POST(
      makeRequest({ email: 'x@y.com', role: 'superuser' }),
    );
    expect(response.status).toBe(400);
  });

  it('400 on malformed email', async () => {
    requireApiPermissionMock.mockResolvedValue(adminContext);

    const response = await POST(
      makeRequest({ email: 'not-an-email', role: 'member' }),
    );
    expect(response.status).toBe(400);
  });

  it('409 on email-taken', async () => {
    requireApiPermissionMock.mockResolvedValue(adminContext);
    createUserMock.mockResolvedValueOnce(err({ code: 'email-taken' }));

    const response = await POST(
      makeRequest({ email: 'existing@swecham.test', role: 'manager' }),
    );
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.error).toBe('email-taken');
  });

  /**
   * 016 § 7.1 step-2 per-TARGET escalation gate (post-remediation re-review,
   * security F-5 unlock condition).
   *
   * This route is the one of the six users routes where the step-2 decision
   * comes from the request BODY (`role !== 'member'`), not from a target row —
   * which is exactly why the codemod that pinned the other five never reached
   * it, and why an earlier re-review proved the block was deletable (and its
   * condition invertible) with the whole suite staying green. On the ON leg
   * that would let a plain admin — who holds `users.member_accounts` but not
   * `users.manage` — mint new staff accounts.
   *
   * Three pins, mutation-proven (deleting the block at route.ts § step 2 and
   * inverting its condition each turn at least two of these red):
   */
  describe('§ 7.1 step-2 per-TARGET escalation gate', () => {
    it('a STAFF-role invite consults users.manage and honours its rejection', async () => {
      requireApiPermissionMock
        .mockResolvedValueOnce(adminContext)
        .mockResolvedValueOnce({
          response: NextResponse.json(
            { error: { code: 'forbidden' } },
            { status: 403 },
          ),
        });

      const response = await POST(
        makeRequest({ email: 'new-staff@swecham.test', role: 'admin' }),
      );
      expect(response.status).toBe(403);
      expect(createUserMock).not.toHaveBeenCalled();
      expect(requireApiPermissionMock).toHaveBeenCalledTimes(2);
      expect(requireApiPermissionMock).toHaveBeenNthCalledWith(
        2,
        expect.anything(),
        'users.manage',
        mappedLegacy('auth:user', 'write'),
      );
    });

    it('a MEMBER-role invite never consults users.manage', async () => {
      requireApiPermissionMock.mockResolvedValue(adminContext);
      createUserMock.mockResolvedValueOnce(
        ok({
          user: {
            id: 'new-id',
            email: 'new-member@swecham.test',
            role: 'member',
            status: 'pending',
            displayName: 'New Member',
          },
          invitationId: 'a'.repeat(64),
        }),
      );

      const response = await POST(
        makeRequest({ email: 'new-member@swecham.test', role: 'member' }),
      );
      expect(response.status).toBe(201);
      expect(requireApiPermissionMock).toHaveBeenCalledTimes(1);
      expect(requireApiPermissionMock).toHaveBeenNthCalledWith(
        1,
        expect.anything(),
        'users.member_accounts',
        mappedLegacy('auth:user', 'write'),
      );
    });

    it('a STAFF-role invite proceeds when the step-2 gate allows', async () => {
      requireApiPermissionMock.mockResolvedValue(adminContext);
      createUserMock.mockResolvedValueOnce(
        ok({
          user: {
            id: 'new-id',
            email: 'new-staff@swecham.test',
            role: 'manager',
            status: 'pending',
            displayName: 'New Staff',
          },
          invitationId: 'a'.repeat(64),
        }),
      );

      const response = await POST(
        makeRequest({ email: 'new-staff@swecham.test', role: 'manager' }),
      );
      expect(response.status).toBe(201);
      expect(requireApiPermissionMock).toHaveBeenCalledTimes(2);
      expect(requireApiPermissionMock).toHaveBeenNthCalledWith(
        2,
        expect.anything(),
        'users.manage',
        mappedLegacy('auth:user', 'write'),
      );
    });
  });

  // N4 (Round 3) — B3 outer try/catch.
  it('500 with requestId when invite throws (infra error)', async () => {
    const { assertRoute500WithRequestId } = await import(
      './_helpers/assert-route-500'
    );
    requireApiPermissionMock.mockResolvedValue(adminContext);
    createUserMock.mockRejectedValueOnce(new Error('neon: connection terminated'));

    const response = await POST(
      makeRequest({ email: 'new@swecham.test', role: 'manager' }),
    );
    await assertRoute500WithRequestId(response);
  });
});
