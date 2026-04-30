/**
 * T028 — `RateLimiterPort` Application port (F7).
 *
 * Upstash Redis rate-limit binding. F7 token buckets:
 *   - `POST /api/broadcasts/submit` — 10/24h per (tenant, member) (FR-002d)
 *   - `POST /api/broadcasts/draft` — 60/5min per (tenant, user)
 *   - `POST /api/admin/broadcasts/[id]/{approve,reject,cancel}` — 30/5min
 *   - `POST /api/webhooks/resend-broadcasts` — 600/min per source IP
 *   - `GET /unsubscribe/[token]` — 20/5min per source IP
 *
 * Concrete adapter wraps `@upstash/ratelimit` (already in deps from F1).
 *
 * Pure interface — no framework imports (Constitution Principle III).
 */
import type { Result } from '@/lib/result';

export type RateLimitError = {
  readonly kind: 'rate_limit_exceeded';
  readonly retryAfterSeconds: number;
  readonly key: string;
};

export interface RateLimiterPort {
  /**
   * Atomic check-and-increment. Returns `ok(true)` when the request
   * fits within the window; returns `err({...})` with retry-after
   * hint when the limit is exceeded.
   *
   * @param key Composite key (e.g., `broadcasts:submit:tenant_id:member_id`)
   * @param limit Number of allowed requests in the window
   * @param windowSeconds Sliding-window size in seconds
   */
  checkLimit(
    key: string,
    limit: number,
    windowSeconds: number,
  ): Promise<Result<true, RateLimitError>>;
}
