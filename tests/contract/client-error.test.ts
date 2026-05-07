/**
 * POST /api/internal/client-error contract test
 * (Round 2 review-fix S-6 — client-side error beacon).
 *
 * Round 3 review-fix (R3-CR3) — Round 3's `pr-test-analyzer` flagged
 * this endpoint as zero-tested. The endpoint receives forwarded client
 * errors via `navigator.sendBeacon` from authenticated browsers, so
 * silently regressing the auth-required guard or the 1 KiB body cap
 * would turn it into an abuse vector.
 *
 * Cases (6 branches at the route level):
 *   - 401 anonymous       — getCurrentSession returns null
 *   - 413 body-too-large  — raw body > 1024 bytes
 *   - 429 rate-limited    — rateLimiter.check fails
 *   - 400 invalid-json    — body is not parseable JSON
 *   - 400 invalid-input   — body fails zod schema
 *   - 204 happy-path      — log emitted with errorId='CLIENT.ERROR_REPORT'
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const getCurrentSessionMock = vi.fn();
const rateLimiterCheckMock = vi.fn();
const loggerWarnMock = vi.fn();

vi.mock('@/lib/auth-session', () => ({
  getCurrentSession: () => getCurrentSessionMock(),
}));

vi.mock('@/lib/auth-deps', () => ({
  rateLimiter: { check: (...args: unknown[]) => rateLimiterCheckMock(...args) },
}));

vi.mock('@/lib/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: (...args: unknown[]) => loggerWarnMock(...args),
    error: vi.fn(),
  },
}));

const signedInSession = {
  user: {
    id: '00000000-0000-0000-0000-000000000001',
    email: 'member@swecham.test',
    role: 'member',
    status: 'active',
    displayName: 'Member',
  },
  session: { id: 'a'.repeat(64) },
};

function makeRequest(body: string | null): NextRequest {
  return new NextRequest('http://localhost/api/internal/client-error', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });
}

describe('POST /api/internal/client-error', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('413 body-too-large when body exceeds 1 KiB', async () => {
    // Anonymous + over-cap → 413 must fire BEFORE the auth check (the
    // body-cap is unauthenticated-cheap by design — bound abuse cost
    // before invoking the session lookup).
    const oversized = 'x'.repeat(1025);
    const { POST } = await import('@/app/api/internal/client-error/route');
    const response = await POST(makeRequest(oversized));

    expect(response.status).toBe(413);
    const body = await response.json();
    expect(body.error.code).toBe('body_too_large');
    expect(getCurrentSessionMock).not.toHaveBeenCalled();
    expect(rateLimiterCheckMock).not.toHaveBeenCalled();
  });

  it('401 unauthenticated when no session', async () => {
    getCurrentSessionMock.mockResolvedValueOnce(null);

    const { POST } = await import('@/app/api/internal/client-error/route');
    const response = await POST(
      makeRequest(JSON.stringify({ tag: 'x', code: 'y' })),
    );

    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body.error.code).toBe('unauthenticated');
    expect(rateLimiterCheckMock).not.toHaveBeenCalled();
    expect(loggerWarnMock).not.toHaveBeenCalled();
  });

  it('429 rate-limited when bucket is exhausted', async () => {
    getCurrentSessionMock.mockResolvedValueOnce(signedInSession);
    rateLimiterCheckMock.mockResolvedValueOnce({
      success: false,
      remaining: 0,
      reset: Date.now() + 60_000,
    });

    const { POST } = await import('@/app/api/internal/client-error/route');
    const response = await POST(
      makeRequest(JSON.stringify({ tag: 'x', code: 'y' })),
    );

    expect(response.status).toBe(429);
    const body = await response.json();
    expect(body.error.code).toBe('rate_limited');
    // Rate-limit key MUST be partitioned by session user id so a
    // misbehaving client can't burn another user's quota.
    expect(rateLimiterCheckMock).toHaveBeenCalledWith(
      `client-error:${signedInSession.user.id}`,
      30,
      60,
    );
    expect(loggerWarnMock).not.toHaveBeenCalled();
  });

  it('400 invalid-json when body is not parseable', async () => {
    getCurrentSessionMock.mockResolvedValueOnce(signedInSession);
    rateLimiterCheckMock.mockResolvedValueOnce({
      success: true,
      remaining: 29,
      reset: Date.now() + 60_000,
    });

    const { POST } = await import('@/app/api/internal/client-error/route');
    const response = await POST(makeRequest('not-json'));

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe('invalid_json');
    expect(loggerWarnMock).not.toHaveBeenCalled();
  });

  it('400 invalid-input when body fails zod schema (missing required fields)', async () => {
    getCurrentSessionMock.mockResolvedValueOnce(signedInSession);
    rateLimiterCheckMock.mockResolvedValueOnce({
      success: true,
      remaining: 29,
      reset: Date.now() + 60_000,
    });

    const { POST } = await import('@/app/api/internal/client-error/route');
    const response = await POST(
      makeRequest(JSON.stringify({ tag: '' /* min(1) violation */ })),
    );

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe('invalid_input');
    expect(typeof body.error.message).toBe('string');
    expect(loggerWarnMock).not.toHaveBeenCalled();
  });

  it('204 happy-path emits structured pino log with errorId', async () => {
    getCurrentSessionMock.mockResolvedValueOnce(signedInSession);
    rateLimiterCheckMock.mockResolvedValueOnce({
      success: true,
      remaining: 29,
      reset: Date.now() + 60_000,
    });

    const { POST } = await import('@/app/api/internal/client-error/route');
    const response = await POST(
      makeRequest(
        JSON.stringify({
          tag: 'renewal-confirm',
          code: 'plan_inactive',
          status: 400,
          path: '/portal/renewal/abc',
        }),
      ),
    );

    expect(response.status).toBe(204);
    // 204 No Content — body MUST be empty per sendBeacon convention.
    expect(await response.text()).toBe('');

    expect(loggerWarnMock).toHaveBeenCalledTimes(1);
    const [payload, message] = loggerWarnMock.mock.calls[0]!;
    expect(payload).toMatchObject({
      errorId: 'CLIENT.ERROR_REPORT',
      tag: 'renewal-confirm',
      code: 'plan_inactive',
      status: 400,
      path: '/portal/renewal/abc',
      userId: signedInSession.user.id,
    });
    expect(message).toContain('client-error');
  });
});
