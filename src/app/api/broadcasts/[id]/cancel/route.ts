/**
 * T113 — POST `/api/broadcasts/[id]/cancel` (member-side path).
 *
 * Wraps shared `cancelBroadcast` use-case with `actor.kind='member'`.
 * FR-004a: member cancel reason is OPTIONAL.
 *
 * Cross-member probe rejection: the use-case surfaces
 * `broadcast_not_found` shape when caller is not the originating member,
 * preventing existence leak across members.
 */
import { randomUUID } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import {
  cancelBroadcast,
  makeCancelBroadcastDeps,
  parseBroadcastId,
  type CancelBroadcastError,
} from '@/modules/broadcasts';
import {
  errorResponse,
  httpStatusForBroadcastError,
  baseHeaders,
} from '@/lib/broadcasts-route-helpers';
import { requireMemberContext } from '@/lib/member-context';
import { logger } from '@/lib/logger';

const MemberCancelBodySchema = z
  .object({
    cancellationReason: z.string().max(500).optional(),
  })
  .optional();

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const correlationId = randomUUID();
  const ctx = await requireMemberContext(request);
  if ('response' in ctx && ctx.response) {
    return ctx.response;
  }

  const { id } = await context.params;
  const parsedId = parseBroadcastId(id);
  if (!parsedId.ok) {
    return errorResponse(404, 'broadcast_not_found', correlationId);
  }

  let raw: unknown = {};
  try {
    raw = await request.json();
  } catch {
    raw = {};
  }
  const parsed = MemberCancelBodySchema.safeParse(raw);
  if (!parsed.success) {
    return errorResponse(400, 'invalid_body', correlationId, {
      fieldErrors: parsed.error.flatten().fieldErrors as Record<string, string[]>,
    });
  }

  const reason = parsed.data?.cancellationReason ?? null;
  const deps = makeCancelBroadcastDeps(ctx.tenant.slug);

  try {
    const result = await cancelBroadcast(deps, {
      broadcastId: parsedId.value,
      actor: {
        kind: 'member',
        memberId: ctx.member.memberId,
        userId: ctx.current.user.id,
      },
      cancellationReason: reason,
      requestId: ctx.requestId,
    });
    if (!result.ok) {
      return mapCancelError(result.error, correlationId);
    }

    return NextResponse.json(
      {
        broadcastId: result.value.broadcast.broadcastId,
        status: 'cancelled' as const,
        cancelledAt: result.value.broadcast.cancelledAt?.toISOString() ?? null,
        reservationReleased: true as const,
      },
      { status: 200, headers: baseHeaders(correlationId) },
    );
  } catch (e) {
    logger.error(
      {
        err: e instanceof Error ? e.message : String(e),
        correlationId,
        tenantId: ctx.tenant.slug,
        memberId: ctx.member.memberId,
        broadcastId: parsedId.value as string,
      },
      'broadcasts.member_cancel.unexpected_error',
    );
    return errorResponse(500, 'internal_error', correlationId);
  }
}

function mapCancelError(
  error: CancelBroadcastError,
  correlationId: string,
): NextResponse {
  if (error.kind === 'cancel.server_error') {
    return errorResponse(500, 'internal_error', correlationId);
  }
  const { status, code } = httpStatusForBroadcastError(error.kind);
  const details: Record<string, unknown> = {};
  if (error.kind === 'broadcast_cancel_too_late') {
    details['observedStatus'] = error.observedStatus;
  } else if (error.kind === 'broadcast_concurrent_action_blocked') {
    details['observedStatus'] = error.observedStatus;
  } else if (error.kind === 'broadcast_cancel_reason_too_long') {
    details['length'] = error.length;
  } else if (error.kind === 'broadcast_not_found') {
    details['broadcastId'] = error.broadcastId;
  }
  return errorResponse(status, code, correlationId, {
    ...(Object.keys(details).length > 0 && { details }),
  });
}
