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
import { completeEscalationTask, makeRenewalsDeps } from '@/modules/renewals';

/**
 * This route's entry in the F8 errorId taxonomy (`F8ErrorId` in
 * `src/lib/renewals-route-helpers.ts`, documented in
 * `docs/runbooks/audit-emit-loss.md`). Every line this route logs about a
 * failure carries it, so an SRE rule keyed on `F8.TASK_DONE.*` matches every failure
 * this route can produce.
 *
 * Which suffixes exist here is whatever the code below emits — deliberately
 * NOT listed. Four rounds of review found an enumerated list false as soon as
 * a suffix moved: naming two was wrong once `.SERVER_ERROR` landed, and naming
 * `.SERVER_ERROR` was wrong for the routes that have no `server_error` arm.
 * `pnpm check:f8-error-id` is what holds the claim above true.
 */
const ERROR_ID = 'F8.TASK_DONE';

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

  const ctx = await requireRenewalAdminContext(
    request,
    'write',
    'renewals.write',
    ERROR_ID,
  );
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
      // rbac-narrow-ok: stamps the LITERAL role into the audit row; the
      // gate above already decided admission (016 post-ship finding #3).
      actorRole: ctx.current.user.role === 'super_admin' ? 'super_admin' : 'admin',
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
          // Round-2 review — this arm returns the 500 this route produces
          // MOST often (the use-case caught something), and it logged no
          // errorId, so the docblock's promise that a rule keyed on
          // `${ERROR_ID}.*` matches every 500 was false for the common case.
          // `accept/route.ts` had done this since R3-S5; nothing else had.
          logger.error(
            {
              errorId: `${ERROR_ID}.SERVER_ERROR`,
              correlationId: ctx.correlationId,
            },
            'admin.renewals.tasks_done_server_error',
          );
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
        `complete-escalation-task: unhandled error kind '${(result.error as { readonly kind: string }).kind}'`,
      );
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
        // Review of this change - the comment above the assertNever arm
        // promised an `errorId` this catch did not emit. The F8 alert
        // rules are told to key on it (docs/runbooks/audit-emit-loss.md:
        // "Pin SRE alert rules to errorId, NOT to message-text strings"), so
        // without it an unhandled error kind reached a 500 that no rule
        // could match. Added so the comment and docs/code-conventions.md
        // are true of this file, not only of the accept route.
        errorId: `${ERROR_ID}.UNEXPECTED`,
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
