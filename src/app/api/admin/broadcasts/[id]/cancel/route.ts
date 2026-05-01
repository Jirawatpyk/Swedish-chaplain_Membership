/**
 * T111 — POST `/api/admin/broadcasts/[id]/cancel` (admin path).
 *
 * Wraps shared `cancelBroadcast` use-case with `actor.kind='admin'`.
 * FR-004a: admin-cancel REQUIRES a reason (≤500 chars).
 * State-cutoff: only `submitted` / `approved` cancellable (else 409
 * `broadcast_cancel_too_late`).
 */
import { randomUUID } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import {
  cancelBroadcast,
  emailTransactionalBridge,
  makeCancelBroadcastDeps,
  parseBroadcastId,
  type CancelBroadcastError,
} from '@/modules/broadcasts';
import {
  errorResponse,
  httpStatusForBroadcastError,
  baseHeaders,
} from '@/lib/broadcasts-route-helpers';
import { requireAdminContext } from '@/lib/admin-context';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { logger } from '@/lib/logger';

const AdminCancelBodySchema = z.object({
  cancellationReason: z.string().min(1).max(500),
});

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const correlationId = randomUUID();
  const ctx = await requireAdminContext(request, {
    resource: 'broadcast',
    action: 'write',
  });
  if ('response' in ctx) return ctx.response;

  const { id } = await context.params;
  const parsedId = parseBroadcastId(id);
  if (!parsedId.ok) {
    return errorResponse(404, 'broadcast_not_found', correlationId);
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return errorResponse(400, 'invalid_body', correlationId);
  }
  const parsed = AdminCancelBodySchema.safeParse(raw);
  if (!parsed.success) {
    return errorResponse(400, 'invalid_body', correlationId, {
      fieldErrors: parsed.error.flatten().fieldErrors as Record<string, string[]>,
    });
  }

  const tenantCtx = resolveTenantFromRequest(request);
  const deps = makeCancelBroadcastDeps(tenantCtx.slug);

  try {
    const result = await cancelBroadcast(deps, {
      broadcastId: parsedId.value,
      actor: { kind: 'admin', userId: ctx.current.user.id },
      cancellationReason: parsed.data.cancellationReason,
      requestId: ctx.requestId,
    });
    if (!result.ok) {
      return mapCancelError(result.error, correlationId);
    }

    // Best-effort member email
    try {
      const broadcast = result.value.broadcast;
      if (broadcast.replyToEmail.length > 0) {
        await emailTransactionalBridge.sendMemberEmail(
          tenantCtx,
          {
            to: broadcast.replyToEmail,
            subject: 'Your E-Blast was cancelled',
            templateKey: 'broadcast_cancelled',
            payload: {
              broadcastId: broadcast.broadcastId,
              cancellationReason: parsed.data.cancellationReason,
              cancelledByAdmin: true,
            },
            locale: 'en',
          },
          null,
        );
      }
    } catch (e) {
      logger.warn(
        {
          err: e instanceof Error ? e.message : String(e),
          correlationId,
          broadcastId: parsedId.value as string,
        },
        'broadcasts.admin_cancel.member_email_enqueue_failed',
      );
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
        tenantId: tenantCtx.slug,
        broadcastId: parsedId.value as string,
      },
      'admin.broadcasts.cancel.unexpected_error',
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
