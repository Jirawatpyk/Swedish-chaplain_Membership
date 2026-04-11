/**
 * T044 — READ_ONLY_MODE proxy test (spec FR-007 rollback lever).
 *
 * When `READ_ONLY_MODE=true` is set in the Vercel environment, the
 * proxy MUST return 503 `read-only-mode` on every state-changing
 * HTTP method (POST, PUT, PATCH, DELETE) while keeping GET requests
 * alive. This is the 30-second reversible rollback lever documented
 * in `docs/runbook/auth.md § 3`.
 *
 * Test strategy: import the `proxy` function directly from
 * `src/proxy.ts` and invoke it with a constructed `NextRequest`. We
 * mock `@/lib/env` to flip `flags.readOnlyMode` without having to
 * set an env var and reload the module. GETs must pass (NextResponse.next);
 * POSTs must 503.
 *
 * This is classified as an integration test because the proxy imports
 * the real `checkCsrf` + `request-id` helpers.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/env', () => ({
  env: {
    isDevelopment: true,
    flags: { readOnlyMode: true },
    app: { allowedOrigins: ['http://localhost:3100'] },
  },
}));

// Import AFTER the mock so proxy.ts picks up the mocked env.
const { proxy } = await import('@/proxy');

function makeRequest(method: string, path = '/api/auth/sign-in'): NextRequest {
  return new NextRequest(`http://localhost:3100${path}`, {
    method,
    headers: {
      origin: 'http://localhost:3100',
      'content-type': 'application/json',
    },
  });
}

describe('integration: proxy READ_ONLY_MODE (T044, FR-007)', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('POST /api/auth/sign-in → 503 read-only-mode with Retry-After', async () => {
    const response = proxy(makeRequest('POST'));
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.error).toBe('read-only-mode');
    expect(response.headers.get('retry-after')).toBe('300');
  });

  it('PUT → 503', async () => {
    const response = proxy(makeRequest('PUT'));
    expect(response.status).toBe(503);
  });

  it('PATCH → 503', async () => {
    const response = proxy(makeRequest('PATCH'));
    expect(response.status).toBe(503);
  });

  it('DELETE → 503', async () => {
    const response = proxy(makeRequest('DELETE'));
    expect(response.status).toBe(503);
  });

  it('GET /admin/sign-in → passes through (read-only does not block reads)', async () => {
    const response = proxy(makeRequest('GET', '/admin/sign-in'));
    // NextResponse.next() returns a response without a body; status is 200
    // or the HSTS/CSP headers are set via applySecurityHeaders.
    expect(response.status).toBe(200);
    expect(response.headers.get('strict-transport-security')).toContain('max-age');
    expect(response.headers.get('content-security-policy')).toContain('default-src');
  });

  it('HEAD → passes through (non-state-changing)', async () => {
    const response = proxy(makeRequest('HEAD', '/admin/sign-in'));
    expect(response.status).toBe(200);
  });

  it('response carries the x-request-id header', async () => {
    const response = proxy(makeRequest('POST'));
    expect(response.headers.get('x-request-id')).toBeTruthy();
  });

  it('503 response still has security headers', async () => {
    const response = proxy(makeRequest('POST'));
    expect(response.headers.get('strict-transport-security')).toContain('max-age');
    expect(response.headers.get('x-frame-options')).toBe('DENY');
  });
});
