/**
 * POST /api/plans/[year]/[planId]/deactivate (T133, US4 FR-009).
 *
 * Mirror of the /activate handler with the opposite use case. See
 * /activate/route.ts for the idempotency + error-mapping rationale.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { requireAdminContext } from '@/lib/admin-context';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { rememberIdempotentResponse } from '@/lib/idempotency';
import { logger } from '@/lib/logger';
import { deactivatePlan, asPlanSlug, asPlanYear } from '@/modules/plans';
import { buildPlansDeps } from '@/modules/plans/plans-deps';
import { serialisePlan } from '@/app/api/plans/_serialise-plan';
import { planPathSchema as pathSchema } from '@/app/api/plans/_schemas';
import { runIdempotencyGuard } from '@/app/api/plans/_idempotency-guard';
import { readOnlyModeResponse } from '@/app/api/plans/_read-only-guard';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ year: string; planId: string }> },
): Promise<NextResponse> {
  const ctx = await requireAdminContext(request, {
    resource: 'plan',
    action: 'write',
  });
  if ('response' in ctx) return ctx.response;

  // R2 Batch 3j (R2-S8) — emergency maintenance freeze short-circuit.
  const roResp = readOnlyModeResponse();
  if (roResp) return roResp;

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

  const tenant = resolveTenantFromRequest(request);
  const guard = await runIdempotencyGuard(
    request,
    tenant,
    `POST /api/plans/${parsedPath.data.year}/${parsedPath.data.planId}/deactivate`,
  );
  if (guard.kind === 'response') return guard.response;

  const deps = buildPlansDeps(tenant);

  const result = await deactivatePlan(
    {
      planId: asPlanSlug(parsedPath.data.planId),
      year: asPlanYear(parsedPath.data.year),
      actorUserId: ctx.current.user.id,
      requestId: ctx.requestId,
      sourceIp: ctx.sourceIp ?? null,
    },
    {
      tenant: deps.tenant,
      planRepo: deps.planRepo,
      audit: deps.audit,
      clock: deps.clock,
      members: deps.members,
    },
  );

  if (result.ok) {
    const body = serialisePlan(result.value);
    await rememberIdempotentResponse(tenant, guard.key, guard.bodyHash, {
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
    case 'audit_failed':
      logger.error(
        { requestId: ctx.requestId, err: result.error },
        'deactivate-plan: audit write failed',
      );
      return NextResponse.json(
        { error: { code: 'audit_failed', message: 'Audit trail write failed.' } },
        { status: 500 },
      );
    case 'server_error':
    default:
      logger.error(
        { requestId: ctx.requestId, err: result.error },
        'deactivate-plan: unhandled error',
      );
      return NextResponse.json(
        { error: { code: 'server_error', message: 'Internal server error.' } },
        { status: 500 },
      );
  }
}
