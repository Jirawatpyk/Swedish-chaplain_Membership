/**
 * T111 — POST `/api/admin/broadcasts/[id]/cancel` (admin path).
 *
 * Wraps shared `cancelBroadcast` use-case with `actor.kind='admin'`.
 * FR-004a: admin-cancel REQUIRES a reason (≤500 chars).
 * Authz: `broadcasts.write` (named on the gate — `check:api-route-guard`).
 *
 * F119 T081 — cancellable at every in-progress stage; 409 `sending_started`
 * from `sending` onward; 409 `broadcast_cancel_too_late` for a closed E-Blast
 * that never started sending. The E-Blast's images are stamped in the same tx,
 * and the 30 / 60 s per-(tenant, actor) staff write bucket is consumed after
 * the id parse and BEFORE the body is read or anything is written.
 */
import { randomUUID } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import {
  cancelBroadcast,
  makeCancelBroadcastDeps,
  parseBroadcastId,
  tenantDefaultLocaleFor,
  type CancelBroadcastError,
} from '@/modules/broadcasts';
import {
  errorResponse,
  httpStatusForBroadcastError,
  baseHeaders,
} from '@/lib/broadcasts-route-helpers';
import { makeMarketingDirectory } from '@/lib/broadcast-marketing-deps';
import { consumeStaffWriteBucket } from '@/lib/broadcasts-staff-write-bucket';
import { requireApiPermission } from '@/lib/rbac';
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
  const ctx = await requireApiPermission(request, 'broadcasts.write');
  if ('response' in ctx) return ctx.response;

  const { id } = await context.params;
  const parsedId = parseBroadcastId(id);
  if (!parsedId.ok) {
    return errorResponse(404, 'broadcast_not_found', correlationId);
  }

  const tenantCtx = resolveTenantFromRequest(request);
  const limited = await consumeStaffWriteBucket(tenantCtx.slug, ctx.current.user.id, correlationId);
  if (limited !== null) return limited;

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

  const deps = makeCancelBroadcastDeps(tenantCtx.slug, makeMarketingDirectory(tenantCtx.slug));

  try {
    const result = await cancelBroadcast(deps, {
      broadcastId: parsedId.value,
      actor: { kind: 'admin', userId: ctx.current.user.id },
      actorRole: ctx.current.user.role ?? null,
      cancellationReason: parsed.data.cancellationReason,
      requestId: ctx.requestId,
      // E1 closure (verify-fix 2026-05-02) — single-source-of-truth
      // enqueue lives inside the use-case (in-tx atomic with audit).
      notificationLocale: tenantDefaultLocaleFor(tenantCtx.slug),
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
  if (error.kind === 'broadcast_cancel_too_late' || error.kind === 'sending_started') {
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
