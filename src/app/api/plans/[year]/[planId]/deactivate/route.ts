/**
 * POST /api/plans/[year]/[planId]/deactivate (T133, US4 FR-009).
 *
 * Mirror of the /activate handler with the opposite use case. See
 * /activate/route.ts for the idempotency + error-mapping rationale.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { requireAdminContext } from '@/lib/admin-context';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import {
  parseIdempotencyKey,
  classifyIdempotencyRequest,
  reserveIdempotencyRecord,
  rememberIdempotentResponse,
  hashRequestBody,
} from '@/lib/idempotency';
import { logger } from '@/lib/logger';
import { deactivatePlan, asPlanSlug, asPlanYear } from '@/modules/plans';
import { buildPlansDeps } from '@/modules/plans/plans-deps';

const pathSchema = z.object({
  year: z.coerce.number().int().min(2000).max(2100),
  planId: z.string().regex(/^[a-z0-9-]{1,63}$/, 'plan slug must match [a-z0-9-]{1,63}'),
});

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

  const keyCheck = parseIdempotencyKey(request.headers);
  if (!keyCheck.ok) {
    return NextResponse.json(
      {
        error: {
          code: 'missing_idempotency_key',
          message:
            keyCheck.reason === 'missing'
              ? 'Idempotency-Key header is required.'
              : 'Idempotency-Key header is malformed.',
        },
      },
      { status: 400 },
    );
  }

  const tenant = resolveTenantFromRequest(request);
  const bodyHash = hashRequestBody(
    {},
    `POST /api/plans/${parsedPath.data.year}/${parsedPath.data.planId}/deactivate`,
  );
  const classification = await classifyIdempotencyRequest(
    tenant,
    keyCheck.key,
    bodyHash,
  );
  if (classification.kind === 'replay') {
    return NextResponse.json(classification.previousResponse.body, {
      status: classification.previousResponse.status,
    });
  }
  if (classification.kind === 'conflict') {
    return NextResponse.json(
      {
        error: {
          code: 'idempotency_conflict',
          message: 'Idempotency-Key was reused with a different body.',
        },
      },
      { status: 409 },
    );
  }
  await reserveIdempotencyRecord(tenant, keyCheck.key, bodyHash);

  const deps = buildPlansDeps(tenant);

  const result = await deactivatePlan(
    {
      planId: asPlanSlug(parsedPath.data.planId),
      year: asPlanYear(parsedPath.data.year),
      actorUserId: ctx.current.user.id,
      requestId: ctx.requestId,
      sourceIp: ctx.sourceIp ?? null,
      idempotencyKey: keyCheck.key,
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
    const body = {
      plan_id: result.value.plan_id,
      plan_year: result.value.plan_year,
      plan_name: result.value.plan_name,
      description: result.value.description,
      sort_order: result.value.sort_order,
      plan_category: result.value.plan_category,
      member_type_scope: result.value.member_type_scope,
      annual_fee_minor_units: result.value.annual_fee_minor_units,
      includes_corporate_plan_id: result.value.includes_corporate_plan_id,
      min_turnover_minor_units: result.value.min_turnover_minor_units,
      max_turnover_minor_units: result.value.max_turnover_minor_units,
      max_duration_years: result.value.max_duration_years,
      max_member_age: result.value.max_member_age,
      benefit_matrix: result.value.benefit_matrix,
      is_active: result.value.is_active,
      deleted_at: result.value.deleted_at?.toISOString() ?? null,
      created_at: result.value.created_at.toISOString(),
      updated_at: result.value.updated_at.toISOString(),
    };
    await rememberIdempotentResponse(tenant, keyCheck.key, bodyHash, {
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
