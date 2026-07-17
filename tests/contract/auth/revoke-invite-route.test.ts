/**
 * Contract test: POST /api/auth/users/[id]/revoke-invite
 * (Staff Invitation Lifecycle, Task 4).
 *
 * Exposes Task 3's `revokeInvitation` use case over HTTP, admin-gated via
 * `requireAdminContext`. DELETE-semantics on the auth surface: permanently
 * removes a `pending` invited user so a typo'd / wrong invite can be
 * removed and the email freed for a fresh invite. No rate limiting — this
 * is not an email-sending action. Mock style follows
 * tests/contract/auth/reissue-invite-route.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import { ok, err } from '@/lib/result';

const requireAdminContextMock = vi.fn();
const revokeInvitationMock = vi.fn();

vi.mock('@/lib/admin-context', () => ({
  requireAdminContext: (...args: unknown[]) => requireAdminContextMock(...args),
}));
vi.mock('@/modules/auth', () => ({
  revokeInvitation: (...args: unknown[]) => revokeInvitationMock(...args),
  asUserId: (id: string) => id,
}));
vi.mock('@/lib/tenant-context', () => ({
  resolveTenantFromRequest: () => ({ slug: 'test-swecham', __brand: true }),
}));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

const adminContext = {
  current: {
    user: { id: 'admin-1', email: 'a@b.co', role: 'admin', status: 'active', displayName: 'A' },
    session: { id: 'sess-1' },
  },
  sourceIp: '203.0.113.5',
  requestId: 'req-revoke-1',
};

function makeRequest(id: string): NextRequest {
  return new NextRequest(`http://localhost/api/auth/users/${id}/revoke-invite`, {
    method: 'POST',
  });
}

function makeParams(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

describe('contract: POST /api/auth/users/[id]/revoke-invite (Task 4)', () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.resetAllMocks();
  });

  it('200 — admin + ok, calls the use case with tenantId=slug + userId=route param (not the admin id)', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    revokeInvitationMock.mockResolvedValueOnce(ok({ deleted: true }));

    const { POST } = await import('@/app/api/auth/users/[id]/revoke-invite/route');
    const res = await POST(makeRequest('user-1'), makeParams('user-1'));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);

    expect(revokeInvitationMock).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        actorUserId: 'admin-1',
        tenantId: 'test-swecham',
        sourceIp: '203.0.113.5',
        requestId: 'req-revoke-1',
      }),
    );
  });

  it('404 — not-pending-or-not-found', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    revokeInvitationMock.mockResolvedValueOnce(err({ code: 'not-pending-or-not-found' }));

    const { POST } = await import('@/app/api/auth/users/[id]/revoke-invite/route');
    const res = await POST(makeRequest('user-1'), makeParams('user-1'));
    expect(res.status).toBe(404);
  });

  it('401 — unauthenticated', async () => {
    requireAdminContextMock.mockResolvedValueOnce({
      response: NextResponse.json({ error: 'no-session' }, { status: 401 }),
    });

    const { POST } = await import('@/app/api/auth/users/[id]/revoke-invite/route');
    const res = await POST(makeRequest('user-1'), makeParams('user-1'));
    expect(res.status).toBe(401);
    expect(revokeInvitationMock).not.toHaveBeenCalled();
  });
});
