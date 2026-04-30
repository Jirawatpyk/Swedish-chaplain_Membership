/**
 * F7 Q15 — POST `/api/portal/broadcasts/acknowledge`.
 *
 * Member CTA on the marketing-acknowledgement banner records GDPR Art. 7
 * demonstrable consent: sets `members.broadcasts_acknowledged_at = now()`
 * + emits `member_acknowledged_broadcasts_terms` audit row carrying the
 * locale the consent was shown in (compliance audit answer to "which
 * language was the user reading?").
 *
 * Wraps F3 `markBroadcastsAcknowledged` use-case (added in Batch C T029).
 */
import { randomUUID } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import {
  markBroadcastsAcknowledged,
  drizzleMemberRepo,
  asMemberId,
} from '@/modules/members';
import {
  errorResponse,
  baseHeaders,
} from '@/lib/broadcasts-route-helpers';
import { requireMemberContext } from '@/lib/member-context';
import { logger } from '@/lib/logger';

const AckBodySchema = z.object({
  locale: z.enum(['en', 'th', 'sv']).optional(),
});

export async function POST(request: NextRequest): Promise<NextResponse> {
  const correlationId = randomUUID();
  const ctx = await requireMemberContext(request);
  if ('response' in ctx && ctx.response) {
    return ctx.response;
  }

  // Body is optional — banner sends `{ locale }` but missing-body is OK
  // (default to 'en' if header not present).
  let raw: unknown = {};
  try {
    raw = await request.json();
  } catch {
    raw = {};
  }
  const parsed = AckBodySchema.safeParse(raw);
  const locale = parsed.success ? (parsed.data.locale ?? 'en') : 'en';

  try {
    const result = await markBroadcastsAcknowledged(
      {
        tenant: ctx.tenant,
        memberRepo: drizzleMemberRepo,
        clock: { now: () => new Date() },
      },
      asMemberId(ctx.member.memberId),
    );

    if (!result.ok) {
      // Idempotent — already-acknowledged is a 200 (banner dismissal
      // doesn't need to re-emit audit).
      if (
        'code' in result.error &&
        result.error.code === 'mark_ack.member_not_found'
      ) {
        return errorResponse(404, 'broadcast_not_found', correlationId);
      }
      logger.warn(
        {
          correlationId,
          tenantId: ctx.tenant.slug,
          memberId: ctx.member.memberId,
          err: result.error,
          locale,
        },
        'broadcasts.acknowledge.member_repo_error',
      );
      return errorResponse(500, 'internal_error', correlationId);
    }

    return NextResponse.json(
      {
        acknowledgedAt: result.value.acknowledgedAt.toISOString(),
        wasNew: result.value.previouslyNull,
        locale,
      },
      {
        status: 200,
        headers: baseHeaders(correlationId),
      },
    );
  } catch (e) {
    logger.error(
      {
        err: e instanceof Error ? e.message : String(e),
        correlationId,
        tenantId: ctx.tenant.slug,
        memberId: ctx.member.memberId,
      },
      'broadcasts.acknowledge.unexpected_error',
    );
    return errorResponse(500, 'internal_error', correlationId);
  }
}
