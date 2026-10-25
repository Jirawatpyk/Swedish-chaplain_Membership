/**
 * Upstash Redis sliding-window rate limiter (T037, research.md § 5).
 *
 * Algorithm: sliding window keyed per logical bucket
 * (e.g. `signin:email:foo@bar`, `signin:ip:1.2.3.4`).
 *
 * **Fail-open + in-memory fallback** (research.md § 5):
 *   If Upstash is unreachable (network error, 5xx), the limiter falls
 *   back to a process-local in-memory map for the duration of the
 *   incident. This trades a small abuse risk during the incident for
 *   continued service availability — Constitution VIII (Reliability)
 *   prefers a degraded experience to a total outage.
 *
 *   The fallback is RAM-only (not persisted across processes/regions),
 *   so a determined attacker could circumvent it by spreading load
 *   across functions. We accept that risk during outages because the
 *   downstream lockout counter on `users` (data-model.md § 2.3) still
 *   protects individual accounts.
 *
 * `auth_redis_fallback_total` metric (T180) is incremented on each
 * fallback so operators see the degradation in dashboards.
 */
import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { errKind } from '@/lib/log-id';
import { authMetrics } from '@/lib/metrics';
import { createFallbackBuckets } from './fallback-buckets';
import { rateLimitPrefix } from './rate-limit-prefix';

// --- Public interface ---------------------------------------------------------

export interface RateLimitResult {
  /** True if the request is allowed; false if rate-limited. */
  readonly success: boolean;
  /** Remaining requests in the current window. */
  readonly remaining: number;
  /** When the bucket resets (unix-ms). */
  readonly reset: number;
  /**
   * True when the result came from the in-memory fallback bucket
   * (Upstash unreachable). Always set — happy path emits `false`,
   * fallback path emits `true`. Callers emit surface-specific fail-open
   * metrics when this is `true`.
   */
  readonly fellBack: boolean;
}

// S1-P1-13: `retryAfterSeconds` moved to `application/rate-limit-retry.ts` so
// the six auth use-cases no longer import an Infrastructure VALUE (Principle III).

export interface RateLimiter {
  /**
   * Consume one token from the bucket identified by `key`.
   * `max` and `windowSeconds` parameterise the sliding window.
   */
  check(
    key: string,
    max: number,
    windowSeconds: number,
  ): Promise<RateLimitResult>;
  // 125 — no non-consuming `peek`: a security gate must debit atomically
  // (auth-rbac rule); the only caller (change-password) now uses check().
}

// --- Upstash-backed implementation -------------------------------------------

// Per-run in CI (RATE_LIMIT_KEY_PREFIX), `swecham` everywhere else.
const RATE_LIMIT_PREFIX = rateLimitPrefix(process.env.RATE_LIMIT_KEY_PREFIX);

const redis = new Redis({
  url: env.upstash.url,
  token: env.upstash.token,
});

// Cache one Ratelimit instance per (max, window) tuple. The Upstash
// Ratelimit constructor takes the algorithm + window parameters once;
// reusing instances avoids the per-call cost of constructing a new
// sliding-window driver.
const rateLimitCache = new Map<string, Ratelimit>();
const UPSTASH_TIMEOUT_MS = 1000;

function getRateLimit(max: number, windowSeconds: number): Ratelimit {
  const cacheKey = `${max}:${windowSeconds}`;
  let limit = rateLimitCache.get(cacheKey);
  if (!limit) {
    limit = new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(max, `${windowSeconds} s`),
      analytics: false,
      prefix: RATE_LIMIT_PREFIX,
      // 128 — the library default is 5 s; a sign-in should not stall that
      // long before the in-memory fallback decides. Upstash SG answers in
      // tens of ms, so 1 s only trips on a real slowdown.
      timeout: UPSTASH_TIMEOUT_MS,
    });
    rateLimitCache.set(cacheKey, limit);
  }
  return limit;
}

// --- In-memory fallback -------------------------------------------------------

const fallback = createFallbackBuckets();

// --- Public adapter -----------------------------------------------------------

class UpstashRateLimiter implements RateLimiter {
  async check(
    key: string,
    max: number,
    windowSeconds: number,
  ): Promise<RateLimitResult> {
    try {
      const result = await getRateLimit(max, windowSeconds).limit(key);
      // 128 — `@upstash/ratelimit` races `.limit()` against a 5 s timeout
      // and RESOLVES `{ success: true, reason: 'timeout' }` when it wins, so
      // a slow (not down) Upstash would otherwise allow every request. Treat
      // it exactly like an unreachable Upstash: the in-memory bucket decides.
      if (result.reason === 'timeout') {
        throw new UpstashTimeoutError();
      }
      return {
        success: result.success,
        remaining: result.remaining,
        reset: result.reset,
        fellBack: false,
      };
    } catch (error) {
      // A2 — log the bucket KIND only, never the full key. Call-site
      // keys embed secrets in the value (`signin:email:<email>`,
      // `heartbeat:session:<sessionId>`, `change-pw:user:<userId>`)
      // and pino's path-based redaction cannot scrub them — the
      // sensitive content is inside the string value of a non-redacted
      // field name. Replace with a discriminator that captures the
      // bucket kind for diagnostics without leaking the per-user secret.
      // CLAUDE.md § Secrets & confidential data forbids raw session
      // IDs / emails / user IDs in logs.
      const keyKind = key.split(':').slice(0, 2).join(':') || 'unknown';
      const timeout = error instanceof UpstashTimeoutError;
      logger.warn(
        { err: errKind(error), keyKind, max, windowSeconds, fallback: true, timeout },
        timeout
          ? 'rate-limit upstream timed out, falling back to in-memory bucket'
          : 'rate-limit upstream unreachable, falling back to in-memory bucket',
      );
      authMetrics.redisFallback();
      return fallback.check(key, max, windowSeconds);
    }
  }
}

/** 128 — the library's timeout branch, routed into the fallback below. */
class UpstashTimeoutError extends Error {
  constructor() {
    super('upstash ratelimit timed out');
    this.name = 'UpstashTimeoutError';
  }
}

export const rateLimiter: RateLimiter = new UpstashRateLimiter();
