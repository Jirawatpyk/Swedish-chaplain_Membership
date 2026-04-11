/**
 * T055 — POST /api/auth/sign-out contract test.
 *
 * Validates contracts/auth-api.md § 2:
 *   200 — { ok: true }, cookie cleared
 *   200 — idempotent: second call with no cookie also returns 200
 *         (F1 does not use strict mode; see contract note)
 *
 * Unlike sign-in, sign-out has no zod-validated body and no rate
 * limit, so the contract surface is small. Mocks `sessionRepo` +
 * `auth-cookies` to avoid touching the DB.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const clearSessionCookieMock = vi.fn(async () => undefined);
const getSessionIdFromCookieMock = vi.fn(async (): Promise<string | null> => null);
const sessionFindByIdMock = vi.fn(async (): Promise<unknown> => null);
const sessionDeleteMock = vi.fn(async () => undefined);
const auditAppendMock = vi.fn(async () => undefined);

vi.mock('@/lib/auth-cookies', () => ({
  SESSION_COOKIE_NAME: 'swecham_session',
  clearSessionCookie: clearSessionCookieMock,
  getSessionIdFromCookie: getSessionIdFromCookieMock,
  setSessionCookie: vi.fn(async () => undefined),
}));

vi.mock('@/modules/auth/infrastructure/db/session-repo', () => ({
  sessionRepo: {
    findById: sessionFindByIdMock,
    delete: sessionDeleteMock,
    create: vi.fn(),
    updateLastSeen: vi.fn(),
    deleteByUserId: vi.fn(),
    deleteByUserIdExcept: vi.fn(),
  },
}));

vi.mock('@/modules/auth/infrastructure/db/audit-repo', () => ({
  auditRepo: {
    append: auditAppendMock,
  },
}));

// Import AFTER mocks are declared so the route picks up the stubs.
const { POST } = await import('@/app/api/auth/sign-out/route');

function makeRequest(): NextRequest {
  return new NextRequest('http://localhost/api/auth/sign-out', {
    method: 'POST',
    headers: { 'x-forwarded-for': '203.0.113.5' },
  });
}

describe('POST /api/auth/sign-out', () => {
  beforeEach(() => {
    clearSessionCookieMock.mockClear();
    getSessionIdFromCookieMock.mockClear();
    sessionFindByIdMock.mockClear();
    sessionDeleteMock.mockClear();
    auditAppendMock.mockClear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('200 with no session cookie (idempotent)', async () => {
    getSessionIdFromCookieMock.mockResolvedValueOnce(null);

    const response = await POST(makeRequest());

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(clearSessionCookieMock).toHaveBeenCalled();
    expect(sessionDeleteMock).not.toHaveBeenCalled();
    expect(auditAppendMock).not.toHaveBeenCalled();
  });

  it('200 when session is present — deletes session row + audits sign_out', async () => {
    getSessionIdFromCookieMock.mockResolvedValueOnce('abc123def456');
    sessionFindByIdMock.mockResolvedValueOnce({
      id: 'abc123def456',
      userId: '00000000-0000-0000-0000-000000000001',
      createdAt: new Date(),
      lastSeenAt: new Date(),
      expiresAt: new Date(Date.now() + 3600_000),
      sourceIp: '203.0.113.5',
    });

    const response = await POST(makeRequest());

    expect(response.status).toBe(200);
    expect(clearSessionCookieMock).toHaveBeenCalled();
    expect(sessionDeleteMock).toHaveBeenCalledWith('abc123def456');
    expect(auditAppendMock).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'sign_out',
        targetUserId: '00000000-0000-0000-0000-000000000001',
      }),
    );
  });

  it('200 when cookie exists but session row was already removed (stale cookie)', async () => {
    getSessionIdFromCookieMock.mockResolvedValueOnce('stale-cookie-value');
    sessionFindByIdMock.mockResolvedValueOnce(null);

    const response = await POST(makeRequest());

    expect(response.status).toBe(200);
    // Use case is still invoked with the sessionId — it will issue a
    // harmless `delete` against a row that doesn't exist.
    expect(sessionDeleteMock).toHaveBeenCalledWith('stale-cookie-value');
    // No audit event because userId is null
    expect(auditAppendMock).not.toHaveBeenCalled();
    expect(clearSessionCookieMock).toHaveBeenCalled();
  });

  it('still clears the cookie + returns 500 if the use case throws', async () => {
    getSessionIdFromCookieMock.mockResolvedValueOnce('abc123def456');
    sessionFindByIdMock.mockRejectedValueOnce(new Error('DB down'));

    const response = await POST(makeRequest());

    expect(response.status).toBe(500);
    // Client safety: cookie MUST be cleared even when the use case fails
    expect(clearSessionCookieMock).toHaveBeenCalled();
  });
});
