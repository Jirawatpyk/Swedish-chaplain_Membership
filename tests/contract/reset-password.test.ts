/**
 * T089 — POST /api/auth/reset-password contract test.
 *
 * Cases (contracts/auth-api.md § 4):
 *   - 200 success → body { ok:true, signInUrl }
 *   - 400 invalid-input (missing fields)
 *   - 400 weak-password (rule breakdown in body)
 *   - 404 link-invalid with reason=not-found (token id absent from DB)
 *   - 410 link-invalid with reason=expired / reason=used (token existed but
 *     is no longer actionable). The public JSON body is identical across the
 *     three reasons — the status code alone distinguishes them so clients
 *     can tell the difference between "typo'd link" and "already used".
 *   - 429 rate-limited with Retry-After
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { POST } from '@/app/api/auth/reset-password/route';
import { ok, err } from '@/lib/result';

const resetMock = vi.fn();
vi.mock('@/modules/auth/application/reset-password', async () => {
  const actual = await vi.importActual<
    typeof import('@/modules/auth/application/reset-password')
  >('@/modules/auth/application/reset-password');
  return {
    ...actual,
    resetPassword: (...args: unknown[]) => resetMock(...args),
  };
});

const VALID_TOKEN = 'a'.repeat(64);

function makeRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/auth/reset-password', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-forwarded-for': '203.0.113.8',
    },
    body: JSON.stringify(body),
  });
}

describe('POST /api/auth/reset-password', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('200 success returns signInUrl', async () => {
    resetMock.mockResolvedValueOnce(
      ok({ signInUrl: '/admin/sign-in', role: 'admin' }),
    );

    const response = await POST(
      makeRequest({ token: VALID_TOKEN, newPassword: 'new passphrase 2026!' }),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.signInUrl).toBe('/admin/sign-in');
  });

  it('200 for member signInUrl differs from staff', async () => {
    resetMock.mockResolvedValueOnce(
      ok({ signInUrl: '/portal/sign-in', role: 'member' }),
    );

    const response = await POST(
      makeRequest({ token: VALID_TOKEN, newPassword: 'another passphrase 26' }),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.signInUrl).toBe('/portal/sign-in');
  });

  it('400 on missing token', async () => {
    const response = await POST(
      makeRequest({ newPassword: 'new passphrase 2026!' }),
    );
    expect(response.status).toBe(400);
    expect(resetMock).not.toHaveBeenCalled();
  });

  it('400 on missing newPassword', async () => {
    const response = await POST(makeRequest({ token: VALID_TOKEN }));
    expect(response.status).toBe(400);
    expect(resetMock).not.toHaveBeenCalled();
  });

  it('400 on short token (schema rejects before use case)', async () => {
    const response = await POST(
      makeRequest({ token: 'short', newPassword: 'new passphrase 2026!' }),
    );
    expect(response.status).toBe(400);
  });

  it('400 weak-password with issue list', async () => {
    resetMock.mockResolvedValueOnce(
      err({
        code: 'weak-password',
        errors: [{ code: 'too-short', minLength: 12 }],
      }),
    );

    const response = await POST(
      makeRequest({ token: VALID_TOKEN, newPassword: 'short' }),
    );
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe('weak-password');
    expect(body.issues).toContain('too-short');
  });

  it('404 link-invalid when reason=not-found (token id absent from DB)', async () => {
    resetMock.mockResolvedValueOnce(
      err({ code: 'link-invalid', reason: 'not-found' as const }),
    );

    const response = await POST(
      makeRequest({ token: VALID_TOKEN, newPassword: 'new passphrase 2026!' }),
    );
    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error).toBe('link-invalid');
  });

  it('410 link-invalid when reason=expired', async () => {
    resetMock.mockResolvedValueOnce(
      err({ code: 'link-invalid', reason: 'expired' as const }),
    );

    const response = await POST(
      makeRequest({ token: VALID_TOKEN, newPassword: 'new passphrase 2026!' }),
    );
    expect(response.status).toBe(410);
    const body = await response.json();
    expect(body.error).toBe('link-invalid');
  });

  it('410 link-invalid when reason=used (token already consumed)', async () => {
    resetMock.mockResolvedValueOnce(
      err({ code: 'link-invalid', reason: 'used' as const }),
    );

    const response = await POST(
      makeRequest({ token: VALID_TOKEN, newPassword: 'new passphrase 2026!' }),
    );
    expect(response.status).toBe(410);
    const body = await response.json();
    // Same public body across all three reasons — enumeration safety.
    expect(body.error).toBe('link-invalid');
  });

  it('429 rate-limited with Retry-After', async () => {
    resetMock.mockResolvedValueOnce(
      err({ code: 'rate-limited', retryAfterSeconds: 300 }),
    );

    const response = await POST(
      makeRequest({ token: VALID_TOKEN, newPassword: 'new passphrase 2026!' }),
    );
    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('300');
  });
});
