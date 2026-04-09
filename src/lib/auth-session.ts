/**
 * Server-side session helper used by page server components.
 *
 * Reads the cookie via `getSessionIdFromCookie()`, looks up the row in
 * Postgres via `sessionRepo`, validates idle + absolute TTLs against
 * the Domain `isSessionValid`, and either renews `last_seen_at` or
 * destroys the session.
 *
 * Layouts call this in their server component to gate routes:
 *
 *   const session = await getCurrentSession();
 *   if (!session) redirect('/admin/sign-in');
 *
 * Why not in middleware: Edge runtime cannot import `postgres-js`.
 * Doing the lookup in the page server component keeps the Node-only
 * code in the Node runtime.
 */
import { redirect } from 'next/navigation';
import { isSessionValid } from '@/modules/auth/domain/session';
import type { Session } from '@/modules/auth/domain/session';
import type { UserAccount } from '@/modules/auth/domain/user';
import { sessionRepo } from '@/modules/auth/infrastructure/db/session-repo';
import { userRepo } from '@/modules/auth/infrastructure/db/user-repo';
import { clearSessionCookie, getSessionIdFromCookie } from './auth-cookies';

export interface CurrentSession {
  readonly session: Session;
  readonly user: UserAccount;
}

/**
 * Returns the current session + user, or `null` if there is no valid
 * session. Updates `last_seen_at` as a side effect when the session is
 * still within the idle window.
 *
 * NEVER throws across the call boundary — caller decides what to do
 * with `null`.
 */
export async function getCurrentSession(): Promise<CurrentSession | null> {
  const sessionId = await getSessionIdFromCookie();
  if (!sessionId) return null;

  const session = await sessionRepo.findById(sessionId);
  if (!session) {
    await clearSessionCookie();
    return null;
  }

  const now = new Date();
  if (!isSessionValid(session, now)) {
    await sessionRepo.delete(sessionId);
    await clearSessionCookie();
    return null;
  }

  const user = await userRepo.findById(session.userId);
  if (!user || user.status !== 'active') {
    await sessionRepo.delete(sessionId);
    await clearSessionCookie();
    return null;
  }

  // Sliding-window heartbeat — update last_seen_at on every protected
  // request so a continuously-active user never hits the idle expiry.
  await sessionRepo.updateLastSeen(sessionId, now);

  return { session, user };
}

/**
 * Convenience wrapper for layouts: gets the current session OR
 * redirects to the appropriate sign-in page (staff vs member).
 */
export async function requireSession(portal: 'staff' | 'member'): Promise<CurrentSession> {
  const current = await getCurrentSession();
  if (!current) {
    redirect(portal === 'staff' ? '/admin/sign-in' : '/portal/sign-in');
  }
  return current;
}
