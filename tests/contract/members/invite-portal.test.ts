/**
 * Contract test: POST /api/members/[memberId]/contacts/[contactId]/invite-portal
 *
 * Mocks the admin-context, tenant resolver, members deps, and the
 * `invitePortal` use case so the route handler runs without touching the
 * real DB, session, or F1 auth. Asserts the response status + body shape
 * for all 8 branches of the route handler.
 *
 * FR-012 (T046/T056) — invite contact to member portal.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import { ok, err } from '@/lib/result';

const requireAdminContextMock = vi.fn();
const invitePortalMock = vi.fn();
const buildMembersDepsMock = vi.fn();

vi.mock('@/lib/admin-context', () => ({
  requireAdminContext: (...args: unknown[]) => requireAdminContextMock(...args),
}));
vi.mock('@/modules/members/members-deps', () => ({
  buildMembersDeps: (...args: unknown[]) => buildMembersDepsMock(...args),
}));
vi.mock('@/modules/members', async () => {
  const actual = await vi.importActual<typeof import('@/modules/members')>(
    '@/modules/members',
  );
  return {
    ...actual,
    invitePortal: (...args: unknown[]) => invitePortalMock(...args),
  };
});
vi.mock('@/lib/tenant-context', () => ({
  resolveTenantFromRequest: () => ({ slug: 'test-swecham', __brand: true }),
}));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
// F1 createUser is imported by the route at module load time — must be mocked
// even though this test never calls it directly (the adapter is inline in the route).
vi.mock('@/modules/auth', () => ({
  createUser: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const adminContext = {
  current: {
    user: {
      id: 'admin-1',
      email: 'a@b.co',
      role: 'admin',
      status: 'active',
      displayName: 'A',
    },
    session: { id: 's1' },
  },
  sourceIp: '203.0.113.5',
  requestId: 'req-1',
};

function makeRequest(): NextRequest {
  return new NextRequest(
    'http://localhost:3100/api/members/m1/contacts/c1/invite-portal',
    { method: 'POST' },
  );
}

/** Resolved params Promise the route handler expects. */
const resolvedParams = Promise.resolve({ memberId: 'm1', contactId: 'c1' });

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe(
  'contract: POST /api/members/[memberId]/contacts/[contactId]/invite-portal',
  () => {
    afterEach(() => vi.clearAllMocks());

    it('200 success — returns user_id + email', async () => {
      requireAdminContextMock.mockResolvedValueOnce(adminContext);
      buildMembersDepsMock.mockReturnValueOnce({ contactRepo: {} });
      invitePortalMock.mockResolvedValueOnce(
        ok({ userId: 'usr-42', email: 'contact@fogmaker.se' }),
      );

      const { POST } = await import(
        '@/app/api/members/[memberId]/contacts/[contactId]/invite-portal/route'
      );
      const res = await POST(makeRequest(), { params: resolvedParams });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.user_id).toBe('usr-42');
      expect(body.email).toBe('contact@fogmaker.se');
    });

    it('404 not_found — contact does not exist', async () => {
      requireAdminContextMock.mockResolvedValueOnce(adminContext);
      buildMembersDepsMock.mockReturnValueOnce({ contactRepo: {} });
      invitePortalMock.mockResolvedValueOnce(err({ code: 'not_found' }));

      const { POST } = await import(
        '@/app/api/members/[memberId]/contacts/[contactId]/invite-portal/route'
      );
      const res = await POST(makeRequest(), { params: resolvedParams });

      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error.code).toBe('not_found');
      expect(typeof body.error.message).toBe('string');
    });

    it('409 already_linked — contact already has a portal account', async () => {
      requireAdminContextMock.mockResolvedValueOnce(adminContext);
      buildMembersDepsMock.mockReturnValueOnce({ contactRepo: {} });
      invitePortalMock.mockResolvedValueOnce(err({ code: 'already_linked' }));

      const { POST } = await import(
        '@/app/api/members/[memberId]/contacts/[contactId]/invite-portal/route'
      );
      const res = await POST(makeRequest(), { params: resolvedParams });

      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error.code).toBe('already_linked');
      expect(typeof body.error.message).toBe('string');
    });

    it('400 no_email — contact has no email address on record', async () => {
      requireAdminContextMock.mockResolvedValueOnce(adminContext);
      buildMembersDepsMock.mockReturnValueOnce({ contactRepo: {} });
      invitePortalMock.mockResolvedValueOnce(err({ code: 'no_email' }));

      const { POST } = await import(
        '@/app/api/members/[memberId]/contacts/[contactId]/invite-portal/route'
      );
      const res = await POST(makeRequest(), { params: resolvedParams });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe('no_email');
      expect(typeof body.error.message).toBe('string');
    });

    it('400 invalid_email — contact email fails format validation', async () => {
      requireAdminContextMock.mockResolvedValueOnce(adminContext);
      buildMembersDepsMock.mockReturnValueOnce({ contactRepo: {} });
      invitePortalMock.mockResolvedValueOnce(err({ code: 'invalid_email' }));

      const { POST } = await import(
        '@/app/api/members/[memberId]/contacts/[contactId]/invite-portal/route'
      );
      const res = await POST(makeRequest(), { params: resolvedParams });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe('invalid_email');
      expect(typeof body.error.message).toBe('string');
    });

    it('409 email_taken — email already registered to another account', async () => {
      requireAdminContextMock.mockResolvedValueOnce(adminContext);
      buildMembersDepsMock.mockReturnValueOnce({ contactRepo: {} });
      invitePortalMock.mockResolvedValueOnce(err({ code: 'email_taken' }));

      const { POST } = await import(
        '@/app/api/members/[memberId]/contacts/[contactId]/invite-portal/route'
      );
      const res = await POST(makeRequest(), { params: resolvedParams });

      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error.code).toBe('email_taken');
      expect(typeof body.error.message).toBe('string');
    });

    it('500 server_error — unexpected failure from use case', async () => {
      requireAdminContextMock.mockResolvedValueOnce(adminContext);
      buildMembersDepsMock.mockReturnValueOnce({ contactRepo: {} });
      invitePortalMock.mockResolvedValueOnce(err({ code: 'server_error' }));

      const { POST } = await import(
        '@/app/api/members/[memberId]/contacts/[contactId]/invite-portal/route'
      );
      const res = await POST(makeRequest(), { params: resolvedParams });

      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.error.code).toBe('server_error');
      expect(typeof body.error.message).toBe('string');
    });

    it('401 unauthenticated — requireAdminContext rejects the request', async () => {
      requireAdminContextMock.mockResolvedValueOnce({
        response: NextResponse.json(
          { error: { code: 'unauthenticated', message: 'Not signed in.' } },
          { status: 401 },
        ),
      });

      const { POST } = await import(
        '@/app/api/members/[memberId]/contacts/[contactId]/invite-portal/route'
      );
      const res = await POST(makeRequest(), { params: resolvedParams });

      expect(res.status).toBe(401);
      // invitePortal must not be called — RBAC gate should short-circuit
      expect(invitePortalMock).not.toHaveBeenCalled();
    });
  },
);
