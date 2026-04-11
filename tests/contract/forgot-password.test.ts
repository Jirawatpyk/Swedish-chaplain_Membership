/**
 * T088 — POST /api/auth/forgot-password contract test.
 *
 * Validates the wire contract from contracts/auth-api.md § 3 by
 * stubbing the use case. Cases:
 *   - 200 always (unknown or known email, active or disabled)
 *   - 400 invalid-input (malformed email / missing field)
 *   - 429 rate-limited with Retry-After header
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { POST } from '@/app/api/auth/forgot-password/route';
import { ok, err } from '@/lib/result';

const forgotMock = vi.fn();
vi.mock('@/modules/auth/application/forgot-password', async () => {
  const actual = await vi.importActual<
    typeof import('@/modules/auth/application/forgot-password')
  >('@/modules/auth/application/forgot-password');
  return {
    ...actual,
    forgotPassword: (...args: unknown[]) => forgotMock(...args),
  };
});

function makeRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/auth/forgot-password', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-forwarded-for': '203.0.113.7',
    },
    body: JSON.stringify(body),
  });
}

describe('POST /api/auth/forgot-password', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('200 with neutral message on success', async () => {
    forgotMock.mockResolvedValueOnce(ok({ ok: true }));

    const response = await POST(makeRequest({ email: 'jane@example.com' }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.message).toContain('reset link has been sent');
  });

  it('200 for unknown email (enumeration safety)', async () => {
    // Use case returns ok even for unknown emails; the route just
    // mirrors that. This test documents the contract explicitly.
    forgotMock.mockResolvedValueOnce(ok({ ok: true }));

    const response = await POST(makeRequest({ email: 'ghost@nowhere.example' }));
    expect(response.status).toBe(200);
  });

  it('400 on missing email field', async () => {
    const response = await POST(makeRequest({}));
    expect(response.status).toBe(400);
    expect(forgotMock).not.toHaveBeenCalled();
  });

  it('400 on malformed email', async () => {
    const response = await POST(makeRequest({ email: 'not-an-email' }));
    expect(response.status).toBe(400);
    expect(forgotMock).not.toHaveBeenCalled();
  });

  it('400 on non-JSON body', async () => {
    const request = new NextRequest(
      'http://localhost/api/auth/forgot-password',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: 'not json at all',
      },
    );
    const response = await POST(request);
    expect(response.status).toBe(400);
  });

  it('429 with Retry-After when rate-limited', async () => {
    forgotMock.mockResolvedValueOnce(
      err({ code: 'rate-limited', retryAfterSeconds: 600 }),
    );

    const response = await POST(makeRequest({ email: 'jane@example.com' }));
    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('600');
  });

  it('accepts optional locale parameter', async () => {
    forgotMock.mockResolvedValueOnce(ok({ ok: true }));

    const response = await POST(
      makeRequest({ email: 'jane@example.com', locale: 'th' }),
    );
    expect(response.status).toBe(200);
    expect(forgotMock).toHaveBeenCalledWith(
      expect.objectContaining({ locale: 'th' }),
    );
  });
});
