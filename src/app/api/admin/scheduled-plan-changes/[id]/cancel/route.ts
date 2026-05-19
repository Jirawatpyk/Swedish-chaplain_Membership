/**
 * R2 Batch 3h (R2-S3) — POST /api/admin/scheduled-plan-changes/[id]/cancel.
 *
 * Admin-only route that gives `cancelScheduledPlanChange` (the use-case
 * landed in Batch 2c) its first production caller. Without this route,
 * the use-case shipped as dead-on-arrival code — Round 2 review flagged
 * it (R2-S3); this batch closes the finding by wiring an actual caller.
 *
 * Behaviour:
 *   - Admin RBAC (`requireAdminContext('plan', 'write')`).
 *   - `Idempotency-Key` header required (mirrors F2 mutation routes).
 *   - Body: `{ memberId: uuid, effectiveAtCycleId: uuid, reason?: string|null }`
 *     (zod-validated). `cancelledByUserId` is filled from the auth ctx.
 *   - Path param `id` (scheduledChangeId) is the primary-key lookup
 *     handled by the use-case via the new `findById` repo method.
 *
 * Error mapping:
 *   - invalid_input (zod path or body) → 400
 *   - not_found                         → 404
 *   - already_terminal                  → 409
 *   - audit_failed                      → 500
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
import { cancelScheduledPlanChange } from '@/modules/plans';
import {
  drizzleScheduledPlanChangeRepo,
  planAuditAdapter,
} from '@/modules/plans/server';
import { runIdempotencyGuard } from '@/app/api/plans/_idempotency-guard';

const pathSchema = z.object({
  id: z.string().min(1),
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
      cancelledByUserId: ctx.current.user.id,
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
    case 'audit_failed':
      logger.error(
        { requestId: ctx.requestId, err: result.error },
        'cancel-scheduled-plan-change: audit write failed',
      );
      return NextResponse.json(
        {
          error: {
            code: 'audit_failed',
            message: 'Audit trail write failed.',
          },
        },
        { status: 500 },
      );
    case 'server_error':
    default:
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
