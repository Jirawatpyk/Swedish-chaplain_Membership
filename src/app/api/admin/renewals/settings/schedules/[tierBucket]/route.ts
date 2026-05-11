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

  const ctx = await requireRenewalAdminContext(request, 'write');
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
      actorRole: 'admin',
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
          return errorResponse({
            status: 500,
            code: 'server_error',
            correlationId: ctx.correlationId,
          });
        default: {
          // K1-E1: exhaustiveness pin.
          const _exhaustive: never = result.error;
          void _exhaustive;
          return errorResponse({
            status: 500,
            code: 'server_error',
            correlationId: ctx.correlationId,
          });
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
