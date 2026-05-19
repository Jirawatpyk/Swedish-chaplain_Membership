/**
 * T054 — POST /api/auth/sign-in contract test.
 *
 * Validates the wire contract from contracts/auth-api.md § 1 by
 * stubbing the use case dependencies (no DB needed). The route handler
 * is invoked directly with a constructed `NextRequest`.
 *
 * Cases:
 *   - 200 success → cookie set, body shape correct
 *   - 400 invalid input (bad email format)
 *   - 401 invalid credentials (wrong password)
 *   - 403 account-disabled
 *   - 403 account-locked (with Retry-After header)
 *   - 429 rate-limited (with Retry-After header)
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { POST } from '@/app/api/auth/sign-in/route';

vi.mock('@/lib/auth-cookies', () => ({
  setSessionCookie: vi.fn(async () => undefined),
  clearSessionCookie: vi.fn(async () => undefined),
  getSessionIdFromCookie: vi.fn(async () => null),
}));

const signInMock = vi.fn();
vi.mock('@/modules/auth/application/sign-in', async () => {
  const actual = await vi.importActual<typeof import('@/modules/auth/application/sign-in')>(
    '@/modules/auth/application/sign-in',
  );
  return {
    ...actual,
    signIn: (...args: unknown[]) => signInMock(...args),
  };
});

function makeRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/auth/sign-in', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.5' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/auth/sign-in', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('400 on missing fields', async () => {
    const response = await POST(makeRequest({ email: 'not-an-email' }));
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe('invalid-input');
  });

  it('200 on success with redirect', async () => {
    signInMock.mockResolvedValueOnce({
      ok: true,
      value: {
        session: { id: 'abc', userId: 'u1' },
        user: {
          id: 'u1',
          email: 'admin@swecham.se',
          role: 'admin',
          displayName: 'Admin',
        },
      },
    });

    const response = await POST(
      makeRequest({ email: 'admin@swecham.se', password: 'a-strong-password', portal: 'staff' }),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.user.email).toBe('admin@swecham.se');
    expect(body.user.role).toBe('admin');
    expect(body.redirect).toBe('/admin');
  });

  it('401 on invalid credentials', async () => {
    signInMock.mockResolvedValueOnce({
      ok: false,
      error: { code: 'invalid-credentials' },
    });

    const response = await POST(
      makeRequest({ email: 'admin@swecham.se', password: 'wrong', portal: 'staff' }),
    );

    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body.error).toBe('invalid-credentials');
  });

  it('403 with Retry-After on locked account', async () => {
    signInMock.mockResolvedValueOnce({
      ok: false,
      error: { code: 'account-locked', retryAfterSeconds: 900 },
    });

    const response = await POST(
      makeRequest({ email: 'admin@swecham.se', password: 'wrong', portal: 'staff' }),
    );

    expect(response.status).toBe(403);
    expect(response.headers.get('retry-after')).toBe('900');
  });

  it('429 with Retry-After on rate-limited', async () => {
    signInMock.mockResolvedValueOnce({
      ok: false,
      error: { code: 'rate-limited', retryAfterSeconds: 60 },
    });

    const response = await POST(
      makeRequest({ email: 'admin@swecham.se', password: 'wrong', portal: 'staff' }),
    );

    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('60');
  });

  it('403 on account-disabled', async () => {
    signInMock.mockResolvedValueOnce({
      ok: false,
      error: { code: 'account-disabled' },
    });

    const response = await POST(
      makeRequest({ email: 'admin@swecham.se', password: 'whatever', portal: 'staff' }),
    );

    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error).toBe('account-disabled');
  });

  // G4 (Round 2): B3 outer try/catch surfaces infra throws as a
  // structured 500-with-requestId, not an opaque Next.js HTML 500.
  it('500 with requestId when sign-in throws (infra error)', async () => {
    signInMock.mockRejectedValueOnce(
      new Error('neon: connection terminated unexpectedly'),
    );

    const response = await POST(
      makeRequest({
        email: 'admin@swecham.se',
        password: 'whatever',
        portal: 'staff',
      }),
    );

    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error).toBe('server-error');
    expect(typeof body.requestId).toBe('string');
    expect(body.requestId.length).toBeGreaterThan(0);
  });
});
