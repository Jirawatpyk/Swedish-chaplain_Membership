/**
 * F8 Phase 4 Wave I1b · T084 — GET `/api/admin/renewals/settings/schedules`.
 *
 * Read all 5 tier-bucket schedule policies for the admin schedule
 * editor (T086) per `contracts/admin-renewals-api.md` § 5.
 *
 * Authz: admin OR manager (read-only access for managers per US2 RBAC
 * Q2 round 2 — managers see the schedule but cannot mutate).
 * Kill-switch: 503 `feature_disabled` when `FEATURE_F8_RENEWALS=false`.
 * Response shape: snake_case per contract; the use-case returns
 * camelCase from Domain entity which is mapped at the boundary.
 */
import { type NextRequest } from 'next/server';
import { randomUUID } from 'node:crypto';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import {
  errorResponse,
  successResponse,
  requireRenewalAdminContext,
} from '@/lib/renewals-route-helpers';
import {
  loadSchedulePolicies,
  makeRenewalsDeps,
  reminderStepToJson,
} from '@/modules/renewals';

/**
 * This route's entry in the F8 errorId taxonomy (`F8ErrorId` in
 * `src/lib/renewals-route-helpers.ts`, documented in
 * `docs/runbooks/audit-emit-loss.md`). Every line this route logs about a
 * failure carries it, so an SRE rule keyed on `F8.SCHEDULES_READ.*` matches every failure
 * this route can produce.
 *
 * Which suffixes exist here is whatever the code below emits — deliberately
 * NOT listed. Four rounds of review found an enumerated list false as soon as
 * a suffix moved: naming two was wrong once `.SERVER_ERROR` landed, and naming
 * `.SERVER_ERROR` was wrong for the routes that have no `server_error` arm.
 * `pnpm check:f8-error-id` is what holds the claim above true.
 */
const ERROR_ID = 'F8.SCHEDULES_READ';

export async function GET(request: NextRequest) {
  if (!env.features.f8Renewals) {
    return errorResponse({
      status: 503,
      code: 'feature_disabled',
      correlationId: randomUUID(),
    });
  }

  const ctx = await requireRenewalAdminContext(
    request,
    'read',
    'settings.renewal_schedules',
    ERROR_ID,
  );
  if ('response' in ctx) return ctx.response;

  const tenantCtx = resolveTenantFromRequest(request);
  const deps = makeRenewalsDeps(tenantCtx.slug);

  try {
    const result = await loadSchedulePolicies(deps, {
      tenantId: tenantCtx.slug,
    });
    if (!result.ok) {
      return errorResponse({
        status: 400,
        code: 'invalid_input',
        correlationId: ctx.correlationId,
        details: { message: result.error.message },
      });
    }
    return successResponse(
      {
        policies: result.value.policies.map((p) => ({
          tier_bucket: p.tierBucket,
          steps: p.steps.map(reminderStepToJson),
          updated_at: p.updatedAt,
        })),
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
        tenantId: tenantCtx.slug,
      },
      'load-schedule-policies route unexpected error',
    );
    return errorResponse({
      status: 500,
      code: 'server_error',
      correlationId: ctx.correlationId,
    });
  }
}
