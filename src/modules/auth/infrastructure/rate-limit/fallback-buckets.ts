/**
 * In-memory fixed-window buckets used while Upstash is unreachable or slow
 * (research.md § 5). Process-local by design — see upstash-rate-limiter.ts.
 *
 * 128 — expired buckets are swept at most once a minute, so a spray of
 * distinct keys during a long Upstash slowdown cannot grow the heap for the
 * instance's whole lifetime.
 */
import type { RateLimitResult } from './upstash-rate-limiter';

const SWEEP_INTERVAL_MS = 60_000;

interface Bucket {
  count: number;
  windowStart: number;
  windowMs: number;
}

export interface FallbackBuckets {
  check(key: string, max: number, windowSeconds: number, now?: number): RateLimitResult;
  /** Live bucket count — for tests and diagnostics. */
  size(): number;
}

export function createFallbackBuckets(): FallbackBuckets {
  const buckets = new Map<string, Bucket>();
  let lastSweep = 0;

  function sweep(now: number): void {
    if (now - lastSweep < SWEEP_INTERVAL_MS) return;
    lastSweep = now;
    for (const [key, b] of buckets) {
      if (now - b.windowStart >= b.windowMs) buckets.delete(key);
    }
  }

  return {
    check(key, max, windowSeconds, now = Date.now()) {
      sweep(now);
      const windowMs = windowSeconds * 1000;
      const bucket = buckets.get(key);

      if (!bucket || now - bucket.windowStart >= windowMs) {
        buckets.set(key, { count: 1, windowStart: now, windowMs });
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
    },
    size: () => buckets.size,
  };
}
