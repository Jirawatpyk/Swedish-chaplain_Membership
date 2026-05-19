/**
 * Contract tests for POST /api/auth/invite — memberId extension (F1 spec:672-678).
 *
 * Gap 1 scenarios deferred by the prior implementer:
 *   (b) invalid memberId UUID format → 400 invalid-input
 *   (d) role=admin + memberId → 400 invalid-input (explicit rejection, not silent ignore)
 *   (csrf) missing Origin → behaviour exercised through the route — CSRF is proxy-level
 *          but the route handler is invoked directly here (no proxy); we document the
 *          expected proxy-level guard with a note and exercise the 401/403 path via
 *          requireAdminContext (same pattern as invite.test.ts).
 *
 * Pattern: direct handler invocation + vi.mock of requireAdminContext + inviteUserForMember
 * (same technique as tests/contract/invite.test.ts — no MSW / no real HTTP).
 *
 * CSRF note: The Origin allow-list is enforced by `src/proxy.ts` (checkCsrf), which runs
 * BEFORE the route handler. A missing-Origin POST to /api/auth/invite in production
 * returns 403 from the proxy layer, never reaching the handler. The proxy-level contract
 * is covered exhaustively by tests/contract/csrf.test.ts. Here we confirm the route
 * handler itself does NOT re-implement a parallel CSRF check (that would be defence-in-
 * depth duplication) — i.e. a missing-Origin request that somehow bypasses the proxy
 * (e.g. direct invocation in tests) is handled only by requireAdminContext (session gate),
 * not by a secondary Origin check in the route.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { NextResponse, NextRequest } from 'next/server';
import { ok, err } from '@/lib/result';

// Type-only — the actual POST reference is loaded inside beforeAll
// (see flake-fix note on the describe block).
type InviteRouteModule = typeof import('@/app/api/auth/invite/route');

// ---------------------------------------------------------------------------
// Mock requireAdminContext — same approach as tests/contract/invite.test.ts.
// ---------------------------------------------------------------------------
const requireAdminContextMock = vi.fn();
vi.mock('@/lib/admin-context', () => ({
  requireAdminContext: (...args: unknown[]) => requireAdminContextMock(...args),
}));

// ---------------------------------------------------------------------------
// Mock inviteUserForMember — the member-link branch of the route handler.
// We stub the barrel export (Constitution Principle III: cross-context
// imports go through the public barrel).
// ---------------------------------------------------------------------------
const inviteUserForMemberMock = vi.fn();
vi.mock('@/modules/members', async () => {
  const actual = await vi.importActual<typeof import('@/modules/members')>(
    '@/modules/members',
  );
  return {
    ...actual,
    inviteUserForMember: (...args: unknown[]) => inviteUserForMemberMock(...args),
  };
});

// ---------------------------------------------------------------------------
// Mock buildMembersDeps — we don't want real DB/Neon wiring in contract tests.
// ---------------------------------------------------------------------------
vi.mock('@/modules/members/members-deps', () => ({
  buildMembersDeps: () => ({
    contactRepo: {},
    memberRepo: {},
    audit: {},
    idFactory: { contactId: () => 'contact-uuid-001' },
  }),
}));

// ---------------------------------------------------------------------------
// Mock resolveTenantFromRequest — always returns the swecham tenant.
// ---------------------------------------------------------------------------
vi.mock('@/lib/tenant-context', () => ({
  resolveTenantFromRequest: () => ({ slug: 'swecham', id: 'tenant-uuid-001' }),
}));

// ---------------------------------------------------------------------------
// Mock logger to suppress noise in test output.
// ---------------------------------------------------------------------------
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

// ---------------------------------------------------------------------------
// Mock F1 createUser (re-exported from auth barrel — used by the route's
// Branch B and as the createUserPort adapter for Branch A).
// ---------------------------------------------------------------------------
const createUserMock = vi.fn();
vi.mock('@/modules/auth', async () => {
  const actual = await vi.importActual<typeof import('@/modules/auth')>(
    '@/modules/auth',
  );
  return {
    ...actual,
    createUser: (...args: unknown[]) => createUserMock(...args),
  };
});

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------
const adminContext = {
  current: {
    user: {
      id: '00000000-0000-0000-0000-000000000001',
      email: 'admin@swecham.test',
      role: 'admin' as const,
      status: 'active' as const,
      displayName: 'Test Admin',
    },
    session: { id: 'sess-admin-1' },
  },
  sourceIp: '203.0.113.1',
  requestId: 'req-contract-001',
};

const VALID_MEMBER_UUID = '11111111-1111-4111-8111-111111111111';

function makeRequest(body: unknown, headers?: Record<string, string>): NextRequest {
  return new NextRequest('http://localhost/api/auth/invite', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-forwarded-for': '203.0.113.1',
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// Flake-fix (post-Round-4 QA): the FIRST `it()` here used to pay the
// full route-module compile + import cost (`@/app/api/auth/invite/route`
// drags the auth + tenant + members module trees — ~2.5s standalone /
// ~10-30s under parallel load + V8 coverage transform). The dynamic
// import was previously inside each `it()`, so the first one
// non-deterministically blew through the 30s testTimeout when scheduled
// against ~340 contemporary test files. Moved to `beforeAll` which
// (a) runs under the global 60s `hookTimeout` (vitest.config.ts) and
// (b) pays the cost deterministically once per describe block — every
// subsequent `it()` uses the cached `POST` reference for free.
describe('contract: POST /api/auth/invite — memberId extension (Gap 1)', () => {
  let POST: InviteRouteModule['POST'];

  beforeAll(async () => {
    POST = (await import('@/app/api/auth/invite/route')).POST;
  }, 180_000);
  // ↑ 180s budget for the route-module cold load. The route drags the
  // auth + tenant + members trees, and under full-parallel `pnpm vitest run`
  // (~340 contemporary test files, each worker independently compiles +
  // imports its slice on first touch) the cost can climb past the
  // 60s global `hookTimeout`. Standalone the import lands in ~10s; under
  // worker contention it lands closer to 90s. 180s gives 2× headroom.

  afterEach(() => {
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // (b) invalid memberId UUID format → 400 invalid-input
  // -------------------------------------------------------------------------
  describe('(b) invalid memberId UUID format', () => {
    it('400 when memberId is a non-UUID string', async () => {
      requireAdminContextMock.mockResolvedValueOnce(adminContext);

      const res = await POST(
        makeRequest({
          email: 'new@swecham.test',
          role: 'member',
          memberId: 'not-a-uuid',
        }),
      );

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('invalid-input');
      // The inviteUserForMember use case must NOT be called — zod parse
      // rejects invalid UUID before reaching application logic.
      expect(inviteUserForMemberMock).not.toHaveBeenCalled();
    });

    it('400 when memberId is an empty string', async () => {
      requireAdminContextMock.mockResolvedValueOnce(adminContext);

      const res = await POST(
        makeRequest({
          email: 'new@swecham.test',
          role: 'member',
          memberId: '',
        }),
      );

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('invalid-input');
      expect(inviteUserForMemberMock).not.toHaveBeenCalled();
    });

    it('400 when memberId is a UUID-shaped string missing hyphens', async () => {
      requireAdminContextMock.mockResolvedValueOnce(adminContext);

      const res = await POST(
        makeRequest({
          email: 'new@swecham.test',
          role: 'member',
          // 32 hex chars but no hyphens — fails uuid() zod validator
          memberId: '11111111111141118111111111111111',
        }),
      );

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('invalid-input');
      expect(inviteUserForMemberMock).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // (d) role=admin + memberId → 400 invalid-input (explicit rejection)
  // -------------------------------------------------------------------------
  describe('(d) role=admin + memberId — explicit rejection', () => {
    it('400 when role=admin and memberId is provided', async () => {
      requireAdminContextMock.mockResolvedValueOnce(adminContext);

      const res = await POST(
        makeRequest({
          email: 'admin2@swecham.test',
          role: 'admin',
          memberId: VALID_MEMBER_UUID,
        }),
      );

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('invalid-input');
      // Critical: the route MUST NOT silently ignore the mismatch and
      // forward to Branch B (F1 flow). inviteUserForMember and createUser
      // must both be suppressed.
      expect(inviteUserForMemberMock).not.toHaveBeenCalled();
      expect(createUserMock).not.toHaveBeenCalled();
    });

    it('400 when role=manager and memberId is provided', async () => {
      requireAdminContextMock.mockResolvedValueOnce(adminContext);

      const res = await POST(
        makeRequest({
          email: 'manager@swecham.test',
          role: 'manager',
          memberId: VALID_MEMBER_UUID,
        }),
      );

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('invalid-input');
      expect(inviteUserForMemberMock).not.toHaveBeenCalled();
      expect(createUserMock).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // CSRF / auth guard behaviour
  // -------------------------------------------------------------------------
  describe('CSRF / auth guard behaviour', () => {
    it('401 when requireAdminContext returns no-session (missing or invalid session)', async () => {
      // This simulates the proxy allowing the request through (Origin header
      // present and allowed) but the session cookie being absent or expired.
      // The route must short-circuit before ANY body parsing or use-case call.
      requireAdminContextMock.mockResolvedValueOnce({
        response: NextResponse.json({ error: 'no-session' }, { status: 401 }),
      });

      const res = await POST(
        // Request WITHOUT an Origin header — in production the proxy
        // would have already rejected this with 403. Here we confirm
        // the route itself reaches requireAdminContext first (401 wins).
        makeRequest({ email: 'x@y.com', role: 'member', memberId: VALID_MEMBER_UUID }),
      );

      expect(res.status).toBe(401);
      expect(inviteUserForMemberMock).not.toHaveBeenCalled();
      expect(createUserMock).not.toHaveBeenCalled();
    });

    it('403 when requireAdminContext returns forbidden (manager caller on admin-only route)', async () => {
      requireAdminContextMock.mockResolvedValueOnce({
        response: NextResponse.json({ error: 'forbidden' }, { status: 403 }),
      });

      const res = await POST(
        makeRequest({ email: 'x@y.com', role: 'member', memberId: VALID_MEMBER_UUID }),
      );

      expect(res.status).toBe(403);
      expect(inviteUserForMemberMock).not.toHaveBeenCalled();
      expect(createUserMock).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Branch A happy path — role=member + valid memberId
  // -------------------------------------------------------------------------
  describe('Branch A — role=member + valid memberId (smoke)', () => {
    it('201 created when inviteUserForMember succeeds', async () => {
      requireAdminContextMock.mockResolvedValueOnce(adminContext);
      inviteUserForMemberMock.mockResolvedValueOnce(
        ok({
          userId: 'new-user-uuid-001',
          contactId: 'contact-uuid-001',
          email: 'member@swecham.test',
        }),
      );

      const res = await POST(
        makeRequest({
          email: 'member@swecham.test',
          role: 'member',
          memberId: VALID_MEMBER_UUID,
          displayName: 'New Member',
        }),
      );

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.user.email).toBe('member@swecham.test');
      expect(body.user.role).toBe('member');
      expect(body.user.status).toBe('pending');
      expect(body.contactId).toBe('contact-uuid-001');
      // Branch A must NOT fall through to the F1 createUser branch.
      expect(createUserMock).not.toHaveBeenCalled();
    });

    it('404 member-not-found when inviteUserForMember returns member_not_found', async () => {
      requireAdminContextMock.mockResolvedValueOnce(adminContext);
      inviteUserForMemberMock.mockResolvedValueOnce(
        err({ type: 'member_not_found' }),
      );

      const res = await POST(
        makeRequest({
          email: 'member@swecham.test',
          role: 'member',
          memberId: VALID_MEMBER_UUID,
        }),
      );

      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toBe('member-not-found');
    });

    it('409 email-taken when inviteUserForMember returns email_taken', async () => {
      requireAdminContextMock.mockResolvedValueOnce(adminContext);
      inviteUserForMemberMock.mockResolvedValueOnce(
        err({ type: 'email_taken' }),
      );

      const res = await POST(
        makeRequest({
          email: 'existing@swecham.test',
          role: 'member',
          memberId: VALID_MEMBER_UUID,
        }),
      );

      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error).toBe('email-taken');
    });

    it('409 contact-already-linked when inviteUserForMember returns contact_already_linked', async () => {
      requireAdminContextMock.mockResolvedValueOnce(adminContext);
      inviteUserForMemberMock.mockResolvedValueOnce(
        err({ type: 'contact_already_linked' }),
      );

      const res = await POST(
        makeRequest({
          email: 'linked@swecham.test',
          role: 'member',
          memberId: VALID_MEMBER_UUID,
        }),
      );

      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error).toBe('contact-already-linked');
    });

    it('409 email-belongs-to-other-member when inviteUserForMember returns email_belongs_to_other_member', async () => {
      requireAdminContextMock.mockResolvedValueOnce(adminContext);
      inviteUserForMemberMock.mockResolvedValueOnce(
        err({ type: 'email_belongs_to_other_member' }),
      );

      const res = await POST(
        makeRequest({
          email: 'contact-of-other@swecham.test',
          role: 'member',
          memberId: VALID_MEMBER_UUID,
        }),
      );

      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error).toBe('email-belongs-to-other-member');
    });

    it('400 invalid-input when inviteUserForMember returns invalid_email', async () => {
      requireAdminContextMock.mockResolvedValueOnce(adminContext);
      inviteUserForMemberMock.mockResolvedValueOnce(
        err({ type: 'invalid_email' }),
      );

      const res = await POST(
        makeRequest({
          email: 'bad@swecham.test',
          role: 'member',
          memberId: VALID_MEMBER_UUID,
        }),
      );

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe('invalid-input');
    });

    it('500 server-error when inviteUserForMember returns server_error', async () => {
      requireAdminContextMock.mockResolvedValueOnce(adminContext);
      inviteUserForMemberMock.mockResolvedValueOnce(
        err({ type: 'server_error', message: 'tx failed' }),
      );

      const res = await POST(
        makeRequest({
          email: 'member@swecham.test',
          role: 'member',
          memberId: VALID_MEMBER_UUID,
        }),
      );

      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.error).toBe('server-error');
    });
  });

  // -------------------------------------------------------------------------
  // Branch B — role=member WITHOUT memberId (falls through to F1 createUser)
  // -------------------------------------------------------------------------
  describe('Branch B — role=member without memberId uses F1 createUser', () => {
    it('201 when role=member and no memberId provided (existing F1 flow)', async () => {
      requireAdminContextMock.mockResolvedValueOnce(adminContext);
      createUserMock.mockResolvedValueOnce(
        ok({
          user: {
            id: 'new-user-001',
            email: 'member-noid@swecham.test',
            role: 'member',
            status: 'pending',
            displayName: 'No-ID Member',
          },
          invitationId: 'a'.repeat(64),
        }),
      );

      const res = await POST(
        makeRequest({
          email: 'member-noid@swecham.test',
          role: 'member',
        }),
      );

      expect(res.status).toBe(201);
      // Branch B must NOT call the member-link use case.
      expect(inviteUserForMemberMock).not.toHaveBeenCalled();
    });
  });
});
