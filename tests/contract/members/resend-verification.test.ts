/**
 * Contract test: POST /api/members/[memberId]/contacts/[contactId]/resend-verification
 *
 * Mocks all dependencies. Verifies every HTTP response branch:
 *   - 200 on successful re-send (outbox_row_id + invalidated_prior)
 *   - 401 when admin-context gate returns a short-circuit response
 *   - 404 when use case reports not_found
 *   - 409 when use case reports not_eligible (forwards reason)
 *   - 500 when use case reports server_error
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { ok, err } from '@/lib/result';

// ---------------------------------------------------------------------------
// Hoist mocks before any import that might pull in real implementations
// ---------------------------------------------------------------------------

const requireAdminContextMock = vi.fn();
const resendVerificationEmailMock = vi.fn();
const buildMembersDepsMock = vi.fn(() => ({
  contactRepo: {},
  tokens: {},
  emails: {},
  userEmails: {},
  audit: {},
  clock: { now: () => new Date() },
}));

vi.mock('@/lib/admin-context', () => ({
  requireAdminContext: requireAdminContextMock,
}));

// DV-11: route now calls rateLimiter — mock it to always allow so the
// existing non-rate-limit branches are tested against a clean path.
// Uses importActual + spread to avoid discarding other named exports
// (partial-module mock convention per CLAUDE.md).
vi.mock('@/lib/auth-deps', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth-deps')>('@/lib/auth-deps');
  return {
    ...actual,
    rateLimiter: {
      check: vi.fn(async (..._args: unknown[]) => ({
        success: true,
        reset: Date.now() + 3600_000,
      })),
    },
  };
});

vi.mock('@/modules/members/members-deps', () => ({
  buildMembersDeps: buildMembersDepsMock,
}));

vi.mock('@/modules/members', async () => {
  const actual = await vi.importActual<typeof import('@/modules/members')>(
    '@/modules/members',
  );
  return {
    ...actual,
    resendVerificationEmail: resendVerificationEmailMock,
  };
});

vi.mock('@/lib/tenant-context', () => ({
  resolveTenantFromRequest: () => ({ slug: 'test-swecham', __brand: true }),
}));

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const adminContext = {
  current: {
    user: { id: 'admin-1', email: 'a@b.co', role: 'admin', status: 'active' },
    session: { id: 's1' },
  },
  sourceIp: '203.0.113.5',
  requestId: 'req-1',
};

const memberId = '11111111-1111-1111-1111-111111111111';
const contactId = '22222222-2222-2222-2222-222222222222';

function makeRequest(): NextRequest {
  return new NextRequest(
    `http://localhost:3100/api/members/${memberId}/contacts/${contactId}/resend-verification`,
    { method: 'POST' },
  );
}

const routeParams = async () => ({ memberId, contactId });

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('contract: POST /api/members/[memberId]/contacts/[contactId]/resend-verification', () => {
  afterEach(() => vi.clearAllMocks());

  it('200 — returns outbox_row_id and invalidated_prior on successful re-send', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    resendVerificationEmailMock.mockResolvedValueOnce(
      ok({
        userId: 'user-42',
        contactId,
        newEmail: 'contact@example.com',
        outboxRowId: 'outbox-1',
        invalidatedPrior: 2,
      }),
    );

    const { POST } = await import(
      '@/app/api/members/[memberId]/contacts/[contactId]/resend-verification/route'
    );
    const res = await POST(makeRequest(), { params: routeParams() });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.outbox_row_id).toBe('outbox-1');
    expect(body.invalidated_prior).toBe(2);
  });

  it('401 — admin-context gate short-circuits before reaching use case', async () => {
    const { NextResponse } = await import('next/server');
    requireAdminContextMock.mockResolvedValueOnce({
      response: NextResponse.json({ error: 'unauthorized' }, { status: 401 }),
    });

    const { POST } = await import(
      '@/app/api/members/[memberId]/contacts/[contactId]/resend-verification/route'
    );
    const res = await POST(makeRequest(), { params: routeParams() });

    expect(res.status).toBe(401);
    expect(resendVerificationEmailMock).not.toHaveBeenCalled();
  });

  it('404 — use case reports not_found (contact does not exist)', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    resendVerificationEmailMock.mockResolvedValueOnce(
      err({ code: 'not_found' }),
    );

    const { POST } = await import(
      '@/app/api/members/[memberId]/contacts/[contactId]/resend-verification/route'
    );
    const res = await POST(makeRequest(), { params: routeParams() });

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe('not_found');
  });

  it('409 — use case reports not_eligible and forwards reason to client', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    resendVerificationEmailMock.mockResolvedValueOnce(
      err({ code: 'not_eligible', reason: 'no_linked_user' }),
    );

    const { POST } = await import(
      '@/app/api/members/[memberId]/contacts/[contactId]/resend-verification/route'
    );
    const res = await POST(makeRequest(), { params: routeParams() });

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe('not_eligible');
    expect(body.reason).toBe('no_linked_user');
  });

  it('500 — use case reports server_error', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    resendVerificationEmailMock.mockResolvedValueOnce(
      err({ code: 'server_error', cause: new Error('db timeout') }),
    );

    const { POST } = await import(
      '@/app/api/members/[memberId]/contacts/[contactId]/resend-verification/route'
    );
    const res = await POST(makeRequest(), { params: routeParams() });

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe('server_error');
  });

  // FIX 3 (TDD RED → GREEN): memberId/contactId consistency guard.
  // The route must pass memberId into the use-case input. The use-case
  // must return not_found when the contact does not belong to that member,
  // and the route must propagate it as 404 { error: 'not_found' }.
  it('404 — use case returns not_found when memberId does not match contact owner', async () => {
    requireAdminContextMock.mockResolvedValueOnce(adminContext);
    // Simulate the guard firing: the use-case sees a contactId that exists
    // but belongs to a different member → returns not_found.
    resendVerificationEmailMock.mockResolvedValueOnce(
      err({ code: 'not_found' }),
    );

    // Use a request where the path memberId does NOT match the contact's owner.
    const mismatchedMemberId = '99999999-9999-9999-9999-999999999999';
    const req = new NextRequest(
      `http://localhost:3100/api/members/${mismatchedMemberId}/contacts/${contactId}/resend-verification`,
      { method: 'POST' },
    );
    const mismatchedParams = async () => ({
      memberId: mismatchedMemberId,
      contactId,
    });

    const { POST } = await import(
      '@/app/api/members/[memberId]/contacts/[contactId]/resend-verification/route'
    );
    const res = await POST(req, { params: mismatchedParams() });

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe('not_found');

    // Confirm the route forwarded memberId to the use-case input.
    expect(resendVerificationEmailMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ memberId: mismatchedMemberId }),
    );
  });
});
