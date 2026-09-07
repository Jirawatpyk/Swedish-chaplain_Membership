/**
 * F8 Phase 4 Wave I1b · T085 —
 * PUT `/api/admin/renewals/settings/schedules/[tierBucket]`.
 *
 * Admin-only schedule policy save endpoint per
 * `contracts/admin-renewals-api.md` § 5. Validates the step list shape
 * via the use-case's wire-level zod + Domain `parseSchedulePolicySteps`.
 * Manager 403 emits `f8_role_violation_blocked` audit via
 * `requireRenewalAdminContext('write')`.
 *
 * Audit: `renewal_schedule_policy_updated` is emitted inside the
 * use-case (atomic with the upsert per Constitution Principle VIII).
 */
import { type NextRequest } from 'next/server';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import {
  errorResponse,
  successResponse,
  requireRenewalAdminContext,
} from '@/lib/renewals-route-helpers';
import {
  TIER_BUCKETS,
  updateSchedulePolicy,
  makeRenewalsDeps,
  reminderStepToJson,
  type TierBucket,
} from '@/modules/renewals';
import { assertNever } from '@/lib/assert-never';

/**
 * This route's entry in the F8 errorId taxonomy (`F8ErrorId` in
 * `src/lib/renewals-route-helpers.ts`, documented in
 * `docs/runbooks/audit-emit-loss.md`). Every line this route logs about a
 * failure carries it with a suffix — `.CONTEXT_RESOLUTION_FAILED` from the
 * admin gate before the try block, `.SERVER_ERROR` from the use-case's own
 * error variant, `.UNEXPECTED` from the outer catch — so
 * an SRE rule keyed on `F8.SCHEDULES_WRITE.*` matches every 500 this route
 * can produce.
 */
const ERROR_ID = 'F8.SCHEDULES_WRITE';

const StepSchema = z.object({
  step_id: z.string().min(1).max(100),
  offset_days: z.number().int(),
  channel: z.enum(['email', 'task']),
  template_id: z.string().min(1).max(200).optional(),
  task_type: z.string().min(1).max(100).optional(),
  assignee_role: z.enum(['admin', 'manager', 'executive_director']).optional(),
});

const BodySchema = z.object({
  steps: z.array(StepSchema).min(1).max(20),
});

export async function PUT(
  request: NextRequest,
  context: { params: Promise<{ tierBucket: string }> },
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
    'settings.renewal_schedules',
    ERROR_ID,
  );
  if ('response' in ctx) return ctx.response;

  const { tierBucket: rawTierBucket } = await context.params;
  if (!(TIER_BUCKETS as readonly string[]).includes(rawTierBucket)) {
    return errorResponse({
      status: 404,
      code: 'tier_bucket_not_found',
      correlationId: ctx.correlationId,
    });
  }
  const tierBucket = rawTierBucket as TierBucket;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return errorResponse({
      status: 400,
      code: 'invalid_body',
      correlationId: ctx.correlationId,
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
    const result = await updateSchedulePolicy(deps, {
      tenantId: tenantCtx.slug,
      tierBucket,
      steps: parsed.data.steps,
      actorUserId: ctx.current.user.id,
      // rbac-narrow-ok: stamps the LITERAL role into the audit row; the
      // gate above already decided admission (016 post-ship finding #3).
      actorRole: ctx.current.user.role === 'super_admin' ? 'super_admin' : 'admin',
      requestId: ctx.requestId,
      correlationId: ctx.correlationId,
    });
    if (!result.ok) {
      switch (result.error.kind) {
        case 'invalid_input':
          return errorResponse({
            status: 400,
            code: 'invalid_input',
            correlationId: ctx.correlationId,
            details: { message: result.error.message },
          });
        case 'invalid_steps':
          return errorResponse({
            status: 422,
            code: 'invalid_steps',
            correlationId: ctx.correlationId,
            details: { error: result.error.error },
          });
        case 'server_error':
          // K1-C7: server_error variant from updateSchedulePolicy.
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
            'admin.renewals.schedules_write_server_error',
          );
          return errorResponse({
            status: 500,
            code: 'server_error',
            correlationId: ctx.correlationId,
          });
        default: {
          // K1-E1: exhaustiveness pin.
          // Review of this branch — this arm RETURNED the 500, so the one
          // failure mode that means "two deploys disagree" produced a 500
          // with no log line at all, while the docblock above promised an
          // SRE rule keyed on `${ERROR_ID}.*` matches every 500 this route
          // can produce. Throwing lands it in the outer catch, which does
          // carry that id.
          return assertNever(
            result.error,
            `${ERROR_ID}: unhandled error kind '${
              (result.error as { readonly kind: string }).kind
            }'`,
          );
        }
      }
    }
    return successResponse(
      {
        tier_bucket: result.value.policy.tierBucket,
        updated_at: result.value.policy.updatedAt,
        steps: result.value.policy.steps.map(reminderStepToJson),
        change_diff: {
          added: result.value.changeDiff.added,
          removed: result.value.changeDiff.removed,
          unchanged: result.value.changeDiff.unchanged,
        },
      },
      ctx.correlationId,
    );
  } catch (e) {
    logger.error(
      {
        errorId: `${ERROR_ID}.UNEXPECTED`,
        // K12-3 (REL-K-1): pass the Error instance so pino's `err`
        // serializer captures stack + type.
        err: e instanceof Error ? e : new Error(String(e)),
        correlationId: ctx.correlationId,
        tierBucket,
        tenantId: tenantCtx.slug,
      },
      'update-schedule-policy route unexpected error',
    );
    return errorResponse({
      status: 500,
      code: 'server_error',
      correlationId: ctx.correlationId,
    });
  }
}
