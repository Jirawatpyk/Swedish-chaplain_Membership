/**
 * RFC 8058 one-click POST through the real proxy: it must reach the API
 * handler without an Origin header (mail providers send none), stay behind
 * the F7 kill switch and the READ_ONLY freeze, and never rewrite outside
 * `/api/unsubscribe/<token>`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const envMock = {
  isDevelopment: false,
  isProduction: true,
  isTest: true,
  flags: { readOnlyMode: false },
  features: {
    f3Members: true,
    f4Invoicing: true,
    f5OnlinePayment: true,
    f7Broadcasts: true,
    f8Renewals: true,
  },
  app: { allowedOrigins: ['http://localhost:3100'] },
  log: { level: 'silent' },
};
vi.mock('@/lib/env', () => ({ env: envMock }));

const { proxy } = await import('@/proxy');

function oneClick(path: string): NextRequest {
  return new NextRequest(`http://localhost:3100${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'List-Unsubscribe=One-Click',
  });
}

afterEach(() => {
  envMock.flags.readOnlyMode = false;
  envMock.features.f7Broadcasts = true;
});

describe('proxy — one-click unsubscribe POST', () => {
  it('rewrites to the API handler with no Origin header (no CSRF 403)', () => {
    const res = proxy(oneClick('/unsubscribe/v1.abc.def'));
    expect(res.status).not.toBe(403);
    expect(res.headers.get('x-middleware-rewrite')).toBe(
      'http://localhost:3100/api/unsubscribe/v1.abc.def',
    );
  });

  it('READ_ONLY_MODE → 503 before any rewrite', () => {
    envMock.flags.readOnlyMode = true;
    const res = proxy(oneClick('/unsubscribe/v1.abc.def'));
    expect(res.status).toBe(503);
    expect(res.headers.get('x-middleware-rewrite')).toBeNull();
  });

  it('F7 off → 503 before any rewrite', () => {
    envMock.features.f7Broadcasts = false;
    const res = proxy(oneClick('/unsubscribe/v1.abc.def'));
    expect(res.status).toBe(503);
    expect(res.headers.get('x-middleware-rewrite')).toBeNull();
  });

  it('encoded traversal never escapes /api/unsubscribe/<token>', () => {
    for (const path of ['/unsubscribe/%2e%2e', '/unsubscribe/a%2Fb', '/unsubscribe/..%2Fadmin']) {
      const target = proxy(oneClick(path)).headers.get('x-middleware-rewrite');
      if (target !== null) {
        expect(new URL(target).pathname).toMatch(/^\/api\/unsubscribe\/[^/]+$/);
      }
    }
  });

  it('a direct POST to the API path without Origin is still refused', () => {
    expect(proxy(oneClick('/api/unsubscribe/v1.abc.def')).status).toBe(403);
  });
});
