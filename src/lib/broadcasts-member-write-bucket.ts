/**
 * F119 T077 / T081a — the member write bucket as the portal approval routes
 * consume it (`POST /api/broadcasts/[id]/decision`, the widened
 * `POST /api/broadcasts/[id]/cancel`): 60 requests / 60 s per (tenant, user)
 * over `broadcastsRateLimiter`, the same bucket the inline-image upload
 * (T026a) consumes. An ATOMIC check (the limiter consumes on check — never
 * peek-then-act), taken BEFORE the use case so a refused call writes nothing.
 * Refused 429 `broadcast_rate_limit_exceeded` with `Retry-After` and
 * `retryAfterSeconds` (contracts/portal-eblast-approval-api.md § Rate limits).
 */
import type { NextResponse } from 'next/server';
import { errorResponse } from '@/lib/broadcasts-route-helpers';
import {
  MEMBER_WRITE_RATE_MAX,
  MEMBER_WRITE_RATE_WINDOW_SECONDS,
  memberWriteRateKey,
} from '@/lib/broadcasts-write-rate-limit';
import { broadcastsRateLimiter } from '@/modules/broadcasts';

/** `null` ⇒ under the bucket (and one request consumed); otherwise the 429 to return. */
export async function consumeMemberWriteBucket(
  tenantSlug: string,
  userId: string,
  correlationId: string,
): Promise<NextResponse | null> {
  const limit = await broadcastsRateLimiter.checkLimit(
    memberWriteRateKey(tenantSlug, userId),
    MEMBER_WRITE_RATE_MAX,
    MEMBER_WRITE_RATE_WINDOW_SECONDS,
  );
  if (limit.ok) return null;
  return errorResponse(429, 'broadcast_rate_limit_exceeded', correlationId, {
    retryAfterSeconds: limit.error.retryAfterSeconds,
    details: { retryAfterSeconds: limit.error.retryAfterSeconds },
  });
}
