/**
 * 108 PR-C T088 — `GET /api/broadcasts/recipient-count` (member compose).
 *
 * Query: `segment=all_members|tier|event_attendees_last_90d`, `tier=<code>[,<code>]`.
 * 200 `{ count, ceiling, exceeds }`, plus `droppedByPreference` **only when
 * `count === 0`** — numbers only (FR-040a). Both `orphans` and (at non-zero
 * counts) `droppedByPreference` are stripped here as facts about OTHER
 * members; the staff route keeps them. See the comment at the return for why.
 * *(Header corrected 2026-09-08: it promised `droppedByPreference`
 * unconditionally, contradicting the code twelve lines below it, and an
 * integration test believed the header rather than the route.)*
 * Order of checks is the contract: member gate → query
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
    requestingMemberId: ctx.member.memberId,
    correlationId,
  });
  if (outcome.status === 'unavailable') {
    return errorResponse(503, 'count_unavailable', correlationId);
  }
  // Review 2026-09-07 (code M-3) — `orphans` is a fact about OTHER members
  // ("N companies have no reachable contact"); the compose UI never renders
  // it and a member could otherwise probe it tier by tier. Staff keep it on
  // the admin route.
  const { orphans: _orphans, ...memberBody } = outcome.body;
  void _orphans;
  // /code-review 2026-09-07 (finding #4) — M-3 stripped `orphans` as a fact
  // about OTHER members that the compose UI never renders, then left
  // `droppedByPreference` — which is the same shape: a count of other
  // members' contacts who objected, answerable 30×/min and probeable tier by
  // tier (some SweCham tiers hold 3 members, so "2 of 3 objected" is close to
  // naming them). FR-022a's "tell the sender how many" binds on the CUSTOM
  // LIST at SUBMIT time; this is the polled segment count. The single
  // rendered use is the `empty` string — "a tier where everyone objected
  // reads differently from a tier with nobody in it" — which is only reached
  // at count 0, so that is the only answer that carries it. The field is
  // already optional on the client (`droppedByPreference?: number`, `?? 0`),
  // so omitting it changes no rendered string. Staff keep it on the admin
  // route, and the submit response is untouched.
  const body =
    memberBody.count === 0
      ? memberBody
      : (({ droppedByPreference: _dropped, ...rest }) => rest)(memberBody);
  return NextResponse.json(body, { status: 200, headers: baseHeaders(correlationId) });
}
