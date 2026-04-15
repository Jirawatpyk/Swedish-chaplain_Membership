/**
 * T037 — FEATURE_F3_MEMBERS kill-switch integration test.
 *
 * When `FEATURE_F3_MEMBERS=false` (reversible via Vercel env, no code
 * deploy), the proxy returns 503 `read_only_mode` on every `/api/members/**`
 * and `/api/portal/**` request — both reads and writes. This is the
 * "disable the feature at 3am without deploying" lever per plan.md
 * § Feature flag infra.
 *
 * Same mocking pattern as the READ_ONLY_MODE integration test (T044).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/env', () => ({
  env: {
    isDevelopment: true,
    flags: { readOnlyMode: false },
    features: { f3Members: false },
    app: { allowedOrigins: ['http://localhost:3100'] },
  },
}));

// Import AFTER the mock so proxy.ts picks up the mocked env.
const { proxy } = await import('@/proxy');

function makeRequest(method: string, path: string): NextRequest {
  return new NextRequest(`http://localhost:3100${path}`, {
    method,
    headers: {
      origin: 'http://localhost:3100',
      'content-type': 'application/json',
    },
  });
}

describe('F3 feature-flag kill-switch (T037)', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('GET /api/members → 503 read_only_mode', async () => {
    const response = proxy(makeRequest('GET', '/api/members'));
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.error).toBe('read_only_mode');
    expect(response.headers.get('retry-after')).toBe('300');
  });

  it('POST /api/members → 503 read_only_mode', async () => {
    const response = proxy(makeRequest('POST', '/api/members'));
    expect(response.status).toBe(503);
  });

  it('GET /api/members/abc-123 → 503 read_only_mode', async () => {
    const response = proxy(makeRequest('GET', '/api/members/abc-123'));
    expect(response.status).toBe(503);
  });

  it('GET /api/portal/profile → 503 read_only_mode', async () => {
    const response = proxy(makeRequest('GET', '/api/portal/profile'));
    expect(response.status).toBe(503);
  });

  it('PATCH /api/portal/profile → 503 read_only_mode', async () => {
    const response = proxy(makeRequest('PATCH', '/api/portal/profile'));
    expect(response.status).toBe(503);
  });

  it('GET /api/auth/me does NOT get blocked (not an F3 path)', async () => {
    const response = proxy(makeRequest('GET', '/api/auth/me'));
    // Passes through — NextResponse.next() yields 200 with security headers.
    expect(response.status).toBe(200);
  });

  it('GET /api/plans does NOT get blocked (F2 unaffected)', async () => {
    const response = proxy(makeRequest('GET', '/api/plans'));
    expect(response.status).toBe(200);
  });
});
