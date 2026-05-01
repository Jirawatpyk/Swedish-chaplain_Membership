/**
 * T109 — POST `/api/admin/broadcasts/[id]/approve`.
 *
 * Wraps `approveBroadcast` use-case (Wave 1). Two body variants via
 * discriminatedUnion `decision`:
 *   - { decision: 'send_now' }                     → approved, scheduledFor=now (cron picks up ≤60s)
 *   - { decision: 'schedule', scheduledFor: ISO }  → approved with future scheduledFor
 *
 * Authz: admin only (manager 403 via RBAC `broadcast`+`write`).
 *
 * Post-success: best-effort member email enqueue (broadcast_approved
 * notification) via emailTransactionalBridge.
 */
import { randomUUID } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import {
  approveBroadcast,
  emailTransactionalBridge,
  makeApproveBroadcastDeps,
  parseBroadcastId,
  type ApproveBroadcastError,
} from '@/modules/broadcasts';
import {
  errorResponse,
  httpStatusForBroadcastError,
  baseHeaders,
} from '@/lib/broadcasts-route-helpers';
import { requireAdminContext } from '@/lib/admin-context';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { logger } from '@/lib/logger';

const MIN_SCHEDULE_LEAD_MS = 5 * 60 * 1000;

const ApproveBodySchema = z.discriminatedUnion('decision', [
  z.object({ decision: z.literal('send_now') }),
  z.object({
    decision: z.literal('schedule'),
    scheduledFor: z
      .string()
      .datetime({ offset: true })
      .refine(
        (t) => new Date(t).getTime() > Date.now() + MIN_SCHEDULE_LEAD_MS,
        { message: 'scheduledFor must be at least 5 minutes in the future' },
      ),
  }),
]);

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
  const parsed = ApproveBodySchema.safeParse(raw);
  if (!parsed.success) {
    return errorResponse(400, 'invalid_body', correlationId, {
      fieldErrors: parsed.error.flatten().fieldErrors as Record<string, string[]>,
    });
  }

  const tenantCtx = resolveTenantFromRequest(request);
  const deps = makeApproveBroadcastDeps(tenantCtx.slug);

  const decision =
    parsed.data.decision === 'send_now'
      ? ({ mode: 'send_now' } as const)
      : ({
          mode: 'schedule' as const,
          scheduledFor: new Date(parsed.data.scheduledFor),
        } as const);

  try {
    const result = await approveBroadcast(deps, {
      broadcastId: parsedId.value,
      actorUserId: ctx.current.user.id,
      decision,
      requestId: ctx.requestId,
    });
    if (!result.ok) {
      return mapApproveError(result.error, correlationId);
    }

    // Best-effort member email
    try {
      const broadcast = result.value.broadcast;
      const replyTo = broadcast.replyToEmail;
      if (replyTo.length > 0) {
        await emailTransactionalBridge.sendMemberEmail(
          tenantCtx,
          {
            to: replyTo,
            subject: 'Your E-Blast was approved',
            templateKey: 'broadcast_approved',
            payload: {
              broadcastId: broadcast.broadcastId,
              decision: decision.mode,
              scheduledFor: result.value.scheduledFor.toISOString(),
            },
            locale: 'en',
          },
          null,
        );
      }
    } catch (e) {
      // Review I5 — emit at error severity so log-aggregation alerts
      // can enumerate "approvals where the member never got told." The
      // approval itself succeeded (audit `broadcast_approved` already
      // fired inside the use-case) — this is a notification-side
      // best-effort failure that needs ops visibility for backfill.
      logger.error(
        {
          err: e instanceof Error ? e.message : String(e),
          correlationId,
          tenantId: tenantCtx.slug,
          broadcastId: parsedId.value as string,
          recipient: result.value.broadcast.replyToEmail,
          templateKey: 'broadcast_approved',
          severity: 'notification_email',
        },
        'broadcasts.approve.member_email_enqueue_failed',
      );
    }

    return NextResponse.json(
      {
        broadcastId: result.value.broadcast.broadcastId,
        status: result.value.status,
        approvedAt: result.value.approvedAt.toISOString(),
        scheduledFor: result.value.scheduledFor.toISOString(),
        resendBroadcastId: null,
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
      'admin.broadcasts.approve.unexpected_error',
    );
    return errorResponse(500, 'internal_error', correlationId);
  }
}

function mapApproveError(
  error: ApproveBroadcastError,
  correlationId: string,
): NextResponse {
  if (error.kind === 'approve.server_error') {
    return errorResponse(500, 'internal_error', correlationId);
  }
  const { status, code } = httpStatusForBroadcastError(error.kind);
  const details: Record<string, unknown> = {};
  if (error.kind === 'broadcast_invalid_state_transition') {
    details['observedStatus'] = error.observedStatus;
  } else if (error.kind === 'broadcast_concurrent_action_blocked') {
    details['observedStatus'] = error.observedStatus;
  } else if (error.kind === 'broadcast_schedule_too_soon') {
    details['scheduledFor'] = error.scheduledFor.toISOString();
  } else if (error.kind === 'broadcast_not_found') {
    details['broadcastId'] = error.broadcastId;
  }
  return errorResponse(status, code, correlationId, {
    ...(Object.keys(details).length > 0 && { details }),
  });
}
