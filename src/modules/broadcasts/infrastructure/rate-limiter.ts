/**
 * F7 `RateLimiterPort` adapter — wraps the existing F1 Upstash
 * rate-limiter singleton (`src/modules/auth/infrastructure/rate-limit/
 * upstash-rate-limiter.ts`) and translates the result into F7's
 * `Result<true, RateLimitError>` shape.
 */
import { err, ok, type Result } from '@/lib/result';
import { rateLimiter as upstashRateLimiter } from '@/modules/auth/infrastructure/rate-limit/upstash-rate-limiter';
import type {
  RateLimitError,
  RateLimiterPort,
} from '../application/ports/rate-limiter-port';

export const broadcastsRateLimiter: RateLimiterPort = {
  async checkLimit(
    key: string,
    limit: number,
    windowSeconds: number,
  ): Promise<Result<true, RateLimitError>> {
    const result = await upstashRateLimiter.check(key, limit, windowSeconds);
    if (result.success) {
      return ok(true);
    }
    const retryAfterSeconds = Math.max(
      1,
      Math.ceil((result.reset - Date.now()) / 1000),
    );
    return err({
      kind: 'rate_limit_exceeded',
      retryAfterSeconds,
      key,
    });
  },
};
