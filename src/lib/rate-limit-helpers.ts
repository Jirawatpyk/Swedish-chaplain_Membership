/**
 * Generic rate-limit response helpers, shared across F4/F5/F6 routes.
 */
import { NextResponse } from 'next/server';

/**
 * Convert an Upstash rate-limit `reset` timestamp (epoch-ms) into the
 * `Retry-After` seconds value. Floor of 1s avoids `Retry-After: 0`
 * which clients interpret as "retry immediately" — the limiter window
 * has already elapsed so the next attempt would race with cleanup.
 */
export function retryAfterSecondsFromRl(rl: { readonly reset: number }): number {
  return Math.max(1, Math.ceil((rl.reset - Date.now()) / 1000));
}

/**
 * Standard 429 for the F4 "classic" rate-limit shape (code-review #13):
 * `{ error: { code: 'rate_limited', retryAfterMs } }` + a `Retry-After`
 * header. Replaces the inline block duplicated across the 9 F4 invoice /
 * credit-note / receipt-resend / tenant-invoice-settings routes (8 of which
 * hand-rolled `Math.ceil(...)` for the header instead of the floor-1s
 * `retryAfterSecondsFromRl`, so this also standardises the never-`Retry-After: 0`
 * guarantee). The body is byte-identical to the prior inline shape.
 *
 * Scope: F4 Group-A ONLY. Payments/auth/audit/GDPR routes use deliberately
 * different shapes (audit-before-429 ordering, string error code, lowercase
 * header, correlationId-in-body) and are intentionally NOT unified here.
 * Per-site `logger.warn` / audit emits stay at the call site.
 */
export function rateLimitedJson(rl: { readonly reset: number }): NextResponse {
  return NextResponse.json(
    { error: { code: 'rate_limited', retryAfterMs: rl.reset - Date.now() } },
    { status: 429, headers: { 'Retry-After': String(retryAfterSecondsFromRl(rl)) } },
  );
}
