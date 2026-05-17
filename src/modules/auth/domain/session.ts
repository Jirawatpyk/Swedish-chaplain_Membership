/**
 * Session entity + TTL logic (data-model.md § 2.4, spec FR-008 / Q3).
 *
 * Two timeouts apply concurrently:
 *
 *   - Idle timeout: 30 minutes since `lastSeenAt`
 *   - Absolute lifetime: 12 hours since `createdAt`
 *
 * The earlier of the two ends the session. `getCurrentSession()` in
 * `src/lib/auth-session.ts` reads the session row, calls
 * `isSessionValid`, and either renews `lastSeenAt` (if still valid)
 * or destroys the session. `proxy.ts` (the Next.js 16 request proxy)
 * is stateless and does NOT touch the DB — Edge runtime can't run
 * `postgres-js` — so the validation work lives in the Node-runtime
 * page/layout path instead.
 *
 * Pure types — Domain layer; no framework imports.
 */

import type { SessionToken, UserId } from './branded';

export interface Session {
  readonly id: SessionToken;
  readonly userId: UserId;
  readonly createdAt: Date;
  readonly lastSeenAt: Date;
  readonly expiresAt: Date; // = createdAt + ABSOLUTE_LIFETIME_MS
  readonly sourceIp: string;
}

/** Idle timeout — 30 minutes (Q3). */
export const IDLE_TIMEOUT_MS = 30 * 60 * 1000;

/** Absolute session lifetime — 12 hours (Q3). */
export const ABSOLUTE_LIFETIME_MS = 12 * 60 * 60 * 1000;

/**
 * Decide whether a session is still valid at `now`. Called by
 * `getCurrentSession()` before serving any protected request.
 */
export function isSessionValid(session: Session, now: Date): boolean {
  // Absolute cap: createdAt + 12 h
  if (session.expiresAt.getTime() <= now.getTime()) return false;
  // Idle cap: lastSeenAt + 30 min
  if (now.getTime() - session.lastSeenAt.getTime() > IDLE_TIMEOUT_MS) return false;
  return true;
}

/**
 * Compute the timestamp at which the session would expire if no further
 * activity happens. Returns the earlier of (idle expiry, absolute expiry).
 * Used by the idle warning dialog (T163) to display a countdown.
 */
export function nextExpiryAt(session: Session): Date {
  const idleExpiry = new Date(session.lastSeenAt.getTime() + IDLE_TIMEOUT_MS);
  return idleExpiry.getTime() < session.expiresAt.getTime()
    ? idleExpiry
    : session.expiresAt;
}
