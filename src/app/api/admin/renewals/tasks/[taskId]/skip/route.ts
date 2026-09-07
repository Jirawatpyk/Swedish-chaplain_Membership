/**
 * F8 Phase 8 T216 — `POST /api/admin/renewals/tasks/[taskId]/skip`.
 *
 * Admin marks an open escalation task as skipped. REQUIRED reason
 * (1..500 chars per Domain invariant + `skipped_reason` CHECK +
 * use-case zod schema).
 *
 * RBAC: admin only. Same shape as `/done` route.
 */
import { type NextRequest } from 'next/server';
import { assertNever } from '@/lib/assert-never';
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
import { skipEscalationTask, makeRenewalsDeps } from '@/modules/renewals';

const BodySchema = z.object({
  skipped_reason: z.string().trim().min(1).max(500),
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

  const ctx = await requireRenewalAdminContext(request, 'write', 'renewals.write');
  if ('response' in ctx) return ctx.response;

  const { taskId } = await context.params;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return errorResponse({
      status: 400,
      code: 'invalid_body',
      correlationId: ctx.correlationId,
      details: { message: 'request body required' },
    });
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
    const result = await skipEscalationTask(deps, {
      tenantId: tenantCtx.slug,
      taskId,
      skippedReason: parsed.data.skipped_reason,
      actorUserId: ctx.current.user.id,
      // rbac-narrow-ok: stamps the LITERAL role into the audit row; the
      // gate above already decided admission (016 post-ship finding #3).
      actorRole: ctx.current.user.role === 'super_admin' ? 'super_admin' : 'admin',
      requestId: ctx.requestId,
      correlationId: ctx.correlationId,
    });
    if (!result.ok) {
      // R10 T277g close — F8-A8 alarm rolls up via this counter.
      renewalsMetrics.escalationTaskAction(
        tenantCtx.slug,
        'skip',
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
      // docs/code-conventions.md § 8 — `return _exhaustive` returned the
      // ERROR OBJECT into a `Response` position and, worse, left the `try`
      // NORMALLY, so the catch below never fired and the 500 carried no
      // correlationId. This catch also had no `errorId` at all until the
      // review of that first fix -
      // so nothing an alert rule keys on matched it either, before or
      // after. `assertNever` throws INSIDE the try; the errorId is now
      // emitted. The message names the KIND only -
      // `assertNever`'s default stringifies the whole error object into a
      // message this catch then logs, and a future error kind's payload is
      // not something we can promise is free of member data.
      return assertNever(
        result.error,
        `skip-escalation-task: unhandled error kind '${(result.error as { readonly kind: string }).kind}'`,
      );
    }
    renewalsMetrics.escalationTaskAction(tenantCtx.slug, 'skip', 'success');
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
        // Review of this change - the comment above the assertNever arm
        // promised an `errorId` this catch did not emit. The F8 alert
        // rules are told to key on it (docs/runbooks/audit-emit-loss.md:
        // "Pin SRE alert rules to errorId, NOT to message-text strings"), so
        // without it an unhandled error kind reached a 500 that no rule
        // could match. Added so the comment and docs/code-conventions.md
        // are true of this file, not only of the accept route.
        errorId: 'F8.TASK_SKIP.UNEXPECTED',
        err: e instanceof Error ? e : new Error(String(e)),
        correlationId: ctx.correlationId,
        taskId,
      },
      'admin.renewals.tasks.skip_unexpected_error',
    );
    renewalsMetrics.escalationTaskAction(
      tenantCtx.slug,
      'skip',
      'server_error',
    );
    return errorResponse({
      status: 500,
      code: 'server_error',
      correlationId: ctx.correlationId,
    });
  }
}
