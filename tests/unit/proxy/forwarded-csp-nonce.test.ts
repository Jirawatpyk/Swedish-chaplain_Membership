/**
 * Incident 2026-07-30 regression — the proxy MUST forward the full
 * `Content-Security-Policy` header (carrying the per-request nonce) onto
 * the REQUEST, not just `x-nonce`. Next.js derives the nonce it stamps on
 * its bootstrap AND streamed (Suspense-boundary) scripts from the
 * request's CSP header (canonical nonce-middleware pattern,
 * nextjs.org/docs/.../content-security-policy). Forwarding only `x-nonce`
 * left streamed / dynamically-loaded chunk scripts intermittently
 * un-nonced on Suspense-heavy authenticated pages; under prod
 * `'strict-dynamic'` (which disables `'self'`) those scripts were
 * CSP-blocked, killing all page JS.
 *
 * `NextResponse.next({ request: { headers } })` encodes the overridden
 * request headers back onto the response as `x-middleware-override-headers`
 * (comma list) + `x-middleware-request-<name>` entries — that is how a
 * middleware/proxy test reads the FORWARDED request headers.
 */
import { describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

// Production env (isDevelopment:false ⇒ nonce-based CSP) with every
// feature ON so the /admin/renewals/tasks path is not short-circuited by
// a kill-switch 503 before the pass-through header-forward block.
vi.mock('@/lib/env', () => ({
  env: {
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
  },
}));

const { proxy } = await import('@/proxy');

function makeGet(path: string): NextRequest {
  return new NextRequest(`http://localhost:3100${path}`, {
    method: 'GET',
    headers: { origin: 'http://localhost:3100' },
  });
}

function nonceOf(csp: string | null | undefined): string | undefined {
  return csp?.match(/'nonce-([^']+)'/)?.[1];
}

describe('proxy forwards the CSP nonce onto the request (incident 2026-07-30)', () => {
  it('response CSP + forwarded request CSP carry the SAME nonce', () => {
    const res = proxy(makeGet('/admin/renewals/tasks'));
    const respNonce = nonceOf(res.headers.get('content-security-policy'));
    expect(respNonce).toBeTruthy();

    // `content-security-policy` is now among the overridden request headers…
    const overridden = res.headers.get('x-middleware-override-headers') ?? '';
    expect(overridden).toContain('content-security-policy');

    // …and the forwarded request CSP nonce === the response CSP nonce, so
    // Next stamps the SAME nonce onto every (bootstrap + streamed) script.
    const reqCsp = res.headers.get(
      'x-middleware-request-content-security-policy',
    );
    expect(nonceOf(reqCsp)).toBe(respNonce);
  });

  it('the forwarded x-nonce also matches the CSP nonce', () => {
    const res = proxy(makeGet('/admin/renewals/tasks'));
    const respNonce = nonceOf(res.headers.get('content-security-policy'));
    expect(res.headers.get('x-middleware-request-x-nonce')).toBe(respNonce);
  });

  it('OVERWRITES a client-spoofed CSP request header with the proxy value', () => {
    // A client that forges a permissive `Content-Security-Policy` request
    // header must NOT survive: the proxy does `new Headers(request.headers)`
    // then `.set()` (not `.append()`), replacing any inbound value.
    const spoofed = new NextRequest(
      'http://localhost:3100/admin/renewals/tasks',
      {
        method: 'GET',
        headers: {
          origin: 'http://localhost:3100',
          'content-security-policy': "script-src * 'unsafe-inline'",
        },
      },
    );
    const res = proxy(spoofed);
    const reqCsp = res.headers.get(
      'x-middleware-request-content-security-policy',
    );
    // The forged wildcard is gone; the forwarded CSP is the proxy's own
    // (nonce-bearing) value, matching the response CSP nonce.
    expect(reqCsp).not.toContain('script-src *');
    expect(nonceOf(reqCsp)).toBe(
      nonceOf(res.headers.get('content-security-policy')),
    );
  });
});
