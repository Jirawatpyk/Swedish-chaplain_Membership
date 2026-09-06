/**
 * 108 PR-C T088 — `GET /api/broadcasts/recipient-count` (member compose).
 *
 * Query: `segment=all_members|tier|event_attendees_last_90d`, `tier=<code>[,<code>]`.
 * 200 `{ count, ceiling, exceeds, orphans, droppedByPreference }` — numbers
 * only (FR-040a). Order of checks is the contract: member gate → query
 * (400 `invalid_query`) → 30/min (tenant, user) limiter consumed BEFORE the
 * resolve (429 + `Retry-After`) → resolve for the caller's member → 503
 * `count_unavailable` when resolution fails (FR-040b). The custom list is
 * counted client-side and is rejected here. Shared logic in
 * `src/lib/broadcasts-recipient-count.ts`.
 *
 * Clone of `quota/route.ts` in shape; Node runtime (Drizzle + Upstash).
 */
import { randomUUID } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { broadcastsRateLimiter, makeResolveSegmentDeps } from '@/modules/broadcasts';
import { baseHeaders, errorResponse } from '@/lib/broadcasts-route-helpers';
import { requireMemberContext } from '@/lib/member-context';
import {
  RECIPIENT_COUNT_RATE_MAX,
  RECIPIENT_COUNT_RATE_WINDOW_SECONDS,
  countRecipients,
  parseRecipientCountQuery,
  recipientCountRateKey,
} from '@/lib/broadcasts-recipient-count';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest): Promise<NextResponse> {
  const correlationId = randomUUID();
  const ctx = await requireMemberContext(request);
  if ('response' in ctx && ctx.response) {
    return ctx.response;
  }

  const query = parseRecipientCountQuery(request.nextUrl.searchParams);
  if (!query.ok) {
    return errorResponse(400, 'invalid_query', correlationId);
  }

  const limit = await broadcastsRateLimiter.checkLimit(
    recipientCountRateKey(ctx.tenant.slug, ctx.current.user.id),
    RECIPIENT_COUNT_RATE_MAX,
    RECIPIENT_COUNT_RATE_WINDOW_SECONDS,
  );
  if (!limit.ok) {
    return errorResponse(429, 'broadcast_rate_limit_exceeded', correlationId, {
      retryAfterSeconds: limit.error.retryAfterSeconds,
      details: { retryAfterSeconds: limit.error.retryAfterSeconds },
    });
  }

  const outcome = await countRecipients(makeResolveSegmentDeps(ctx.tenant.slug), {
    segment: query.segment,
    requestingMemberId: ctx.member.memberId as string,
    correlationId,
  });
  if (outcome.status === 'unavailable') {
    return errorResponse(503, 'count_unavailable', correlationId);
  }
  return NextResponse.json(outcome.body, { status: 200, headers: baseHeaders(correlationId) });
}
