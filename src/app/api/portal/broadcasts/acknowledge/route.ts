/**
 * F7 Q15 — POST `/api/portal/broadcasts/acknowledge`.
 *
 * Member CTA on the marketing-acknowledgement banner records GDPR Art. 7
 * demonstrable consent: sets `members.broadcasts_acknowledged_at = now()`
 * + emits `member_acknowledged_broadcasts_terms` audit row carrying the
 * locale the consent was shown in.
 *
 * Delegates to the `acknowledgeBroadcastsTerms` Application use-case so
 * Presentation never reaches into Application internals (Constitution
 * Principle III). The use-case owns the F3 bridge call + audit emit
 * (with log+swallow on audit-only failure — see use-case header for
 * the atomicity tradeoff).
 */
import { randomUUID } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import {
  acknowledgeBroadcastsTerms,
  makeAcknowledgeBroadcastsTermsDeps,
} from '@/modules/broadcasts';
import { asMemberId } from '@/modules/members';
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
    const result = await acknowledgeBroadcastsTerms(
      makeAcknowledgeBroadcastsTermsDeps(ctx.tenant.slug),
      {
        memberId: asMemberId(ctx.member.memberId),
        actorUserId: ctx.current.user.id,
        locale,
        requestId: correlationId,
      },
    );

    if (!result.ok) {
      // Currently the only error variant from `acknowledgeBroadcastsTerms`
      // is `ack.member_not_found` → 404 (anti-enumeration parity). If
      // new variants are added to the use-case's discriminated error
      // union, add explicit cases here — the unconditional 404 below
      // would otherwise mask them.
      return errorResponse(404, 'broadcast_not_found', correlationId);
    }

    if (result.value.kind === 'idempotent') {
      // Log idempotent re-acks at debug level so the absence of an
      // `acknowledgedAt` field in the response (intentional — F3
      // bridge does not currently return the persisted column on
      // already-acked path) is observable in ops dashboards. Future
      // analytics consumers reading `acknowledgedAt` would otherwise
      // see `undefined` silently. F7.1-TODO: extend F3 bridge to
      // return the persisted timestamp on the idempotent path.
      logger.debug(
        {
          correlationId,
          tenantId: ctx.tenant.slug,
          memberId: ctx.member.memberId,
          locale,
        },
        'broadcasts.acknowledge.idempotent',
      );
    }

    return NextResponse.json(
      result.value.kind === 'fresh'
        ? {
            acknowledgedAt: result.value.acknowledgedAt.toISOString(),
            wasNew: true,
            locale,
          }
        : {
            // Idempotent — the F3 column was already set on a prior
            // request. Client doesn't need a timestamp to dismiss
            // the banner; `wasNew: false` is the dismiss signal.
            // `acknowledgedAt` is intentionally omitted (F7.1-TODO
            // above).
            wasNew: false,
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
