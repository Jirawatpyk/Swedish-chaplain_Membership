/**
 * POST /api/admin/scheduled-plan-changes/[id]/cancel — admin-only
 * route for cancelling a pending scheduled plan change.
 *
 * Behaviour:
 *   - Admin RBAC (`requireAdminContext('plan', 'write')`).
 *   - `Idempotency-Key` header required (mirrors F2 mutation routes).
 *   - Body: `{ memberId: uuid, effectiveAtCycleId: uuid, reason?: string|null }`
 *     (zod-validated). The actor identity comes from the auth ctx via
 *     the use-case's `deps.actorUserId` — input does not accept a
 *     separate `cancelledByUserId`.
 *   - Path param `id` (scheduledChangeId) is the primary-key lookup
 *     handled by the use-case via the `findById` repo method.
 *
 * Error mapping:
 *   - invalid_input (zod path or body) → 400
 *   - not_found                         → 404
 *   - already_terminal                  → 409
 *   - audit_failed                      → 200 + X-Audit-Backfill-Required: 1
 *                                        (the row IS already cancelled;
 *                                        surfacing 500 mis-leads the UI
 *                                        into a retry on a successful
 *                                        mutation. Mirrors F5
 *                                        `payment_environment_mismatch`
 *                                        UX pattern: 200 body +
 *                                        diagnostic header. Alert
 *                                        routing picks up the
 *                                        F2.PLAN_CHANGE.CANCEL_AUDIT_*
 *                                        errorId on the logger.error
 *                                        emit.)
 *   - server_error                      → 500
 *   - idempotency_conflict              → 409
 *   - idempotency_reservation_failed    → 503 + Retry-After: 5
 *
 * No admin UI surface in this batch — a future Round-4+ feature wires
 * a "Cancel pending change" button in the member-detail timeline.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { requireAdminContext } from '@/lib/admin-context';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { rememberIdempotentResponse } from '@/lib/idempotency';
import { logger } from '@/lib/logger';
import { planMetrics } from '@/lib/metrics';
import { cancelScheduledPlanChange } from '@/modules/plans';
import {
  drizzleScheduledPlanChangeRepo,
  planAuditAdapter,
} from '@/modules/plans/server';
import { runIdempotencyGuard } from '@/app/api/plans/_idempotency-guard';
import { readOnlyModeResponse } from '@/app/api/plans/_read-only-guard';

// scheduledChangeId is a Postgres uuid column. Reject non-UUIDs with
// 400 invalid_path instead of letting them slip to the Drizzle
// adapter where SQLSTATE 22P02 would surface as 500.
const pathSchema = z.object({
  id: z.string().uuid(),
});

const bodySchema = z.object({
  memberId: z.string().uuid(),
  effectiveAtCycleId: z.string().uuid(),
  reason: z.string().max(500).nullable().optional(),
});

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  // RBAC — admin-only (same gate as other plan mutation routes).
  const ctx = await requireAdminContext(request, {
    resource: 'plan',
    action: 'write',
  });
  if ('response' in ctx) return ctx.response;

  // Emergency maintenance freeze short-circuit.
  const roResp = readOnlyModeResponse();
  if (roResp) return roResp;

  // Path validation.
  const rawPath = await params;
  const parsedPath = pathSchema.safeParse(rawPath);
  if (!parsedPath.success) {
    return NextResponse.json(
      {
        error: {
          code: 'invalid_path',
          message: 'Invalid path parameters.',
          details: { issues: parsedPath.error.issues },
        },
      },
      { status: 400 },
    );
  }

  // Body parse + validation.
  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json(
      { error: { code: 'invalid_body', message: 'Invalid JSON body.' } },
      { status: 400 },
    );
  }
  const parsedBody = bodySchema.safeParse(rawBody);
  if (!parsedBody.success) {
    return NextResponse.json(
      {
        error: {
          code: 'invalid_body',
          message: 'Invalid request body.',
          details: { issues: parsedBody.error.issues },
        },
      },
      { status: 400 },
    );
  }

  // Idempotency + tenant resolution (shared guard from `_idempotency-guard.ts`).
  const tenant = resolveTenantFromRequest(request);
  const guard = await runIdempotencyGuard(
    request,
    tenant,
    `POST /api/admin/scheduled-plan-changes/${parsedPath.data.id}/cancel`,
    parsedBody.data,
  );
  if (guard.kind === 'response') return guard.response;

  // Use-case invocation.
  const result = await cancelScheduledPlanChange(
    {
      tenant,
      repo: drizzleScheduledPlanChangeRepo,
      audit: planAuditAdapter,
      actorUserId: ctx.current.user.id,
      requestId: ctx.requestId,
      sourceIp: ctx.sourceIp ?? null,
    },
    {
      scheduledChangeId: parsedPath.data.id,
      memberId: parsedBody.data.memberId,
      effectiveAtCycleId: parsedBody.data.effectiveAtCycleId,
      reason: parsedBody.data.reason ?? null,
    },
  );

  if (result.ok) {
    const body = {
      scheduled_change_id: result.value.scheduledChangeId,
      status: result.value.status,
      cancelled_at: result.value.cancelledAt,
    };
    await rememberIdempotentResponse(tenant, guard.key, guard.bodyHash, {
      status: 200,
      body,
    });
    return NextResponse.json(body, { status: 200 });
  }

  switch (result.error.code) {
    case 'invalid_input':
      return NextResponse.json(
        {
          error: {
            code: 'invalid_input',
            message: `Invalid input field: ${result.error.field}`,
          },
        },
        { status: 400 },
      );
    case 'not_found':
      return NextResponse.json(
        {
          error: {
            code: 'not_found',
            message: 'Scheduled plan change not found.',
          },
        },
        { status: 404 },
      );
    case 'already_terminal':
      return NextResponse.json(
        {
          error: {
            code: 'already_terminal',
            message: `Scheduled plan change is already ${result.error.status}.`,
            details: { status: result.error.status },
          },
        },
        { status: 409 },
      );
    case 'audit_failed': {
      // Attach errorId mapped from the preserved auditErrorType
      // discriminator. Alert routing can distinguish zod-rejection
      // (deploy-skew) from DB-rejection (column drift / pgEnum drift
      // / RLS).
      logger.error(
        {
          errorId:
            result.error.auditErrorType === 'invalid_payload'
              ? 'F2.PLAN_CHANGE.CANCEL_AUDIT_INVALID_PAYLOAD'
              : 'F2.PLAN_CHANGE.CANCEL_AUDIT_PERSIST_FAILED',
          requestId: ctx.requestId,
          err: { ...result.error, transitioned: undefined },
        },
        'cancel-scheduled-plan-change: audit write failed',
      );
      // R4-I2 — emit metric counter so SRE backfill SLO can be graphed
      // (log-based attribution would be lossy on sampled pipelines).
      planMetrics.cancelAuditBackfillRequired(
        tenant.slug,
        result.error.auditErrorType,
      );
      // The row IS cancelled (transitionStatus
      // landed). Return 200 with the cancelled-row body + diagnostic
      // header so the UI does not retry a successful mutation. SRE
      // backfills the audit row out-of-band by alerting on the errorId
      // above. Mirrors F5 `payment_environment_mismatch` UX pattern.
      const body = {
        scheduled_change_id: result.error.transitioned.scheduledChangeId,
        status: result.error.transitioned.status,
        cancelled_at: result.error.transitioned.cancelledAt,
      };
      const headers = new Headers({
        'X-Audit-Backfill-Required': '1',
        'X-Audit-Error-Type': result.error.auditErrorType,
      });
      await rememberIdempotentResponse(tenant, guard.key, guard.bodyHash, {
        status: 200,
        body,
      });
      return NextResponse.json(body, { status: 200, headers });
    }
    case 'server_error':
    default: {
      // R4-I3 — emit a distinct errorId for the inner-recheck failure
      // cascade so SRE can correlate the original transitionStatus
      // error with the recheck-itself-failed signal (typically RLS /
      // connection-pool exhaustion).
      if (
        'recheckErrMessage' in result.error &&
        result.error.recheckErrMessage !== undefined
      ) {
        logger.warn(
          {
            errorId: 'F2.PLAN_CHANGE.CANCEL_RECHECK_FAILED',
            requestId: ctx.requestId,
            recheckErrMessage: result.error.recheckErrMessage,
          },
          'cancel-scheduled-plan-change: TOCTOU recheck failed; surfacing original transitionStatus error',
        );
      }
      logger.error(
        { requestId: ctx.requestId, err: result.error },
        'cancel-scheduled-plan-change: unhandled error',
      );
      return NextResponse.json(
        {
          error: { code: 'server_error', message: 'Internal server error.' },
        },
        { status: 500 },
      );
    }
  }
}
