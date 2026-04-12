/**
 * POST /api/plans/[year]/[planId]/undelete (T135, US4 AS4).
 *
 * Admin-only. Clears `deleted_at` and forces `is_active = false` per
 * AS4 (undelete target state is always Inactive — never directly
 * Active). Same idempotency + error-mapping contract as the other US4
 * state-mutation endpoints.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { requireAdminContext } from '@/lib/admin-context';
import { rememberIdempotentResponse } from '@/lib/idempotency';
import { logger } from '@/lib/logger';
import { undeletePlan, asPlanSlug, asPlanYear } from '@/modules/plans';
import { buildPlansDeps } from '@/modules/plans/plans-deps';
import { serialisePlan } from '@/app/api/plans/_serialise-plan';
import { planPathSchema as pathSchema } from '@/app/api/plans/_schemas';
import { runIdempotencyGuard } from '@/app/api/plans/_idempotency-guard';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ year: string; planId: string }> },
): Promise<NextResponse> {
  const ctx = await requireAdminContext(request, {
    resource: 'plan',
    action: 'write',
  });
  if ('response' in ctx) return ctx.response;

  const raw = await params;
  const parsedPath = pathSchema.safeParse(raw);
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

  const guard = await runIdempotencyGuard(
    request,
    `POST /api/plans/${parsedPath.data.year}/${parsedPath.data.planId}/undelete`,
  );
  if (guard.kind === 'response') return guard.response;

  const deps = buildPlansDeps(guard.tenant);

  const result = await undeletePlan(
    {
      planId: asPlanSlug(parsedPath.data.planId),
      year: asPlanYear(parsedPath.data.year),
      actorUserId: ctx.current.user.id,
      requestId: ctx.requestId,
      sourceIp: ctx.sourceIp ?? null,
      idempotencyKey: guard.key,
    },
    {
      tenant: deps.tenant,
      planRepo: deps.planRepo,
      feeConfigRepo: deps.feeConfigRepo,
      audit: deps.audit,
      clock: deps.clock,
      members: deps.members,
    },
  );

  if (result.ok) {
    const body = serialisePlan(result.value);
    await rememberIdempotentResponse(guard.tenant, guard.key, guard.bodyHash, {
      status: 200,
      body,
    });
    return NextResponse.json(body, { status: 200 });
  }

  switch (result.error.type) {
    case 'not_found':
      return NextResponse.json(
        { error: { code: 'not_found', message: 'Plan not found.' } },
        { status: 404 },
      );
    case 'idempotency_conflict':
      return NextResponse.json(
        {
          error: {
            code: 'idempotency_conflict',
            message: 'Idempotency-Key was reused with a different body.',
          },
        },
        { status: 409 },
      );
    case 'audit_failed':
      logger.error(
        { requestId: ctx.requestId, err: result.error },
        'undelete-plan: audit write failed',
      );
      return NextResponse.json(
        { error: { code: 'audit_failed', message: 'Audit trail write failed.' } },
        { status: 500 },
      );
    case 'server_error':
    default:
      logger.error(
        { requestId: ctx.requestId, err: result.error },
        'undelete-plan: unhandled error',
      );
      return NextResponse.json(
        { error: { code: 'server_error', message: 'Internal server error.' } },
        { status: 500 },
      );
  }
}
