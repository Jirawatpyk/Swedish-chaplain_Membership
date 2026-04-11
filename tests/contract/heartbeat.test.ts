/**
 * POST /api/auth/heartbeat contract test
 * (contracts/auth-api.md § 11, spec FR-022).
 *
 * Cases:
 *   - 200 ok with lastSeenAt ISO string
 *   - 401 no-session (unauthenticated caller)
 *   - 429 rate-limited with Retry-After header
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { ok, err } from '@/lib/result';

const getCurrentSessionMock = vi.fn();
const heartbeatMock = vi.fn();

vi.mock('@/lib/auth-session', () => ({
  getCurrentSession: () => getCurrentSessionMock(),
}));

// The route handler imports `heartbeat` from `@/modules/auth`
// (the public barrel — Constitution Principle III). Stub the
// barrel DIRECTLY with only the symbol the route uses.
vi.mock('@/modules/auth', () => ({
  heartbeat: (...args: unknown[]) => heartbeatMock(...args),
}));

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const signedInSession = {
  user: {
    id: '00000000-0000-0000-0000-000000000001',
    email: 'admin@swecham.test',
    role: 'admin',
    status: 'active',
    displayName: 'Admin',
  },
  session: { id: 'a'.repeat(64) },
};

function makeRequest(): NextRequest {
  return new NextRequest('http://localhost/api/auth/heartbeat', {
    method: 'POST',
    headers: {
      'x-forwarded-for': '203.0.113.10',
      'x-request-id': '019d721d-0000-0000-0000-000000000099',
    },
  });
}

describe('POST /api/auth/heartbeat', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('200 with lastSeenAt ISO string on success', async () => {
    const lastSeenAt = new Date('2026-04-10T12:34:56.000Z');
    getCurrentSessionMock.mockResolvedValueOnce(signedInSession);
    heartbeatMock.mockResolvedValueOnce(ok({ lastSeenAt }));

    const { POST } = await import('@/app/api/auth/heartbeat/route');
    const response = await POST(makeRequest());

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.lastSeenAt).toBe('2026-04-10T12:34:56.000Z');
  });

  it('401 no-session when not signed in', async () => {
    getCurrentSessionMock.mockResolvedValueOnce(null);

    const { POST } = await import('@/app/api/auth/heartbeat/route');
    const response = await POST(makeRequest());

    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body.error).toBe('no-session');
    // Use case MUST NOT be called when the session check fails.
    expect(heartbeatMock).not.toHaveBeenCalled();
  });

  it('429 rate-limited with Retry-After header', async () => {
    getCurrentSessionMock.mockResolvedValueOnce(signedInSession);
    heartbeatMock.mockResolvedValueOnce(
      err({ code: 'rate-limited', retryAfterSeconds: 45 }),
    );

    const { POST } = await import('@/app/api/auth/heartbeat/route');
    const response = await POST(makeRequest());

    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('45');
    const body = await response.json();
    expect(body.error).toBe('rate-limited');
  });

  it('500 server-error when getCurrentSession throws (infra failure)', async () => {
    getCurrentSessionMock.mockRejectedValueOnce(new Error('Neon down'));

    const { POST } = await import('@/app/api/auth/heartbeat/route');
    const response = await POST(makeRequest());

    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error).toBe('server-error');
    // Critical: the try/catch must catch the throw and return a
    // structured JSON body, not let Next.js bubble a raw HTML 500.
    expect(heartbeatMock).not.toHaveBeenCalled();
  });

  it('500 server-error when heartbeat use case throws', async () => {
    getCurrentSessionMock.mockResolvedValueOnce(signedInSession);
    heartbeatMock.mockRejectedValueOnce(new Error('Upstash blip'));

    const { POST } = await import('@/app/api/auth/heartbeat/route');
    const response = await POST(makeRequest());

    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error).toBe('server-error');
  });
});
