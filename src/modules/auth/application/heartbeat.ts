/**
 * Heartbeat use case (spec FR-022, ux-standards § 8.2).
 *
 * Refreshes `sessions.last_seen_at` without any other side effect —
 * fuels the "Stay signed in" button on the idle-warning dialog.
 * Does NOT extend the absolute 12-hour cap (that lives on the
 * session row and is enforced by `isSessionValid`).
 *
 * Moved from the route handler (verify gate 2026-04-10) so the
 * Presentation layer no longer reaches into `sessionRepo` or
 * `rateLimiter` directly — Clean Architecture Principle III:
 * Presentation → Application → Infrastructure, never skip the
 * middle layer. The route handler now only does HTTP
 * (request parsing, status codes) and delegates the entire
 * side-effect story to this use case.
 *
 * Audit: **none**. Heartbeats are routine (one per idle cycle per
 * active tab) and would flood the append-only log. Spec § US7
 * explicitly exempts idle/absolute timeout expirations from the
 * audit trail, and routine heartbeats share that rationale.
 *
 * Rate limit: 60 per minute per session id. Keyed on the session —
 * not the user — so that a user with multiple tabs gets a per-tab
 * budget and a misbehaving tab cannot starve a well-behaved one.
 */
import { Result, err, ok } from '@/lib/result';
import type { SessionToken } from '@/modules/auth/domain/branded';
// Type-only — see sign-in.ts for the Clean Architecture rationale.
import type { SessionRepo } from '@/modules/auth/infrastructure/db/session-repo';
import type { RateLimiter } from '@/modules/auth/infrastructure/rate-limit/upstash-rate-limiter';
import { retryAfterSeconds } from '@/modules/auth/application/rate-limit-retry';
import { defaultHeartbeatDeps } from '@/lib/auth-deps';
import { sha256Hex } from '@/lib/crypto';

// --- Public types -------------------------------------------------------------

export interface HeartbeatInput {
  readonly sessionId: SessionToken;
  readonly requestId: string;
}

export interface HeartbeatSuccess {
  readonly lastSeenAt: Date;
}

export type HeartbeatError = {
  readonly code: 'rate-limited';
  readonly retryAfterSeconds: number;
};

// --- Tunables ----------------------------------------------------------------

const RATE_LIMIT = { max: 60, windowSeconds: 60 } as const;

// --- Dependencies ------------------------------------------------------------

export interface HeartbeatDeps {
  readonly sessions: SessionRepo;
  readonly limiter: RateLimiter;
  readonly now: () => Date;
}

export { defaultHeartbeatDeps };

// --- Use case ----------------------------------------------------------------

export async function heartbeat(
  input: HeartbeatInput,
  deps: HeartbeatDeps = defaultHeartbeatDeps,
): Promise<Result<HeartbeatSuccess, HeartbeatError>> {
  // Round 2 (post-ship review § C1, 2026-05-17) — hash the session id before composing
  // the rate-limit key. Pre-fix the plaintext bearer credential was
  // stored verbatim inside Upstash Redis as part of the bucket key,
  // shifting (not closing) the E3 hash-at-rest blast radius from
  // Postgres to Upstash. Hashing here matches the E3 contract: the
  // plaintext lives only in the user's browser cookie.
  const rl = await deps.limiter.check(
    `heartbeat:session:${sha256Hex(input.sessionId)}`,
    RATE_LIMIT.max,
    RATE_LIMIT.windowSeconds,
  );
  if (!rl.success) {
    return err({
      code: 'rate-limited',
      retryAfterSeconds: retryAfterSeconds(rl),
    });
  }

  const now = deps.now();
  await deps.sessions.updateLastSeen(input.sessionId, now);
  return ok({ lastSeenAt: now });
}
