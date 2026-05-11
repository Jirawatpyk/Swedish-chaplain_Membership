/**
 * F8 Phase 8 T215 — `POST /api/admin/renewals/tasks/[taskId]/done`.
 *
 * Admin marks an open escalation task as done. Optional outcome note
 * captured for forensic chain (≤1000 chars per Domain invariant +
 * `renewal_escalation_tasks.outcome_note` CHECK).
 *
 * RBAC: admin only. Mirrors Phase 7 tier-upgrade action route shape;
 * no per-route rate-limit (admin actions on tasks are state-only with
 * no external side effects — RBAC + idempotency-by-design suffice).
 */
import { type NextRequest } from 'next/server';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { renewalsMetrics } from '@/lib/metrics';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import {
  errorResponse,
  successResponse,
  requireRenewalAdminContext,
} from '@/lib/renewals-route-helpers';
import { completeEscalationTask, makeRenewalsDeps } from '@/modules/renewals';

const BodySchema = z.object({
  outcome_note: z.string().trim().max(1000).optional(),
});

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ taskId: string }> },
) {
  if (!env.features.f8Renewals) {
    return errorResponse({
      status: 503,
      code: 'feature_disabled',
      correlationId: randomUUID(),
    });
  }

  const ctx = await requireRenewalAdminContext(request, 'write');
  if ('response' in ctx) return ctx.response;

  const { taskId } = await context.params;

  let raw: unknown = {};
  try {
    raw = await request.json();
  } catch {
    raw = {};
  }
  const parsed = BodySchema.safeParse(raw);
  if (!parsed.success) {
    return errorResponse({
      status: 400,
      code: 'invalid_body',
      correlationId: ctx.correlationId,
      details: { fieldErrors: parsed.error.flatten().fieldErrors },
    });
  }

  const tenantCtx = resolveTenantFromRequest(request);
  const deps = makeRenewalsDeps(tenantCtx.slug);

  try {
    const result = await completeEscalationTask(deps, {
      tenantId: tenantCtx.slug,
      taskId,
      ...(parsed.data.outcome_note !== undefined
        ? { outcomeNote: parsed.data.outcome_note }
        : {}),
      actorUserId: ctx.current.user.id,
      actorRole: 'admin',
      requestId: ctx.requestId,
      correlationId: ctx.correlationId,
    });
    if (!result.ok) {
      // R10 T277g close — emit per-outcome counter for F8-A8 alarm
      // (renewals_escalation_task_action_total{outcome='server_error'}
      // ≥ 3 in any 5-min window).
      renewalsMetrics.escalationTaskAction(
        tenantCtx.slug,
        'done',
        result.error.kind,
      );
      switch (result.error.kind) {
        case 'invalid_input':
          return errorResponse({
            status: 400,
            code: 'invalid_input',
            correlationId: ctx.correlationId,
            details: { message: result.error.message },
          });
        case 'task_not_found':
          return errorResponse({
            status: 404,
            code: 'task_not_found',
            correlationId: ctx.correlationId,
          });
        case 'task_not_open':
          return errorResponse({
            status: 409,
            code: 'task_not_open',
            correlationId: ctx.correlationId,
          });
        case 'server_error':
          return errorResponse({
            status: 500,
            code: 'server_error',
            correlationId: ctx.correlationId,
          });
      }
      const _exhaustive: never = result.error;
      return _exhaustive;
    }
    renewalsMetrics.escalationTaskAction(tenantCtx.slug, 'done', 'success');
    return successResponse(
      {
        task_id: result.value.taskId,
        closed_at: result.value.closedAt,
      },
      ctx.correlationId,
    );
  } catch (e) {
    logger.error(
      {
        err: e instanceof Error ? e : new Error(String(e)),
        correlationId: ctx.correlationId,
        taskId,
      },
      'admin.renewals.tasks.done_unexpected_error',
    );
    renewalsMetrics.escalationTaskAction(
      tenantCtx.slug,
      'done',
      'server_error',
    );
    return errorResponse({
      status: 500,
      code: 'server_error',
      correlationId: ctx.correlationId,
    });
  }
}
