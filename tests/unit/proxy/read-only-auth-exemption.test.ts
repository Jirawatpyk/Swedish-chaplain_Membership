/**
 * D-028 — the READ_ONLY_MODE write freeze leaves exactly three auth POSTs
 * up: sign-in, sign-out and heartbeat (spec 001 quickstart § 7.3: "Sign-in
 * is explicitly allowed"). R86 found sign-in refused with 503, locking every
 * signed-out user out for the whole freeze. Every other state-changing
 * request, the other auth flows included, stays frozen, and the exempted
 * three still pass the CSRF Origin check.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const envMock = {
  isDevelopment: false,
  isProduction: true,
  isTest: true,
  flags: { readOnlyMode: true },
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

const { proxy, READ_ONLY_EXEMPT_PATHS } = await import('@/proxy');

function post(path: string, origin = 'http://localhost:3100'): NextRequest {
  return new NextRequest(`http://localhost:3100${path}`, {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json' },
  });
}

afterEach(() => {
  envMock.flags.readOnlyMode = true;
});

describe('proxy — READ_ONLY_MODE auth exemptions (D-028)', () => {
  it('exempts exactly these three paths (a fourth needs a decision)', () => {
    expect([...READ_ONLY_EXEMPT_PATHS].sort()).toEqual([
      '/api/auth/heartbeat',
      '/api/auth/sign-in',
      '/api/auth/sign-out',
    ]);
  });

  it.each(['/api/auth/sign-in', '/api/auth/sign-out', '/api/auth/heartbeat'])(
    'POST %s passes the freeze',
    (path) => {
      expect(proxy(post(path)).status).toBe(200);
    },
  );

  it.each([
    '/api/auth/reset-password',
    '/api/auth/forgot-password',
    '/api/auth/change-password',
    '/api/auth/redeem-invite',
    '/api/portal/renewal/redeem-link',
    '/api/members',
  ])('POST %s stays frozen (503 read-only-mode)', async (path) => {
    const res = proxy(post(path));
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe('read-only-mode');
  });

  it.each([
    '/api/auth/sign-in/',
    '/api/auth/sign-in-x',
    '/api/auth/SIGN-IN',
    '/api/auth/sign-in/extra',
    '/api/auth/sign%2Din',
    '//api/auth/sign-in',
    '/api/auth/sign-in;x',
  ])(
    'near-miss POST %s stays frozen (exact match only)',
    (path) => {
      expect(proxy(post(path)).status).toBe(503);
    },
  );

  it('a dot-segment path that resolves to sign-in passes (the router resolves it to the same handler)', () => {
    const req = post('/api/auth/reset-password/../sign-in');
    expect(req.nextUrl.pathname).toBe('/api/auth/sign-in');
    expect(proxy(req).status).toBe(200);
  });

  it('a non-POST verb on an exempt path stays frozen', () => {
    const req = new NextRequest('http://localhost:3100/api/auth/sign-in', {
      method: 'DELETE',
      headers: { origin: 'http://localhost:3100' },
    });
    expect(proxy(req).status).toBe(503);
  });

  it('an exempt POST from another origin is still refused by CSRF (403)', () => {
    expect(proxy(post('/api/auth/sign-in', 'https://evil.example')).status).toBe(403);
  });

  it('with the freeze off, sign-in and a frozen path both pass', () => {
    envMock.flags.readOnlyMode = false;
    expect(proxy(post('/api/auth/sign-in')).status).toBe(200);
    expect(proxy(post('/api/auth/reset-password')).status).toBe(200);
  });
});
