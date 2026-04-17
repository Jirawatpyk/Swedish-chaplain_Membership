/**
 * Contract test: GET|POST /api/auth/email-verification/[token]
 *
 * Covers every documented response branch (FR-012a companion):
 *   1. 200  — POST happy path (token valid, use case ok)
 *   2. 200  — GET  happy path (same handler exported as GET)
 *   3. 429  — rate limit exceeded
 *   4. 400  — token too short  (<32 chars)
 *   5. 400  — token too long   (>256 chars)
 *   6. 400  — token lookup miss (findActiveToken returns err)
 *   7. 400  — wrong token type  (type='revert', not 'verification')
 *   8. 400  — not_yet_active with retryAfterSeconds (fake timers)
 *   9. 500  — verifyContactEmail returns err({ code: 'server_error' })
 *
 * All infrastructure deps are mocked; no DB or network I/O occurs.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { ok, err } from '@/lib/result';

// ---------------------------------------------------------------------------
// Mock declarations — vi.hoisted() ensures these run before vi.mock() factory
// functions, which are themselves hoisted above all imports by Vitest.
// ---------------------------------------------------------------------------

const {
  rateLimiterMock,
  findActiveTokenMock,
  verifyContactEmailMock,
  buildMembersDepsMock,
  buildPublicEmailChangeLookupMock,
} = vi.hoisted(() => {
  const findActiveTokenMock = vi.fn();
  const rateLimiterMock = { check: vi.fn() };
  const verifyContactEmailMock = vi.fn();
  const buildMembersDepsMock = vi.fn(() => ({
    tokens: {},
    userEmails: {},
    clock: { now: () => new Date() },
  }));
  const buildPublicEmailChangeLookupMock = vi.fn(() => ({
    findActiveToken: findActiveTokenMock,
  }));
  return {
    rateLimiterMock,
    findActiveTokenMock,
    verifyContactEmailMock,
    buildMembersDepsMock,
    buildPublicEmailChangeLookupMock,
  };
});

vi.mock('@/lib/auth-deps', () => ({ rateLimiter: rateLimiterMock }));

vi.mock('@/modules/members/members-deps', () => ({
  buildMembersDeps: buildMembersDepsMock,
  buildPublicEmailChangeLookup: buildPublicEmailChangeLookupMock,
}));

vi.mock('@/modules/members', async () => {
  const actual =
    await vi.importActual<typeof import('@/modules/members')>('@/modules/members');
  return {
    ...actual,
    verifyContactEmail: verifyContactEmailMock,
  };
});

vi.mock('@/modules/tenants', () => ({
  asTenantContext: (slug: string) => ({ slug, __brand: true }),
}));

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock('@/lib/request-id', () => ({
  requestIdFromHeaders: () => 'req-test-1',
}));

// ---------------------------------------------------------------------------
// Static route import — safe after vi.mock hoisting.
// ---------------------------------------------------------------------------
import { GET, POST } from '@/app/api/auth/email-verification/[token]/route';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** 40-char token — within the 32–256 valid range. */
const VALID_TOKEN = 'a'.repeat(40);

/** Stub token-row returned by the public lookup for valid tokens. */
const stubTokenRow = {
  type: 'verification' as const,
  tenantId: 'test-tenant',
};

/**
 * Build a NextRequest for the email-verification endpoint.
 * The token lives in the URL path; the route extracts it from `params`.
 */
function makeRequest(token: string, method: 'GET' | 'POST' = 'POST'): NextRequest {
  return new NextRequest(
    `http://localhost/api/auth/email-verification/${token}`,
    {
      method,
      headers: { 'x-forwarded-for': '203.0.113.42' },
    },
  );
}

/**
 * Build the `params` argument that Next.js 15+ passes as a Promise.
 */
