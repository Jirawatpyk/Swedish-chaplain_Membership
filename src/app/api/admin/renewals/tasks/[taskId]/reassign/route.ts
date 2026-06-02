/**
 * F8 Phase 8 T217 — `POST /api/admin/renewals/tasks/[taskId]/reassign`.
 *
 * Admin reassigns the `assigned_to_user_id` of an open escalation task
 * per FR-044 + AS3. The combobox in the queue UI (T222) only shows
 * same-tenant users; the route validates `to_user_id` shape (UUID) and
 * trusts the route-helper's tenant-resolution + use-case's
 * `findById`/`reassign` semantics for tenant isolation (RLS+FORCE on
 * `renewal_escalation_tasks` already enforces this — see migration
 * 0092).
 *
 * RBAC: admin only.
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
import {
  reassignEscalationTask,
  makeRenewalsDeps,
} from '@/modules/renewals';
import { userRepo } from '@/lib/auth-deps';
import { asUserId } from '@/modules/auth';

const BodySchema = z.object({
  to_user_id: z.string().uuid(),
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

  // B16 defence-in-depth — the reassign combobox only offers active admin/
  // manager users, but a direct API caller could send any UUID (disabled,
  // member-role, or non-existent). The F1 `users` table is global (no
  // tenant_id column yet — saas-architecture.md MTA), so a true per-tenant
  // membership check isn't implementable today; the strongest invariant
  // available is "target is an active staff user". Reject anything else
  // before the tenant-scoped write + audit. NOTE: keep this role allow-list
  // in lockstep with /api/admin/users/staff-active.
  let assignee: Awaited<ReturnType<typeof userRepo.findById>>;
  try {
    assignee = await userRepo.findById(asUserId(parsed.data.to_user_id));
  } catch (e) {
    logger.error(
      {
        err: e instanceof Error ? e : new Error(String(e)),
        correlationId: ctx.correlationId,
        taskId,
      },
      'admin.renewals.tasks.reassign_assignee_lookup_failed',
    );
    return errorResponse({
      status: 500,
      code: 'server_error',
      correlationId: ctx.correlationId,
    });
  }
  if (
    assignee === null ||
    assignee.status !== 'active' ||
    (assignee.role !== 'admin' && assignee.role !== 'manager')
  ) {
    return errorResponse({
      status: 400,
      code: 'invalid_input',
      correlationId: ctx.correlationId,
      details: { message: 'assignee must be an active staff user' },
    });
  }

  const tenantCtx = resolveTenantFromRequest(request);
  const deps = makeRenewalsDeps(tenantCtx.slug);

  try {
    const result = await reassignEscalationTask(deps, {
      tenantId: tenantCtx.slug,
      taskId,
      toUserId: parsed.data.to_user_id,
      actorUserId: ctx.current.user.id,
      actorRole: 'admin',
      requestId: ctx.requestId,
      correlationId: ctx.correlationId,
    });
    if (!result.ok) {
      // R10 T277g close — F8-A8 alarm rolls up via this counter.
      renewalsMetrics.escalationTaskAction(
        tenantCtx.slug,
        'reassign',
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
    renewalsMetrics.escalationTaskAction(tenantCtx.slug, 'reassign', 'success');
    return successResponse(
      {
        task_id: result.value.taskId,
        from_user_id: result.value.fromUserId,
        to_user_id: result.value.toUserId,
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
      'admin.renewals.tasks.reassign_unexpected_error',
    );
    renewalsMetrics.escalationTaskAction(
      tenantCtx.slug,
      'reassign',
      'server_error',
    );
    return errorResponse({
      status: 500,
      code: 'server_error',
      correlationId: ctx.correlationId,
    });
  }
}
