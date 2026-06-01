/**
 * Application-layer `retryAfterSeconds` helper — go-live audit S1-P1-13.
 *
 * Derives the `Retry-After` value (seconds, floored at 1) from one or more
 * rate-limit results. Used by six auth use-cases. It previously lived in the
 * Infrastructure rate-limiter (`upstash-rate-limiter.ts`), so the use-cases
 * imported an Infrastructure VALUE — a Principle III violation. Moved here.
 *
 * Decoupled from the full `RateLimitResult` shape — it only needs `reset` (the
 * bucket-reset unix-ms), so it accepts the minimal `{ reset: number }`.
 *
 * Pure TypeScript — no framework/ORM imports.
 */
export function retryAfterSeconds(
  ...results: ReadonlyArray<{ readonly reset: number }>
): number {
  const now = Date.now();
  return Math.max(...results.map((r) => Math.ceil((r.reset - now) / 1000)), 1);
}
