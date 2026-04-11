/**
 * T147 — POST /api/auth/change-password contract test.
 *
 * Cases (contracts/auth-api.md § 5):
 *   - 200 + rotated cookie on success
 *   - 400 invalid-input (missing fields)
 *   - 401 no-session
 *   - 403 wrong-current-password
 *   - 400 weak-password (with issues[])
 *   - 400 same-password
 *   - 429 rate-limited with Retry-After
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { POST } from '@/app/api/auth/change-password/route';
import { ok, err } from '@/lib/result';

const changeMock = vi.fn();
vi.mock('@/modules/auth/application/change-password', async () => {
  const actual = await vi.importActual<
    typeof import('@/modules/auth/application/change-password')
  >('@/modules/auth/application/change-password');
  return {
    ...actual,
    changePassword: (...args: unknown[]) => changeMock(...args),
  };
});

const getCurrentSessionMock = vi.fn();
vi.mock('@/lib/auth-session', () => ({
  getCurrentSession: () => getCurrentSessionMock(),
}));

const setCookieMock = vi.fn(async (id: string) => {
  // captured via vi.fn; body intentionally reads the param to
  // satisfy no-unused-vars while we only assert the call args
  void id;
});
vi.mock('@/lib/auth-cookies', () => ({
  setSessionCookie: (id: string) => setCookieMock(id),
  clearSessionCookie: vi.fn(async () => undefined),
  getSessionIdFromCookie: vi.fn(async () => null),
}));

const adminSession = {
  user: {
    id: '00000000-0000-0000-0000-000000000001',
    email: 'admin@test',
    role: 'admin',
    status: 'active',
    displayName: 'Admin',
  },
  session: { id: 'old-session-id' },
};

function makeRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/auth/change-password', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-forwarded-for': '203.0.113.12',
    },
    body: JSON.stringify(body),
  });
}

describe('POST /api/auth/change-password', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('200 on success + cookie rotated to new session id', async () => {
    getCurrentSessionMock.mockResolvedValueOnce(adminSession);
    changeMock.mockResolvedValueOnce(
      ok({ newSession: { id: 'new-session-id' } }),
    );

    const response = await POST(
      makeRequest({
        currentPassword: 'old passphrase',
        newPassword: 'new long passphrase 2026',
      }),
    );
    expect(response.status).toBe(200);
    expect(setCookieMock).toHaveBeenCalledWith('new-session-id');
  });

  it('401 when no session', async () => {
    getCurrentSessionMock.mockResolvedValueOnce(null);

    const response = await POST(
      makeRequest({
        currentPassword: 'x',
        newPassword: 'y',
      }),
    );
    expect(response.status).toBe(401);
    expect(changeMock).not.toHaveBeenCalled();
  });

  it('400 on missing currentPassword', async () => {
    getCurrentSessionMock.mockResolvedValueOnce(adminSession);

    const response = await POST(makeRequest({ newPassword: 'x' }));
    expect(response.status).toBe(400);
  });

  it('400 on missing newPassword', async () => {
    getCurrentSessionMock.mockResolvedValueOnce(adminSession);

    const response = await POST(makeRequest({ currentPassword: 'x' }));
    expect(response.status).toBe(400);
  });

  it('403 wrong-current-password', async () => {
    getCurrentSessionMock.mockResolvedValueOnce(adminSession);
    changeMock.mockResolvedValueOnce(err({ code: 'wrong-current-password' }));

    const response = await POST(
      makeRequest({
        currentPassword: 'wrong',
        newPassword: 'new long passphrase 2026',
      }),
    );
    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error).toBe('wrong-current-password');
  });

  it('400 same-password', async () => {
    getCurrentSessionMock.mockResolvedValueOnce(adminSession);
    changeMock.mockResolvedValueOnce(err({ code: 'same-password' }));

    const response = await POST(
      makeRequest({
        currentPassword: 'same',
        newPassword: 'same',
      }),
    );
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe('same-password');
  });

  it('400 weak-password with issues[]', async () => {
    getCurrentSessionMock.mockResolvedValueOnce(adminSession);
    changeMock.mockResolvedValueOnce(
      err({
        code: 'weak-password',
        errors: [{ code: 'breached', occurrences: 42 }],
      }),
    );

    const response = await POST(
      makeRequest({
        currentPassword: 'old',
        newPassword: 'password1234',
      }),
    );
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe('weak-password');
    expect(body.issues).toContain('breached');
  });

  it('429 rate-limited with Retry-After', async () => {
    getCurrentSessionMock.mockResolvedValueOnce(adminSession);
    changeMock.mockResolvedValueOnce(
      err({ code: 'rate-limited', retryAfterSeconds: 420 }),
    );

    const response = await POST(
      makeRequest({
        currentPassword: 'x',
        newPassword: 'y',
      }),
    );
    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('420');
  });
});
