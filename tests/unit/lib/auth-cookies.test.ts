/**
 * Session cookie flag contract test (security.md § 5 checklist,
 * T-05 session hijack defence).
 *
 * The contract test in `tests/contract/sign-in.test.ts` mocks
 * `setSessionCookie` wholesale so it cannot verify the flags that
 * actually land on the wire. This unit test does: it mocks only
 * `next/headers` to capture the options object passed to `store.set`
 * and asserts `httpOnly`, `sameSite`, `secure`, and `path`.
 *
 * Why this matters: a regression that flips `httpOnly` to `false`
 * would expose the session cookie to XSS, which is the whole point
 * of T-05. The `security.md § 5` reviewer checklist explicitly lists
 * "all four cookie flags are asserted in a test" as a ship gate.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

type CookieSetCall = {
  name: string;
  value: string;
  options: Record<string, unknown>;
};

const cookieSetCalls: CookieSetCall[] = [];

vi.mock('next/headers', () => ({
  cookies: async () => ({
    set: (
      name: string,
      value: string,
      options: Record<string, unknown>,
    ) => {
      cookieSetCalls.push({ name, value, options });
    },
    get: () => undefined,
  }),
}));

const {
  setSessionCookie,
  clearSessionCookie,
  SESSION_COOKIE_NAME,
} = await import('@/lib/auth-cookies');
const { asSessionId } = await import('@/modules/auth/domain/branded');

describe('auth-cookies — flag contract (T-05 session hijack defence)', () => {
  beforeEach(() => {
    cookieSetCalls.length = 0;
  });

  describe('setSessionCookie', () => {
    it('uses the swecham_session cookie name (no collision with generic "session")', async () => {
      await setSessionCookie(asSessionId('a'.repeat(64)));
      expect(cookieSetCalls).toHaveLength(1);
      expect(cookieSetCalls[0]?.name).toBe(SESSION_COOKIE_NAME);
      expect(cookieSetCalls[0]?.name).toBe('swecham_session');
    });

    it('sets HttpOnly: true — blocks document.cookie access from XSS', async () => {
      await setSessionCookie(asSessionId('b'.repeat(64)));
      expect(cookieSetCalls[0]?.options.httpOnly).toBe(true);
    });

    it('sets SameSite=Lax — blocks CSRF-delivered cross-site POSTs', async () => {
      await setSessionCookie(asSessionId('c'.repeat(64)));
      expect(cookieSetCalls[0]?.options.sameSite).toBe('lax');
    });

    it('sets Path=/ so the cookie is sent to every route', async () => {
      await setSessionCookie(asSessionId('d'.repeat(64)));
      expect(cookieSetCalls[0]?.options.path).toBe('/');
    });

    it('sets Secure based on NODE_ENV — true in production, false elsewhere', async () => {
      // The module read NODE_ENV at import time above. In vitest the
      // env is not production, so Secure should be false. The
      // production branch is exercised by the deploy-time smoke test
      // (E2E suite reaches Vercel Preview over HTTPS and inspects
      // the Set-Cookie header), which is out of scope here.
      await setSessionCookie(asSessionId('e'.repeat(64)));
      const secureValue = cookieSetCalls[0]?.options.secure;
      expect(typeof secureValue).toBe('boolean');
      // In vitest context NODE_ENV is 'test', not 'production'.
      expect(secureValue).toBe(false);
    });

    it('writes the session id as the cookie value', async () => {
      const id = 'f'.repeat(64);
      await setSessionCookie(asSessionId(id));
      expect(cookieSetCalls[0]?.value).toBe(id);
    });

    it('does NOT set Max-Age — browser drops on tab close; server-side TTL is authoritative', async () => {
      await setSessionCookie(asSessionId('a'.repeat(64)));
      expect(cookieSetCalls[0]?.options.maxAge).toBeUndefined();
    });
  });

  describe('clearSessionCookie', () => {
    it('sets Max-Age: 0 to evict the cookie from the browser jar', async () => {
      await clearSessionCookie();
      expect(cookieSetCalls).toHaveLength(1);
      expect(cookieSetCalls[0]?.options.maxAge).toBe(0);
    });

    it('clears with HttpOnly + SameSite=Lax + Path=/ (same flags as set, so the browser matches and overwrites)', async () => {
      await clearSessionCookie();
      expect(cookieSetCalls[0]?.options.httpOnly).toBe(true);
      expect(cookieSetCalls[0]?.options.sameSite).toBe('lax');
      expect(cookieSetCalls[0]?.options.path).toBe('/');
    });

    it('writes an empty string as the value', async () => {
      await clearSessionCookie();
      expect(cookieSetCalls[0]?.value).toBe('');
    });
  });
});
