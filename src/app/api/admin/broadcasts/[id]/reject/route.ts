/**
 * T110 — POST `/api/admin/broadcasts/[id]/reject`.
 *
 * Wraps `rejectBroadcast` use-case. FR-012: rejectionReason verbatim
 * to member email; sha256(reason) to audit log.
 *
 * Authz: `broadcasts.write` (manager 403).
 *
 * F119 T081 — widened to every in-progress stage with a `rejected` exit
 * (409 `sending_started` from `sending` onward), the E-Blast's images stamped
 * in the same tx, and the 30 / 60 s per-(tenant, actor) staff write bucket —
 * an atomic check consumed after the id parse and BEFORE the body is read or
 * anything is written.
 */
import { randomUUID } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import {
  makeRejectBroadcastDeps,
  parseBroadcastId,
  rejectBroadcast,
  tenantDefaultLocaleFor,
  type RejectBroadcastError,
} from '@/modules/broadcasts';
import {
  errorResponse,
  httpStatusForBroadcastError,
  baseHeaders,
} from '@/lib/broadcasts-route-helpers';
import { consumeStaffWriteBucket } from '@/lib/broadcasts-staff-write-bucket';
import { requireApiPermission } from '@/lib/rbac';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { logger } from '@/lib/logger';

const RejectBodySchema = z.object({
  rejectionReason: z.string().min(1).max(2000),
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
  const parsed = RejectBodySchema.safeParse(raw);
  if (!parsed.success) {
    return errorResponse(400, 'invalid_body', correlationId, {
      fieldErrors: parsed.error.flatten().fieldErrors as Record<string, string[]>,
    });
  }

  const deps = makeRejectBroadcastDeps(tenantCtx.slug);

  try {
    const result = await rejectBroadcast(deps, {
      broadcastId: parsedId.value,
      actorUserId: ctx.current.user.id,
      actorRole: ctx.current.user.role ?? null,
      rejectionReason: parsed.data.rejectionReason,
      requestId: ctx.requestId,
      // E1 closure (verify-fix 2026-05-02) — single-source-of-truth
      // enqueue lives inside the use-case (in-tx atomic with audit).
      // Route no longer post-tx enqueues.
      notificationLocale: tenantDefaultLocaleFor(tenantCtx.slug),
    });
    if (!result.ok) {
      return mapRejectError(result.error, correlationId);
    }

    return NextResponse.json(
      {
        broadcastId: result.value.broadcast.broadcastId,
        status: 'rejected' as const,
        rejectedAt: result.value.broadcast.rejectedAt?.toISOString() ?? null,
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
      'admin.broadcasts.reject.unexpected_error',
    );
    return errorResponse(500, 'internal_error', correlationId);
  }
}

function mapRejectError(
  error: RejectBroadcastError,
  correlationId: string,
): NextResponse {
  if (error.kind === 'reject.server_error') {
    return errorResponse(500, 'internal_error', correlationId);
  }
  const { status, code } = httpStatusForBroadcastError(error.kind);
  const details: Record<string, unknown> = {};
  if (error.kind === 'broadcast_invalid_state_transition' || error.kind === 'sending_started') {
    details['observedStatus'] = error.observedStatus;
  } else if (error.kind === 'broadcast_concurrent_action_blocked') {
    details['observedStatus'] = error.observedStatus;
  } else if (error.kind === 'broadcast_rejection_reason_too_long') {
    details['length'] = error.length;
  } else if (error.kind === 'broadcast_not_found') {
    details['broadcastId'] = error.broadcastId;
  }
  return errorResponse(status, code, correlationId, {
    ...(Object.keys(details).length > 0 && { details }),
  });
}
