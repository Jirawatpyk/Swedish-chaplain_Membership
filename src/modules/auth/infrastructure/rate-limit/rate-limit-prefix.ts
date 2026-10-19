/**
 * The Upstash rate-limit key prefix.
 *
 * `RATE_LIMIT_KEY_PREFIX` lets CI give every run its own buckets: concurrent
 * runs share one CI Upstash store and the same e2e persona emails, so a fixed
 * prefix let one run's lockout or bucket wipe leak into another. Unset (every
 * real deployment), it stays `swecham`, so production keys do not move.
 *
 * Read straight from `process.env` like env-tenant-display-name.ts: it is an
 * optional CI knob, not app config. Kept free of `@/lib/env` so the e2e
 * bucket-clearing helper can import it too.
 */
const DEFAULT_PREFIX = 'swecham';
const VALID = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function rateLimitPrefix(raw: string | undefined): string {
  if (raw === undefined || raw === '') return DEFAULT_PREFIX;
  if (!VALID.test(raw)) {
    // A `*` or `:` would widen the clear-pattern or split a key; refuse it.
    throw new Error('RATE_LIMIT_KEY_PREFIX must be 1-64 of [a-z0-9-], starting with a letter or digit.');
  }
  return raw;
}

/** The SCAN pattern for this prefix's keys only (`<prefix>:<identifier>…`). */
export function rateLimitKeyPattern(prefix: string): string {
  return `${prefix}:*`;
}
