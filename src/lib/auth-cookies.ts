/**
 * Session cookie helper (Lucia v3 pattern, research.md § 4).
 *
 * Cookie name `swecham_session` (avoids the generic `session` namespace
 * collision risk in dev). Properties:
 *   - HttpOnly
 *   - Secure (HTTPS only — Vercel enforces; localhost is exempt by browser)
 *   - SameSite=Lax
 *   - Path=/
 *   - No Max-Age → browser drops on tab close; server-side TTL is the
 *     authoritative limit (30 min idle / 12 h absolute)
 *
 * Used by /api/auth/sign-in (T070), /api/auth/sign-out (T071), and any
 * server component that needs the current session id (`getSessionId()`).
 */
import { cookies } from 'next/headers';
import type { SessionId } from '@/modules/auth/domain/branded';
import { asSessionId } from '@/modules/auth/domain/branded';

export const SESSION_COOKIE_NAME = 'swecham_session';

const COOKIE_OPTIONS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax' as const,
  path: '/',
};

/**
 * Set the session cookie. Call from a Route Handler or Server Action.
 */
export async function setSessionCookie(sessionId: SessionId): Promise<void> {
  const store = await cookies();
  store.set(SESSION_COOKIE_NAME, sessionId, COOKIE_OPTIONS);
}

/**
 * Clear the session cookie. Idempotent.
 */
export async function clearSessionCookie(): Promise<void> {
  const store = await cookies();
  store.set(SESSION_COOKIE_NAME, '', { ...COOKIE_OPTIONS, maxAge: 0 });
}

/**
 * Read the session id from the cookie store. Returns null if absent
 * or empty.
 */
export async function getSessionIdFromCookie(): Promise<SessionId | null> {
  const store = await cookies();
  const value = store.get(SESSION_COOKIE_NAME)?.value;
  if (!value) return null;
  return asSessionId(value);
}
