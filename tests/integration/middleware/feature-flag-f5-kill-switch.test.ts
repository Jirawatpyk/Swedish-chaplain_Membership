/**
 * FEATURE_F5_ONLINE_PAYMENT kill-switch integration test.
 *
 * When `FEATURE_F5_ONLINE_PAYMENT=false` (default for dark ship), the
 * proxy returns 503 `feature_disabled` on every F5 surface. Mirrors the
 * F3/F4 kill-switch tests — reversible via Vercel env, no code deploy.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/env', () => ({
  env: {
    isDevelopment: true,
    isProduction: false,
    isTest: true,
    flags: { readOnlyMode: false },
    features: { f3Members: true, f4Invoicing: true, f5OnlinePayment: false },
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

describe('F5 feature-flag kill-switch', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    'POST /api/payments/initiate',
    'GET /api/payments/abc-123',
    'POST /api/refunds',
    'POST /api/webhooks/stripe',
    'GET /api/tenant-payment-settings',
    'GET /portal/invoices/abc-123/pay',
    'POST /admin/invoices/abc-123/refund',
  ])('%s → 503 feature_disabled', async (spec) => {
    const [method, path] = spec.split(' ') as [string, string];
    const response = proxy(makeRequest(method, path));
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.error).toBe('feature_disabled');
    expect(response.headers.get('retry-after')).toBe('300');
  });

  it.each([
    'GET /api/auth/me',
    'GET /api/plans',
    'GET /api/invoices/abc',
    'GET /api/members',
    'GET /admin/invoices/abc',
    'GET /portal/invoices/abc',
  ])('%s is NOT blocked by F5 kill-switch', async (spec) => {
    const [method, path] = spec.split(' ') as [string, string];
    const response = proxy(makeRequest(method, path));
    expect(response.status).toBe(200);
  });
});
