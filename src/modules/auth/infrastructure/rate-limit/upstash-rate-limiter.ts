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
import { authMetrics } from '@/lib/metrics';

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
  /**
   * Non-consuming check (B2 — change-password peek-then-consume).
   * Returns the bucket's current state WITHOUT decrementing it.
   * Use case: gate an expensive operation (e.g. argon2 verify) on
   * "is there budget left?" and only consume after the expensive
   * operation confirmed a failure that should count against the
   * bucket. The success path leaves the bucket untouched, so 5
   * successful operations in a row do NOT trip the 429.
   *
   * Falls back to the same in-memory bucket inspection as `check`
   * during Upstash outages — but does NOT advance the bucket state.
   */
  peek(
    key: string,
    max: number,
    windowSeconds: number,
  ): Promise<RateLimitResult>;
}

// --- Upstash-backed implementation -------------------------------------------

const redis = new Redis({
  url: env.upstash.url,
  token: env.upstash.token,
});

// Cache one Ratelimit instance per (max, window) tuple. The Upstash
// Ratelimit constructor takes the algorithm + window parameters once;
// reusing instances avoids the per-call cost of constructing a new
// sliding-window driver.
const rateLimitCache = new Map<string, Ratelimit>();

function getRateLimit(max: number, windowSeconds: number): Ratelimit {
  const cacheKey = `${max}:${windowSeconds}`;
  let limit = rateLimitCache.get(cacheKey);
  if (!limit) {
    limit = new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(max, `${windowSeconds} s`),
      analytics: false,
      prefix: 'swecham',
    });
    rateLimitCache.set(cacheKey, limit);
  }
  return limit;
}

// --- In-memory fallback -------------------------------------------------------

interface FallbackBucket {
  count: number;
  windowStart: number;
}
const fallbackBuckets = new Map<string, FallbackBucket>();

function fallbackCheck(
  key: string,
  max: number,
  windowSeconds: number,
): RateLimitResult {
  const now = Date.now();
  const windowMs = windowSeconds * 1000;
  const bucket = fallbackBuckets.get(key);

  if (!bucket || now - bucket.windowStart >= windowMs) {
    fallbackBuckets.set(key, { count: 1, windowStart: now });
    return { success: true, remaining: max - 1, reset: now + windowMs, fellBack: true };
  }

  if (bucket.count >= max) {
    return {
      success: false,
      remaining: 0,
      reset: bucket.windowStart + windowMs,
      fellBack: true,
    };
  }

  bucket.count += 1;
  return {
    success: true,
    remaining: max - bucket.count,
    reset: bucket.windowStart + windowMs,
    fellBack: true,
  };
}

/** Non-consuming peek for the in-memory fallback bucket (B2). */
function fallbackPeek(
  key: string,
  max: number,
  windowSeconds: number,
): RateLimitResult {
  const now = Date.now();
  const windowMs = windowSeconds * 1000;
  const bucket = fallbackBuckets.get(key);

  if (!bucket || now - bucket.windowStart >= windowMs) {
    return {
      success: true,
      remaining: max,
      reset: now + windowMs,
      fellBack: true,
    };
  }

  return {
    success: bucket.count < max,
    remaining: Math.max(max - bucket.count, 0),
    reset: bucket.windowStart + windowMs,
    fellBack: true,
  };
}

// --- Public adapter -----------------------------------------------------------

class UpstashRateLimiter implements RateLimiter {
  async peek(
    key: string,
    max: number,
    windowSeconds: number,
  ): Promise<RateLimitResult> {
    try {
      const remaining = await getRateLimit(max, windowSeconds).getRemaining(
        key,
      );
      const reset =
        typeof remaining === 'object' && 'reset' in remaining
          ? (remaining as { reset: number }).reset
          : Date.now() + windowSeconds * 1000;
      const remainingCount =
        typeof remaining === 'object' && 'remaining' in remaining
          ? (remaining as { remaining: number }).remaining
          : (remaining as unknown as number);
      return {
        success: remainingCount > 0,
        remaining: remainingCount,
        reset,
        fellBack: false,
      };
    } catch (error) {
      const keyKind = key.split(':').slice(0, 2).join(':') || 'unknown';
      logger.warn(
        { err: error, keyKind, max, windowSeconds, fallback: true },
        'rate-limit peek upstream unreachable, falling back to in-memory bucket',
      );
      authMetrics.redisFallback();
      return fallbackPeek(key, max, windowSeconds);
    }
  }

  async check(
    key: string,
    max: number,
    windowSeconds: number,
  ): Promise<RateLimitResult> {
    try {
      const result = await getRateLimit(max, windowSeconds).limit(key);
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
      logger.warn(
        { err: error, keyKind, max, windowSeconds, fallback: true },
        'rate-limit upstream unreachable, falling back to in-memory bucket',
      );
      authMetrics.redisFallback();
      return fallbackCheck(key, max, windowSeconds);
    }
  }
}

export const rateLimiter: RateLimiter = new UpstashRateLimiter();
