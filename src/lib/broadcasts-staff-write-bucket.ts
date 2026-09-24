/**
 * F119 T062a — the staff write bucket as the approval-round routes consume
 * it (`…/[id]/version` POST + PATCH, `…/[id]/version/send`, `…/[id]/schedule`,
 * and the widened `…/[id]/reject` of T081 — the one unflagged consumer):
 * 30 requests / 60 s per (tenant, actor) over `broadcastsRateLimiter`, an
 * ATOMIC check (the limiter consumes on check — never peek-then-act), taken
 * BEFORE the use case so a refused call writes nothing. Refused 429
 * `broadcast_rate_limit_exceeded` with `Retry-After` and `retryAfterSeconds`
 * (contracts/admin-eblast-formatting-api.md § Rate limits).
 */
import type { NextResponse } from 'next/server';
import { errorResponse } from '@/lib/broadcasts-route-helpers';
import {
  STAFF_WRITE_RATE_MAX,
  STAFF_WRITE_RATE_WINDOW_SECONDS,
  staffWriteRateKey,
} from '@/lib/broadcasts-write-rate-limit';
import { broadcastsRateLimiter } from '@/modules/broadcasts';

/** `null` ⇒ under the bucket (and one request consumed); otherwise the 429 to return. */
export async function consumeStaffWriteBucket(
  tenantSlug: string,
  userId: string,
  correlationId: string,
): Promise<NextResponse | null> {
  const limit = await broadcastsRateLimiter.checkLimit(
    staffWriteRateKey(tenantSlug, userId),
    STAFF_WRITE_RATE_MAX,
    STAFF_WRITE_RATE_WINDOW_SECONDS,
  );
  if (limit.ok) return null;
  return errorResponse(429, 'broadcast_rate_limit_exceeded', correlationId, {
    retryAfterSeconds: limit.error.retryAfterSeconds,
    details: { retryAfterSeconds: limit.error.retryAfterSeconds },
  });
}
