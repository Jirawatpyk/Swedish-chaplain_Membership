/**
 * T110 — Redeem-invite contract test (contracts/auth-api.md § 7).
 *
 * Route: POST /api/auth/redeem-invite
 * Contract: 200 (auto sign-in + redirect), 400 (invalid-input / weak-password),
 *           410 (link-invalid), 429 (rate-limited).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { ok, err } from '@/lib/result';

const redeemInviteMock = vi.fn();
const setCookieMock = vi.fn(async (id: string) => { void id; });

vi.mock('@/modules/auth/application/redeem-invite', () => ({
  redeemInvite: (...args: unknown[]) => redeemInviteMock(...args),
}));

vi.mock('@/lib/auth-cookies', () => ({
  setSessionCookie: (id: string) => setCookieMock(id),
}));

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

vi.mock('@/lib/request-id', () => ({
  requestIdFromHeaders: () => 'test-req-id',
}));

function makeRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/auth/redeem-invite', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-forwarded-for': '203.0.113.5',
    },
    body: JSON.stringify(body),
  });
}

describe('contract: POST /api/auth/redeem-invite (T110)', () => {
  afterEach(() => { vi.clearAllMocks(); });

  it('200 on success — sets cookie, returns user + redirectTo', async () => {
    redeemInviteMock.mockResolvedValueOnce(
      ok({
        user: { id: 'u1', email: 'new@swecham.se', role: 'admin', status: 'active', displayName: 'New User' },
        session: { id: 'sess-new' },
        redirectTo: '/admin',
      }),
    );

    const { POST } = await import('@/app/api/auth/redeem-invite/route');
    const res = await POST(makeRequest({ token: 'a'.repeat(64), password: 'Str0ng-P@ss-2026!' }));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.user.email).toBe('new@swecham.se');
    expect(body.redirectTo).toBe('/admin');
    expect(setCookieMock).toHaveBeenCalledWith('sess-new');
  });

  it('400 on invalid input (short token)', async () => {
    const { POST } = await import('@/app/api/auth/redeem-invite/route');
    const res = await POST(makeRequest({ token: 'short', password: 'x' }));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('invalid-input');
    expect(redeemInviteMock).not.toHaveBeenCalled();
  });

  it('400 on weak password', async () => {
    redeemInviteMock.mockResolvedValueOnce(
      err({ code: 'weak-password', errors: [{ code: 'too-short' }] }),
    );

    const { POST } = await import('@/app/api/auth/redeem-invite/route');
    const res = await POST(makeRequest({ token: 'a'.repeat(64), password: 'weak' }));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('weak-password');
    expect(body.issues).toContain('too-short');
  });

  it('404 on link-invalid when reason=not-found', async () => {
    redeemInviteMock.mockResolvedValueOnce(
      err({ code: 'link-invalid', reason: 'not-found' as const }),
    );

    const { POST } = await import('@/app/api/auth/redeem-invite/route');
    const res = await POST(makeRequest({ token: 'a'.repeat(64), password: 'Good-P@ss-2026!' }));

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe('link-invalid');
  });

  it('410 on link-invalid when reason=expired', async () => {
    redeemInviteMock.mockResolvedValueOnce(
      err({ code: 'link-invalid', reason: 'expired' as const }),
    );

    const { POST } = await import('@/app/api/auth/redeem-invite/route');
    const res = await POST(makeRequest({ token: 'a'.repeat(64), password: 'Good-P@ss-2026!' }));

    expect(res.status).toBe(410);
    const body = await res.json();
    expect(body.error).toBe('link-invalid');
  });

  it('410 on link-invalid when reason=used (token already consumed)', async () => {
    redeemInviteMock.mockResolvedValueOnce(
      err({ code: 'link-invalid', reason: 'used' as const }),
    );

    const { POST } = await import('@/app/api/auth/redeem-invite/route');
    const res = await POST(makeRequest({ token: 'a'.repeat(64), password: 'Good-P@ss-2026!' }));

    expect(res.status).toBe(410);
    const body = await res.json();
    // Same public body across all three reasons — enumeration safety.
    expect(body.error).toBe('link-invalid');
  });

  it('429 on rate-limited with Retry-After header', async () => {
    redeemInviteMock.mockResolvedValueOnce(err({ code: 'rate-limited', retryAfterSeconds: 120 }));

    const { POST } = await import('@/app/api/auth/redeem-invite/route');
    const res = await POST(makeRequest({ token: 'a'.repeat(64), password: 'Good-P@ss-2026!' }));

    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('120');
  });

  it('400 on non-JSON body', async () => {
    const { POST } = await import('@/app/api/auth/redeem-invite/route');
    const res = await POST(
      new NextRequest('http://localhost/api/auth/redeem-invite', {
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        body: 'not json',
      }),
    );
    expect(res.status).toBe(400);
  });
});
