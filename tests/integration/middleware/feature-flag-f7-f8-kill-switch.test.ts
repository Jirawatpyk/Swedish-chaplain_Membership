/**
 * B6 (post-ship 2026-05-17) — coverage for F7 + F8 kill-switch paths
 * in src/proxy.ts. Mirrors the F3 + F5 integration tests:
 *   - F7 (broadcasts): /api/broadcasts, /api/admin/broadcasts,
 *     /api/webhooks/resend-broadcasts, /unsubscribe, /portal/broadcasts,
 *     /admin/broadcasts, /portal/benefits/e-blasts.
 *   - F8 (renewals): /api/cron/renewals, /api/admin/renewals,
 *     /api/portal/renewal, /admin/renewals, /portal/renewal, etc.
 *
 * The review report flagged "src/middleware.ts has no unit test" — the
 * actual file is `src/proxy.ts` (Next.js 16 rename) and the F3 + F5
 * patterns are tested but F4 / F7 / F8 had no coverage. This test
 * fills the F7 + F8 gap; F4 has separate coverage in the readonly-mode
 * test bundle via the f4Invoicing flag.
 *
 * Session/role guards do NOT live in proxy.ts (Edge runtime can't
 * import postgres-js) — they live in `getCurrentSession()` called from
 * route handlers + server components. So those review checklist
 * items (missing-cookie redirect / role-portal guard / etc.) are NOT
 * proxy concerns and don't belong here.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/env', () => ({
  env: {
    isDevelopment: true,
    isProduction: false,
    isTest: true,
    flags: { readOnlyMode: false },
    features: {
      f3Members: true,
      f4Invoicing: true,
      f5OnlinePayment: true,
      f7Broadcasts: false,
      f8Renewals: false,
    },
    app: { allowedOrigins: ['http://localhost:3100'] },
    log: { level: 'silent' },
  },
}));

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

describe('F7 + F8 feature-flag kill-switches', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  // --- F7 broadcasts paths blocked ----------------------------------------
  it.each([
    'POST /api/broadcasts',
    'GET /api/admin/broadcasts',
    'POST /api/webhooks/resend-broadcasts',
    'GET /unsubscribe/abc-token',
    'GET /portal/broadcasts',
    'GET /admin/broadcasts',
    'GET /portal/benefits/e-blasts',
  ])('F7: %s → 503 feature_disabled', async (spec) => {
    const [method, path] = spec.split(' ') as [string, string];
    const response = proxy(makeRequest(method, path));
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.error).toBe('feature_disabled');
    expect(response.headers.get('retry-after')).toBe('300');
    expect(body.retryAfterSeconds).toBe(300);
  });

  // --- F8 renewal paths blocked ------------------------------------------
  it.each([
    'POST /api/cron/renewals/dispatch',
    'GET /api/admin/renewals/pipeline',
    'POST /api/admin/members/abc-uuid-1/block-auto-reactivation',
    'POST /api/admin/members/abc-uuid-2/unblock-auto-reactivation',
    'POST /api/portal/renewal/confirm',
    'GET /api/portal/preferences/renewals',
    'GET /admin/renewals',
    'GET /admin/settings/renewals',
    'GET /portal/renewal',
    'GET /portal/preferences/renewals',
  ])('F8: %s → 503 feature_disabled', async (spec) => {
    const [method, path] = spec.split(' ') as [string, string];
    const response = proxy(makeRequest(method, path));
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.error).toBe('feature_disabled');
  });

  // --- Sibling F* paths NOT blocked (regression guard) ------------------
  it.each([
    'GET /api/auth/me',
    'POST /api/auth/sign-in',
    'GET /api/plans',
    'GET /api/members',
    'GET /api/invoices/abc',
    'GET /admin/invoices/abc',
  ])('sibling: %s is NOT blocked by F7/F8 kill-switches', async (spec) => {
    const [method, path] = spec.split(' ') as [string, string];
    const response = proxy(makeRequest(method, path));
    expect(response.status).toBe(200);
  });

  // --- 503 body shape (T031 / FR-049 documented contract) --------------
  it('503 body carries the canonical machine-readable schema', async () => {
    const response = proxy(makeRequest('POST', '/api/broadcasts'));
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body).toMatchObject({
      error: 'feature_disabled',
      retryAfterSeconds: 300,
      supportUrl: '/admin/support',
    });
    expect(typeof body.message).toBe('string');
  });
});
