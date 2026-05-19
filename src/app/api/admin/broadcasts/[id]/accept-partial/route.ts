/**
 * T051 (F7.1a US1) — POST `/api/admin/broadcasts/[id]/accept-partial`.
 *
 * Wraps `acceptPartialDelivery` use case (Phase 3 Cluster 3B.2).
 * Terminal state transition `partially_sent → partial_delivery_accepted`.
 * Optional admin-supplied reason ≤500 chars persisted to the audit
 * event payload.
 *
 * Auth: admin role (RBAC `broadcast`+`write`).
 *
 * Contract spec: specs/014-email-broadcast-advance/contracts/batch-dispatch.md § 1.4.
 *
 * Concurrency: no advisory lock needed — underlying SQL
 * `UPDATE … WHERE status='partially_sent'` serialises concurrent
 * clicks via DB row lock; the loser sees 0 rows updated → adapter
 * surfaces INVALID_STATE_TRANSITION.
 *
 * Body schema: `{ reason?: string (≤500 chars) }`.
 */
import { randomUUID } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import {
  acceptPartialDelivery,
  makeAcceptPartialDeliveryDeps,
  parseBroadcastId,
  MAX_REASON_LENGTH,
  type AcceptPartialDeliveryError,
} from '@/modules/broadcasts';
import {
  errorResponse,
  httpStatusForBroadcastError,
  baseHeaders,
} from '@/lib/broadcasts-route-helpers';
import { requireAdminContext } from '@/lib/admin-context';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { logger } from '@/lib/logger';

const AcceptPartialBodySchema = z.object({
  reason: z.string().max(MAX_REASON_LENGTH).optional(),
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

  // Body is optional — admins may accept partial without a reason.
  let raw: unknown = {};
  try {
    const text = await request.text();
    if (text.trim() !== '') {
      raw = JSON.parse(text);
    }
  } catch {
    return errorResponse(400, 'invalid_body', correlationId);
  }
  const parsed = AcceptPartialBodySchema.safeParse(raw);
  if (!parsed.success) {
    // Reason >500 is the most likely body-validation failure.
    const reasonErr = parsed.error.flatten().fieldErrors['reason'];
    if (reasonErr !== undefined) {
      return errorResponse(
        400,
        'broadcast_partial_delivery_reason_too_long',
        correlationId,
      );
    }
    return errorResponse(400, 'invalid_body', correlationId, {
      fieldErrors: parsed.error.flatten().fieldErrors as Record<
        string,
        string[]
      >,
    });
  }

  const tenantCtx = resolveTenantFromRequest(request);
  const deps = makeAcceptPartialDeliveryDeps(tenantCtx.slug);

  try {
    const result = await acceptPartialDelivery(deps, {
      tenantId: tenantCtx,
      broadcastId: parsedId.value,
      actorUserId: ctx.current.user.id,
      ...(parsed.data.reason !== undefined && { reason: parsed.data.reason }),
      requestId: ctx.requestId,
    });

    if (!result.ok) {
      return mapAcceptError(result.error, correlationId);
    }

    return NextResponse.json(
      {
        broadcastId: parsedId.value as unknown as string,
        acceptedAt: result.value.acceptedAt.toISOString(),
      },
      { status: 200, headers: baseHeaders(correlationId) },
    );
  } catch (e) {
    logger.error(
      {
        err: e instanceof Error ? e.message : String(e),
        correlationId,
        tenantId: tenantCtx.slug,
        broadcastId: parsedId.value as unknown as string,
      },
      'admin.broadcasts.accept_partial.unexpected_error',
    );
    return errorResponse(500, 'internal_error', correlationId);
  }
}

function mapAcceptError(
  error: AcceptPartialDeliveryError,
  correlationId: string,
): NextResponse {
  if (error.kind === 'accept_partial_delivery.server_error') {
    return errorResponse(500, 'internal_error', correlationId);
  }

  const code = (() => {
    switch (error.kind) {
      case 'BROADCAST_NOT_FOUND':
        return 'broadcast_not_found' as const;
      case 'INVALID_STATE_TRANSITION':
        return 'broadcast_invalid_state_transition' as const;
      case 'invalid_input.reason_too_long':
        return 'broadcast_partial_delivery_reason_too_long' as const;
    }
  })();

  const { status } = httpStatusForBroadcastError(code);
  const details: Record<string, unknown> = {};
  if (error.kind === 'INVALID_STATE_TRANSITION') {
    details['observedStatus'] = error.currentStatus;
    details['expected'] = error.expected;
  } else if (error.kind === 'invalid_input.reason_too_long') {
    details['length'] = error.length;
    details['maxAllowed'] = error.maxAllowed;
  } else if (error.kind === 'BROADCAST_NOT_FOUND') {
    details['broadcastId'] = error.broadcastId;
  }
  return errorResponse(status, code, correlationId, {
    ...(Object.keys(details).length > 0 && { details }),
  });
}
