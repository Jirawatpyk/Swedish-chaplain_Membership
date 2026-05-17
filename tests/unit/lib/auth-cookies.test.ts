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
const { asSessionToken } = await import('@/modules/auth/domain/branded');

describe('auth-cookies — flag contract (T-05 session hijack defence)', () => {
  beforeEach(() => {
    cookieSetCalls.length = 0;
  });

  describe('setSessionCookie', () => {
    it('uses the swecham_session cookie name (no collision with generic "session")', async () => {
      await setSessionCookie(asSessionToken('a'.repeat(64)));
      expect(cookieSetCalls).toHaveLength(1);
      expect(cookieSetCalls[0]?.name).toBe(SESSION_COOKIE_NAME);
      expect(cookieSetCalls[0]?.name).toBe('swecham_session');
    });

    it('sets HttpOnly: true — blocks document.cookie access from XSS', async () => {
      await setSessionCookie(asSessionToken('b'.repeat(64)));
      expect(cookieSetCalls[0]?.options.httpOnly).toBe(true);
    });

    it('sets SameSite=Lax — blocks CSRF-delivered cross-site POSTs', async () => {
      await setSessionCookie(asSessionToken('c'.repeat(64)));
      expect(cookieSetCalls[0]?.options.sameSite).toBe('lax');
    });

    it('sets Path=/ so the cookie is sent to every route', async () => {
      await setSessionCookie(asSessionToken('d'.repeat(64)));
      expect(cookieSetCalls[0]?.options.path).toBe('/');
    });

    it('sets Secure based on NODE_ENV — true in production, false elsewhere', async () => {
      // The module reads NODE_ENV at import time. In vitest the env
      // is 'test', so Secure should be false. The production branch
      // (Secure=true over HTTPS) is not exercised by this suite and
      // is a documented test gap — tracked informally as a future
      // Playwright test against a Vercel Preview deployment that
      // inspects the real Set-Cookie header. Until that exists the
      // production behaviour is verified only via code review of
      // `src/lib/auth-cookies.ts`.
      await setSessionCookie(asSessionToken('e'.repeat(64)));
      const secureValue = cookieSetCalls[0]?.options.secure;
      expect(typeof secureValue).toBe('boolean');
      expect(secureValue).toBe(false);
    });

    it('writes the session id as the cookie value', async () => {
      const id = 'f'.repeat(64);
      await setSessionCookie(asSessionToken(id));
      expect(cookieSetCalls[0]?.value).toBe(id);
    });

    it('does NOT set Max-Age — browser drops on tab close; server-side TTL is authoritative', async () => {
      await setSessionCookie(asSessionToken('a'.repeat(64)));
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
