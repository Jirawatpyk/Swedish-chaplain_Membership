/**
 * Application port — Rate limiting for bulk actions (US4 FR-019b).
 *
 * Thin port over the Upstash rate limiter so bulk-action use case
 * depends on an interface, not an infrastructure singleton. Tests
 * inject a stub; production wires the F1 UpstashRateLimiter.
 */
export interface RateLimitResult {
  readonly success: boolean;
  readonly remaining: number;
  readonly reset: number;
}

export interface RateLimitPort {
  check(
    key: string,
    max: number,
    windowSeconds: number,
  ): Promise<RateLimitResult>;
}