function makeParams(token: string): { params: Promise<{ token: string }> } {
  return { params: Promise.resolve({ token }) };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('contract: GET|POST /api/auth/email-verification/[token]', () => {
  beforeEach(() => {
    // Default: rate limiter passes every test unless overridden.
    rateLimiterMock.check.mockResolvedValue({ success: true, reset: 0 });
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  // 1 -----------------------------------------------------------------------
  it('200 — POST happy path: valid token, use case succeeds', async () => {
    findActiveTokenMock.mockResolvedValueOnce(ok(stubTokenRow));
    verifyContactEmailMock.mockResolvedValueOnce(ok({ userId: 'user-abc' }));

    const res = await POST(makeRequest(VALID_TOKEN, 'POST'), makeParams(VALID_TOKEN));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  // 2 -----------------------------------------------------------------------
  it('405 — GET returns method_not_allowed (SEC-1: prefetch safety)', async () => {
    const res = await GET();

    expect(res.status).toBe(405);
    const body = await res.json();
    expect(body.error).toBe('method_not_allowed');
    expect(res.headers.get('allow')).toBe('POST');
    // Verify use case must NOT be called on GET
    expect(verifyContactEmailMock).not.toHaveBeenCalled();
  });

  // 3 -----------------------------------------------------------------------
  it('429 — rate limit exceeded: returns rate_limited + retry-after header', async () => {
    const resetEpochMs = Date.now() + 600_000; // 10 min from now
    rateLimiterMock.check.mockResolvedValueOnce({
      success: false,
      reset: resetEpochMs,
    });

    const res = await POST(makeRequest(VALID_TOKEN, 'POST'), makeParams(VALID_TOKEN));

    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error).toBe('rate_limited');
    // retry-after header must be a positive integer string
    const retryAfter = Number(res.headers.get('retry-after'));
    expect(retryAfter).toBeGreaterThan(0);
    // lookup must not have been called
    expect(findActiveTokenMock).not.toHaveBeenCalled();
  });

  // 4 -----------------------------------------------------------------------
  it('400 — token too short (<32 chars): returns invalid_token without lookup', async () => {
    const shortToken = 'a'.repeat(31);

    const res = await POST(makeRequest(shortToken, 'POST'), makeParams(shortToken));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('invalid_token');
    expect(findActiveTokenMock).not.toHaveBeenCalled();
  });

  // 5 -----------------------------------------------------------------------
  it('400 — token too long (>256 chars): returns invalid_token without lookup', async () => {
    const longToken = 'b'.repeat(257);

    const res = await POST(makeRequest(longToken, 'POST'), makeParams(longToken));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('invalid_token');
    expect(findActiveTokenMock).not.toHaveBeenCalled();
  });

  // 6 -----------------------------------------------------------------------
  it('400 — token lookup miss: findActiveToken returns err', async () => {
    findActiveTokenMock.mockResolvedValueOnce(err('not_found'));

    const res = await POST(makeRequest(VALID_TOKEN, 'POST'), makeParams(VALID_TOKEN));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('invalid_token');
    // Use case must not be called when lookup fails
    expect(verifyContactEmailMock).not.toHaveBeenCalled();
  });

  // 7 -----------------------------------------------------------------------
  it("400 — wrong token type ('revert'): returns invalid_token", async () => {
    findActiveTokenMock.mockResolvedValueOnce(
      ok({ type: 'revert' as const, tenantId: 'test-tenant' }),
    );

    const res = await POST(makeRequest(VALID_TOKEN, 'POST'), makeParams(VALID_TOKEN));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('invalid_token');
    expect(verifyContactEmailMock).not.toHaveBeenCalled();
  });

  // 8 -----------------------------------------------------------------------
  it('400 — not_yet_active: returns not_yet_active with retryAfterSeconds', async () => {
    // Freeze time so the route's `Date.now()` is deterministic.
    const frozenNow = new Date('2026-04-16T10:00:00.000Z');
    vi.useFakeTimers();
    vi.setSystemTime(frozenNow);

    const activatedAt = new Date(frozenNow.getTime() + 300_000); // 5 min ahead

    findActiveTokenMock.mockResolvedValueOnce(ok(stubTokenRow));
    verifyContactEmailMock.mockResolvedValueOnce(
      err({ code: 'not_yet_active', activatedAt }),
    );

    const res = await POST(makeRequest(VALID_TOKEN, 'POST'), makeParams(VALID_TOKEN));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('not_yet_active');
    // With frozen clock: ceil(300_000 / 1000) === 300
    expect(body.retryAfterSeconds).toBe(300);
  });

  // 9 -----------------------------------------------------------------------
  it('500 — verifyContactEmail server_error: returns server_error', async () => {
    findActiveTokenMock.mockResolvedValueOnce(ok(stubTokenRow));
    verifyContactEmailMock.mockResolvedValueOnce(
      err({ code: 'server_error' }),
    );

    const res = await POST(makeRequest(VALID_TOKEN, 'POST'), makeParams(VALID_TOKEN));

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe('server_error');
  });
});
