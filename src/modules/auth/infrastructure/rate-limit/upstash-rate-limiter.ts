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
}

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
    return { success: true, remaining: max - 1, reset: now + windowMs };
  }

  if (bucket.count >= max) {
    return {
      success: false,
      remaining: 0,
      reset: bucket.windowStart + windowMs,
    };
  }

  bucket.count += 1;
  return {
    success: true,
    remaining: max - bucket.count,
    reset: bucket.windowStart + windowMs,
  };
}

// --- Public adapter -----------------------------------------------------------

class UpstashRateLimiter implements RateLimiter {
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
      };
    } catch (error) {
      logger.warn(
        { err: error, key, max, windowSeconds, fallback: true },
        'rate-limit upstream unreachable, falling back to in-memory bucket',
      );
      authMetrics.redisFallback();
      return fallbackCheck(key, max, windowSeconds);
    }
  }
}

export const rateLimiter: RateLimiter = new UpstashRateLimiter();
