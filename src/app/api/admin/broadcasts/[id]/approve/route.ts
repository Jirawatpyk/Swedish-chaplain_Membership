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
  makeApproveBroadcastDeps,
  parseBroadcastId,
  tenantDefaultLocaleFor,
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
import { broadcastsMetrics } from '@/lib/metrics';
import { broadcastsTracer } from '@/lib/otel-tracer';
import { SpanStatusCode } from '@opentelemetry/api';

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

  // T174 — root span `admin_approve_send_now` (docs/observability.md
  // § 22). T172 — SLO-F7-004 latency histogram (target p95 < 1.5s).
  // R7 staff-review LOW-P1 fix — moved histogram emit into `finally`
  // so exception paths also record the latency. Without this, errors
  // (Neon outage, Resend 5xx) silently exclude themselves from the
  // SLO histogram, biasing the p95 toward happy-path-only and
  // hiding real availability regressions.
  const startedAtMs = Date.now();
  try {
    const result = await broadcastsTracer().startActiveSpan(
      'admin_approve_send_now',
      {
        attributes: {
          'tenant.id': tenantCtx.slug,
          'broadcast.id': parsedId.value as unknown as string,
          'actor.role': 'admin',
          'broadcasts.decision': decision.mode,
        },
      },
      async (span) => {
        try {
          const r = await approveBroadcast(deps, {
            broadcastId: parsedId.value,
            actorUserId: ctx.current.user.id,
            decision,
            requestId: ctx.requestId,
            notificationLocale: tenantDefaultLocaleFor(tenantCtx.slug),
          });
          span.setAttribute(
            'broadcasts.outcome',
            r.ok ? r.value.status : `err:${r.error.kind}`,
          );
          return r;
        } catch (e) {
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: e instanceof Error ? e.message : 'approve_threw',
          });
          throw e;
        } finally {
          span.end();
        }
      },
    );
    if (!result.ok) {
      return mapApproveError(result.error, correlationId);
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
  } finally {
    broadcastsMetrics.approveSendNowDurationMs(
      tenantCtx.slug,
      Date.now() - startedAtMs,
    );
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
