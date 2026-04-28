/**
 * Generic rate-limit response helpers, shared across F4/F5/F6 routes.
 */

/**
 * Convert an Upstash rate-limit `reset` timestamp (epoch-ms) into the
 * `Retry-After` seconds value. Floor of 1s avoids `Retry-After: 0`
 * which clients interpret as "retry immediately" — the limiter window
 * has already elapsed so the next attempt would race with cleanup.
 */
export function retryAfterSecondsFromRl(rl: { readonly reset: number }): number {
  return Math.max(1, Math.ceil((rl.reset - Date.now()) / 1000));
}
