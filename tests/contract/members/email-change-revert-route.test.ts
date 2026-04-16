/**
 * Contract test: POST|GET /api/auth/email-change/revert/[token]
 *
 * Public endpoint — no session required. Covers FR-012b (endpoint #16).
 *
 * Branches tested (11 total):
 *   1.  200  POST happy path
 *   2.  200  GET  happy path (GET = handle alias)
 *   3.  429  rate limit exceeded
 *   4.  400  token too short (<32 chars)
 *   5.  400  token too long (>256 chars)
 *   6.  400  token lookup miss (findActiveToken returns err)
 *   7.  400  token type mismatch (type !== 'revert')
 *   8.  400  use-case returns { code: 'not_found' }   (switch branch)
 *   9.  400  use-case returns { code: 'wrong_type' }  (switch branch)
 *   10. 409  use-case returns { code: 'conflict', reason }
 *   11. 500  use-case returns { code: 'server_error' }
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { ok, err } from '@/lib/result';

// ---------------------------------------------------------------------------
// Mocks — vi.hoisted() ensures these run before vi.mock() factory functions
// ---------------------------------------------------------------------------

const {
  rateLimiterMock,
  findActiveTokenMock,
  revertContactEmailMock,
  buildMembersDepsMock,
  buildPublicEmailChangeLookupMock,
} = vi.hoisted(() => {
  const findActiveTokenMock = vi.fn();
  const rateLimiterMock = { check: vi.fn() };
  const revertContactEmailMock = vi.fn();
  const buildMembersDepsMock = vi.fn(() => ({
    tokens: {},
    contactRepo: {},
    userEmails: {},
    sessions: {},
    clock: { now: () => new Date() },
  }));
  const buildPublicEmailChangeLookupMock = vi.fn(() => ({
    findActiveToken: findActiveTokenMock,
  }));
  return {
    rateLimiterMock,
    findActiveTokenMock,
    revertContactEmailMock,
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
  const actual = await vi.importActual<typeof import('@/modules/members')>(
    '@/modules/members',
  );
  return {
    ...actual,
    revertContactEmail: revertContactEmailMock,
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
// Fixtures
// ---------------------------------------------------------------------------

const VALID_TOKEN = 'a'.repeat(64); // 64-char hex string — within 32-256 range

const RATE_LIMIT_PASS = {
  success: true,
  remaining: 4,
  reset: Date.now() + 600_000,
};

const RATE_LIMIT_FAIL = {
  success: false,
  remaining: 0,
  reset: Date.now() + 60_000,
};

const ACTIVE_REVERT_TOKEN = {
  tokenId: 'hash-of-token',
  type: 'revert' as const,
  tenantId: 'test-swecham',
  userId: 'u1',
  contactId: 'c1',
  oldEmail: 'old@test.com',
  newEmail: 'new@test.com',
};

const REVERT_SUCCESS = {
  userId: 'u1',
  sessionsRevoked: 2,
};

function makeRequest(token: string, method = 'POST'): NextRequest {
  return new NextRequest(
    `http://localhost:3100/api/auth/email-change/revert/${token}`,
    {
      method,
      headers: { 'x-forwarded-for': '203.0.113.9' },
    },
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('contract: POST|GET /api/auth/email-change/revert/[token]', () => {
  afterEach(() => vi.clearAllMocks());

  // 1. ------------------------------------------------------------------ 200
  it('200 — POST happy path: rate limit passes, token found, type=revert, use case succeeds', async () => {
    rateLimiterMock.check.mockResolvedValueOnce(RATE_LIMIT_PASS);
    findActiveTokenMock.mockResolvedValueOnce(ok(ACTIVE_REVERT_TOKEN));
    revertContactEmailMock.mockResolvedValueOnce(ok(REVERT_SUCCESS));

    const { POST: handle } = await import(
      '@/app/api/auth/email-change/revert/[token]/route'
    );
    const res = await handle(makeRequest(VALID_TOKEN), {
      params: Promise.resolve({ token: VALID_TOKEN }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  // 2. ------------------------------------------------------------------ 200
  it('200 — GET happy path: GET is the same handler as POST', async () => {
    rateLimiterMock.check.mockResolvedValueOnce(RATE_LIMIT_PASS);
    findActiveTokenMock.mockResolvedValueOnce(ok(ACTIVE_REVERT_TOKEN));
    revertContactEmailMock.mockResolvedValueOnce(ok(REVERT_SUCCESS));

    const { GET: handle } = await import(
      '@/app/api/auth/email-change/revert/[token]/route'
    );
    const res = await handle(makeRequest(VALID_TOKEN, 'GET'), {
      params: Promise.resolve({ token: VALID_TOKEN }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  // 3. ------------------------------------------------------------------ 429
  it('429 — rate limit exceeded: returns rate_limited error and retry-after header', async () => {
    rateLimiterMock.check.mockResolvedValueOnce(RATE_LIMIT_FAIL);

    const { POST: handle } = await import(
      '@/app/api/auth/email-change/revert/[token]/route'
    );
    const res = await handle(makeRequest(VALID_TOKEN), {
      params: Promise.resolve({ token: VALID_TOKEN }),
    });

    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error).toBe('rate_limited');

    // retry-after header must be present and a positive integer string
    const retryAfter = res.headers.get('retry-after');
    expect(retryAfter).not.toBeNull();
    expect(Number(retryAfter)).toBeGreaterThan(0);

    // Lookup must not be called after rate-limit rejection
    expect(findActiveTokenMock).not.toHaveBeenCalled();
  });

  // 4. ------------------------------------------------------------------ 400
  it('400 — token too short: rejects before lookup when token is < 32 chars', async () => {
    rateLimiterMock.check.mockResolvedValueOnce(RATE_LIMIT_PASS);
    const shortToken = 'a'.repeat(31);

    const { POST: handle } = await import(
      '@/app/api/auth/email-change/revert/[token]/route'
    );
    const res = await handle(makeRequest(shortToken), {
      params: Promise.resolve({ token: shortToken }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('invalid_token');
    expect(findActiveTokenMock).not.toHaveBeenCalled();
  });

  // 5. ------------------------------------------------------------------ 400
  it('400 — token too long: rejects before lookup when token is > 256 chars', async () => {
    rateLimiterMock.check.mockResolvedValueOnce(RATE_LIMIT_PASS);
    const longToken = 'a'.repeat(257);

    const { POST: handle } = await import(
      '@/app/api/auth/email-change/revert/[token]/route'
    );
    const res = await handle(makeRequest(longToken), {
      params: Promise.resolve({ token: longToken }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('invalid_token');
    expect(findActiveTokenMock).not.toHaveBeenCalled();
  });

  // 6. ------------------------------------------------------------------ 400
  it('400 — token lookup miss: findActiveToken returns err', async () => {
    rateLimiterMock.check.mockResolvedValueOnce(RATE_LIMIT_PASS);
    findActiveTokenMock.mockResolvedValueOnce(
      err({ code: 'not_found' }),
    );

    const { POST: handle } = await import(
      '@/app/api/auth/email-change/revert/[token]/route'
    );
    const res = await handle(makeRequest(VALID_TOKEN), {
      params: Promise.resolve({ token: VALID_TOKEN }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('invalid_token');
    expect(revertContactEmailMock).not.toHaveBeenCalled();
  });

  // 7. ------------------------------------------------------------------ 400
  it('400 — wrong token type: token found but type is "verification", not "revert"', async () => {
    rateLimiterMock.check.mockResolvedValueOnce(RATE_LIMIT_PASS);
    findActiveTokenMock.mockResolvedValueOnce(
      ok({ ...ACTIVE_REVERT_TOKEN, type: 'verification' as const }),
    );

    const { POST: handle } = await import(
      '@/app/api/auth/email-change/revert/[token]/route'
    );
    const res = await handle(makeRequest(VALID_TOKEN), {
      params: Promise.resolve({ token: VALID_TOKEN }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('invalid_token');
    expect(revertContactEmailMock).not.toHaveBeenCalled();
  });

  // 8. ------------------------------------------------------------------ 400
  it('400 — use case returns not_found: route maps to invalid_token (switch branch)', async () => {
    rateLimiterMock.check.mockResolvedValueOnce(RATE_LIMIT_PASS);
    findActiveTokenMock.mockResolvedValueOnce(ok(ACTIVE_REVERT_TOKEN));
    revertContactEmailMock.mockResolvedValueOnce(
      err({ code: 'not_found' }),
    );

    const { POST: handle } = await import(
      '@/app/api/auth/email-change/revert/[token]/route'
    );
    const res = await handle(makeRequest(VALID_TOKEN), {
      params: Promise.resolve({ token: VALID_TOKEN }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('invalid_token');
  });

  // 9. ------------------------------------------------------------------ 400
  it('400 — use case returns wrong_type: route maps to invalid_token (switch branch)', async () => {
    rateLimiterMock.check.mockResolvedValueOnce(RATE_LIMIT_PASS);
    findActiveTokenMock.mockResolvedValueOnce(ok(ACTIVE_REVERT_TOKEN));
    revertContactEmailMock.mockResolvedValueOnce(
      err({ code: 'wrong_type' }),
    );

    const { POST: handle } = await import(
      '@/app/api/auth/email-change/revert/[token]/route'
    );
    const res = await handle(makeRequest(VALID_TOKEN), {
      params: Promise.resolve({ token: VALID_TOKEN }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('invalid_token');
  });

  // 10. ----------------------------------------------------------------- 409
  it('409 — revertContactEmail returns conflict with reason: route surfaces reason in body', async () => {
    rateLimiterMock.check.mockResolvedValueOnce(RATE_LIMIT_PASS);
    findActiveTokenMock.mockResolvedValueOnce(ok(ACTIVE_REVERT_TOKEN));
    revertContactEmailMock.mockResolvedValueOnce(
      err({ code: 'conflict', reason: 'email_taken' }),
    );

    const { POST: handle } = await import(
      '@/app/api/auth/email-change/revert/[token]/route'
    );
    const res = await handle(makeRequest(VALID_TOKEN), {
      params: Promise.resolve({ token: VALID_TOKEN }),
    });

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe('conflict');
    expect(body.reason).toBe('email_taken');
  });

  // 11. ----------------------------------------------------------------- 500
  it('500 — revertContactEmail returns server_error: route returns generic server_error body', async () => {
    rateLimiterMock.check.mockResolvedValueOnce(RATE_LIMIT_PASS);
    findActiveTokenMock.mockResolvedValueOnce(ok(ACTIVE_REVERT_TOKEN));
    revertContactEmailMock.mockResolvedValueOnce(
      err({ code: 'server_error', message: 'DB connection lost' }),
    );

    const { POST: handle } = await import(
      '@/app/api/auth/email-change/revert/[token]/route'
    );
    const res = await handle(makeRequest(VALID_TOKEN), {
      params: Promise.resolve({ token: VALID_TOKEN }),
    });

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe('server_error');
    // Internal error message must NOT leak to the client
    expect(JSON.stringify(body)).not.toContain('DB connection lost');
  });
});
