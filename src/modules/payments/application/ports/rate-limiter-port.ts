/**
 * T054 — RateLimiterPort (F5 Application).
 *
 * Abstracts the Upstash Redis rate-limit check used by both payment-
 * initiate (10/5min) + payment-cancel (20/5min) + refund-initiate
 * (20/5min) per payments-api.md. Adapter in Infrastructure wraps
 * `@upstash/ratelimit`.
 */
export interface RateLimiterPort {
  check(key: string): Promise<{ readonly success: boolean; readonly reset: number }>;
}
