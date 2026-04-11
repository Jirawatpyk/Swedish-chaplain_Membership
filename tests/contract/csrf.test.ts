/**
 * T042 — CSRF Origin allow-list contract test (security.md T-07).
 *
 * Exercises `checkCsrf()` — the pure decision function that
 * `src/proxy.ts` delegates to for every request — across the full
 * matrix of method × path × Origin combinations documented in
 * `research.md § 4.1`. This is a *contract* test in the sense that
 * it pins the input/output shape of the decision function; the
 * end-to-end "request goes through proxy.ts and comes out with
 * 403 vs 200" behaviour is covered by
 * `tests/integration/middleware/readonly-mode.test.ts` which asserts
 * the full security-header + request-id stack.
 *
 * Scope:
 *   1. Method-safe (GET/HEAD/OPTIONS) → always pass
 *   2. State-changing on non-/api/ path → pass (unprotected path)
 *   3. Webhook + cron exempt paths → pass even without Origin
 *   4. /api/* POST with no Origin header → reject (missing-origin)
 *   5. /api/* POST with allow-listed Origin → pass (origin-allowed)
 *   6. /api/* POST with foreign Origin → reject (origin-not-allowed)
 *   7. /api/* POST with dev loopback Origin → pass in dev mode
 *
 * Env state — the env module reads `APP_ALLOWED_ORIGINS` once at
 * boot; we mock `@/lib/env` so the test does not depend on whatever
 * lives in .env.local for the current developer.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/env', () => ({
  env: {
    app: {
      allowedOrigins: ['https://swecham.example', 'https://app.swecham.example'],
    },
    isDevelopment: false,
  },
}));

const { checkCsrf } = await import('@/lib/csrf');

describe('contract: CSRF Origin allow-list (security.md T-07)', () => {
  describe('safe methods pass without an Origin check', () => {
    it.each(['GET', 'HEAD', 'OPTIONS'])(
      '%s /api/auth/sign-in with no Origin → pass (method-safe)',
      (method) => {
        const decision = checkCsrf(method, '/api/auth/sign-in', null);
        expect(decision).toEqual({ action: 'pass', reason: 'method-safe' });
      },
    );

    it('GET is case-insensitive (lowercase still pass)', () => {
      expect(checkCsrf('get', '/api/auth/sign-in', null)).toEqual({
        action: 'pass',
        reason: 'method-safe',
      });
    });
  });

  describe('state-changing methods on non-/api/ paths are unprotected', () => {
    it.each(['POST', 'PUT', 'PATCH', 'DELETE'])(
      '%s /admin/users with no Origin → pass (unprotected-path)',
      (method) => {
        const decision = checkCsrf(method, '/admin/users', null);
        expect(decision).toEqual({ action: 'pass', reason: 'unprotected-path' });
      },
    );
  });

  describe('webhook + cron exempt paths bypass the Origin check', () => {
    it('POST /api/webhooks/resend with no Origin → pass (exempt-path)', () => {
      // Server-to-server webhook callers never send an Origin header;
      // authentication is via Svix HMAC signature instead.
      expect(checkCsrf('POST', '/api/webhooks/resend', null)).toEqual({
        action: 'pass',
        reason: 'exempt-path',
      });
    });

    it('GET /api/cron/lockout-cleanup with no Origin → pass (method-safe precedes exempt-path)', () => {
      // GET is caught by the method-safe short-circuit BEFORE we
      // check the exempt-path list. That's fine — the outcome is
      // still pass — but we pin the reason string for completeness.
      expect(checkCsrf('GET', '/api/cron/lockout-cleanup', null)).toEqual({
        action: 'pass',
        reason: 'method-safe',
      });
    });

    it('POST /api/cron/lockout-cleanup with no Origin → pass (exempt-path)', () => {
      expect(checkCsrf('POST', '/api/cron/lockout-cleanup', null)).toEqual({
        action: 'pass',
        reason: 'exempt-path',
      });
    });
  });

  describe('/api/* state-changing requests enforce the allow-list', () => {
    it('POST /api/auth/sign-in with no Origin header → reject (missing-origin)', () => {
      expect(checkCsrf('POST', '/api/auth/sign-in', null)).toEqual({
        action: 'reject',
        reason: 'missing-origin',
      });
    });

    it('POST /api/auth/sign-in with empty-string Origin → reject (missing-origin)', () => {
      // An empty string is falsy and should be treated the same as
      // a missing header — no attacker-controlled bypass via "".
      expect(checkCsrf('POST', '/api/auth/sign-in', '')).toEqual({
        action: 'reject',
        reason: 'missing-origin',
      });
    });

    it('POST /api/auth/sign-in with allow-listed Origin → pass (origin-allowed)', () => {
      expect(
        checkCsrf('POST', '/api/auth/sign-in', 'https://swecham.example'),
      ).toEqual({ action: 'pass', reason: 'origin-allowed' });
    });

    it('POST /api/auth/sign-in with a second allow-listed Origin → pass', () => {
      expect(
        checkCsrf('POST', '/api/auth/sign-in', 'https://app.swecham.example'),
      ).toEqual({ action: 'pass', reason: 'origin-allowed' });
    });

    it('POST /api/auth/sign-in with a foreign Origin → reject (origin-not-allowed)', () => {
      expect(
        checkCsrf('POST', '/api/auth/sign-in', 'https://evil.example'),
      ).toEqual({ action: 'reject', reason: 'origin-not-allowed' });
    });

    it('POST /api/auth/sign-in with an allow-listed host but wrong scheme → reject', () => {
      // An Origin is the full `scheme://host[:port]` triple; a match
      // on the hostname alone MUST NOT pass.
      expect(
        checkCsrf('POST', '/api/auth/sign-in', 'http://swecham.example'),
      ).toEqual({ action: 'reject', reason: 'origin-not-allowed' });
    });

    it('POST /api/auth/sign-in with Origin: null literal → reject', () => {
      // Safari's `Origin: null` on sandboxed iframes — rejected by
      // design. See `src/lib/csrf.ts` comment on the Safari caveat.
      expect(
        checkCsrf('POST', '/api/auth/sign-in', 'null'),
      ).toEqual({ action: 'reject', reason: 'origin-not-allowed' });
    });

    it('PATCH /api/auth/users/u-1/role with allow-listed Origin → pass', () => {
      // Admin lifecycle routes also go through the allow-list.
      expect(
        checkCsrf('PATCH', '/api/auth/users/u-1/role', 'https://swecham.example'),
      ).toEqual({ action: 'pass', reason: 'origin-allowed' });
    });

    it('DELETE /api/auth/sign-out with foreign Origin → reject', () => {
      expect(
        checkCsrf('DELETE', '/api/auth/sign-out', 'https://evil.example'),
      ).toEqual({ action: 'reject', reason: 'origin-not-allowed' });
    });
  });
});

describe('contract: CSRF dev-mode loopback bypass', () => {
  // Reset module cache + re-mock env to simulate development mode.
  // This is isolated in its own describe block so the production
  // matrix above runs with a realistic prod env.
  it('dev mode accepts http://localhost:3100 even without explicit allow-list entry', async () => {
    vi.resetModules();
    vi.doMock('@/lib/env', () => ({
      env: {
        app: { allowedOrigins: ['https://swecham.example'] },
        isDevelopment: true,
      },
    }));
    const { checkCsrf: checkCsrfDev } = await import('@/lib/csrf');

    expect(
      checkCsrfDev('POST', '/api/auth/sign-in', 'http://localhost:3100'),
    ).toEqual({ action: 'pass', reason: 'origin-allowed' });

    expect(
      checkCsrfDev('POST', '/api/auth/sign-in', 'http://127.0.0.1:3000'),
    ).toEqual({ action: 'pass', reason: 'origin-allowed' });

    // A non-loopback origin is still rejected even in dev.
    expect(
      checkCsrfDev('POST', '/api/auth/sign-in', 'https://evil.example'),
    ).toEqual({ action: 'reject', reason: 'origin-not-allowed' });

    vi.doUnmock('@/lib/env');
  });
});
