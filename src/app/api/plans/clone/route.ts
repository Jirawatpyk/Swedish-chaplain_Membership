/**
 * POST /api/plans/clone (T103, US2, contracts/plans-api.md § 9).
 *
 * Admin-only bulk clone. Takes `{source_year, target_year,
 * activate_cloned}`, calls `clonePlansToYear`, returns a summary
 * envelope with the list of new plan IDs.
 *
 * Requires `Idempotency-Key` header. Refuses to overwrite a populated
 * target year (409 target_year_populated) and refuses to clone an
 * empty source year (409 source_year_empty).
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
import { clonePlansToYear, asPlanYear } from '@/modules/plans';
import { buildPlansDeps } from '@/modules/plans/plans-deps';

const bodySchema = z.object({
  source_year: z.number().int().min(2000).max(2100),
  target_year: z.number().int().min(2000).max(2100),
  activate_cloned: z.boolean().optional(),
});

export async function POST(request: NextRequest): Promise<NextResponse> {
  // Admin-only clone gate (uses the existing 'plan' + 'clone' RBAC slot)
  const ctx = await requireAdminContext(request, {
    resource: 'plan',
    action: 'clone',
  });
  if ('response' in ctx) return ctx.response;

  // Parse body before validating idempotency header so we can hash it
  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json(
      {
        error: {
          code: 'invalid_body',
          message: 'Request body must be valid JSON.',
        },
      },
      { status: 400 },
    );
  }

  const parsed = bodySchema.safeParse(rawBody);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: {
          code: 'invalid_body',
          message: 'Invalid clone body.',
          details: { issues: parsed.error.issues },
        },
      },
      { status: 400 },
    );
  }
  if (parsed.data.source_year === parsed.data.target_year) {
    return NextResponse.json(
      {
        error: {
          code: 'invalid_body',
          message: 'source_year and target_year must differ.',
        },
      },
      { status: 400 },
    );
  }

  // Idempotency-Key header required
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
  const bodyHash = hashRequestBody(parsed.data, 'POST /api/plans/clone');
  const classification = await classifyIdempotencyRequest(
    tenant,
    keyCheck.key,
    bodyHash,
  );
  if (classification.kind === 'replay') {
    return NextResponse.json(
      classification.previousResponse.body,
      { status: classification.previousResponse.status },
    );
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
  const sourceIp = ctx.sourceIp ?? null;

  const result = await clonePlansToYear(
    {
      sourceYear: asPlanYear(parsed.data.source_year),
      targetYear: asPlanYear(parsed.data.target_year),
      activateCloned: parsed.data.activate_cloned ?? false,
      actorUserId: ctx.current.user.id,
      requestId: ctx.requestId,
      sourceIp,
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
      source_year: result.value.source_year,
      target_year: result.value.target_year,
      cloned_count: result.value.cloned_count,
      cloned_plan_ids: [...result.value.cloned_plan_ids],
    };
    await rememberIdempotentResponse(tenant, keyCheck.key, bodyHash, {
      status: 201,
      body,
    });
    return NextResponse.json(body, { status: 201 });
  }

  switch (result.error.type) {
    case 'invalid_body':
      return NextResponse.json(
        {
          error: {
            code: 'invalid_body',
            message: result.error.message,
          },
        },
        { status: 400 },
      );
    case 'target_year_populated':
      return NextResponse.json(
        {
          error: {
            code: 'target_year_populated',
            message:
              'Target year already has plans. Delete or move them before cloning.',
            details: { existing_count: result.error.existing_count },
          },
        },
        { status: 409 },
      );
    case 'source_year_empty':
      return NextResponse.json(
        {
          error: {
            code: 'source_year_empty',
            message: 'Source year has no plans to clone.',
          },
        },
        { status: 409 },
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
        'clone-plans: audit write failed',
      );
      return NextResponse.json(
        {
          error: {
            code: 'audit_failed',
            message: 'Audit trail write failed — clone may be partial.',
          },
        },
        { status: 500 },
      );
    case 'server_error':
    default:
      logger.error(
        { requestId: ctx.requestId, err: result.error },
        'clone-plans: unhandled error',
      );
      return NextResponse.json(
        { error: { code: 'server_error', message: 'Internal server error.' } },
        { status: 500 },
      );
  }
}
