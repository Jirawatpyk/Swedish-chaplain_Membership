/**
 * GET /api/plans (T078, US1, contracts/plans-api.md § 1) +
 * POST /api/plans (T102, US2, contracts/plans-api.md § 3).
 *
 * GET: admin + manager read-only list endpoint. Parses query params
 * with zod, resolves the tenant from the request, calls the `listPlans`
 * use case, and serialises the result envelope verbatim.
 *
 * POST: admin-only create endpoint. Requires `Idempotency-Key`
 * header, zod-validates the body, calls `createPlan` use case, and
 * returns 201 with the created plan envelope. `partnership_corporate_mismatch`
 * lands in the 422 bucket per contract; shape faults land in 400.
 *
 * RBAC: GET `'plan' + 'read'` (admin + manager); POST `'plan' + 'write'`
 * (admin only) — F2 RBAC extension T056. Member denied by the F1
 * role matrix.
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
import { listPlans, asPlanYear, createPlan } from '@/modules/plans';
import { buildPlansDeps } from '@/modules/plans/plans-deps';
import { serialisePlan } from './_serialise-plan';

const querySchema = z.object({
  year: z.coerce.number().int().min(2000).max(2100).optional(),
  category: z.enum(['corporate', 'partnership']).optional(),
  q: z.string().trim().min(1).max(200).optional(),
  activeOnly: z.coerce.boolean().optional(),
  showDeleted: z.coerce.boolean().optional(),
});

export async function GET(request: NextRequest): Promise<NextResponse> {
  // Read-level access — admin + manager both allowed
  const ctx = await requireAdminContext(request, {
    resource: 'plan',
    action: 'read',
  });
  if ('response' in ctx) return ctx.response;

  const url = new URL(request.url);
  const raw: Record<string, string> = {};
  for (const [k, v] of url.searchParams.entries()) {
    raw[k] = v;
  }
  const parsed = querySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: {
          code: 'invalid_query',
          message: 'Invalid query parameters.',
          details: { issues: parsed.error.issues },
        },
      },
      { status: 400 },
    );
  }

  const tenant = resolveTenantFromRequest(request);
  const deps = buildPlansDeps(tenant);

  // Build filter sparsely — exactOptionalPropertyTypes: true rejects
  // explicit `undefined` values on optional fields, so we use
  // conditional spread to only include defined fields.
  const filter: Parameters<typeof listPlans>[0]['filter'] = {
    ...(parsed.data.year !== undefined && { year: asPlanYear(parsed.data.year) }),
    ...(parsed.data.category !== undefined && { category: parsed.data.category }),
    ...(parsed.data.q !== undefined && { q: parsed.data.q }),
    ...(parsed.data.activeOnly !== undefined && { activeOnly: parsed.data.activeOnly }),
    ...(parsed.data.showDeleted !== undefined && { showDeleted: parsed.data.showDeleted }),
  };

  const result = await listPlans(
    { filter },
    {
      tenant: deps.tenant,
      planRepo: deps.planRepo,
      taxPolicy: deps.taxPolicy,
      clock: deps.clock,
    },
  );

  if (result.ok) {
    return NextResponse.json(result.value, { status: 200 });
  }

  switch (result.error.type) {
    case 'fee_config_missing':
      logger.error(
        { requestId: ctx.requestId, tenant: tenant.slug },
        'list-plans: fee_config row missing for tenant',
      );
      return NextResponse.json(
        {
          error: {
            code: 'fee_config_missing',
            message: 'Tenant fee configuration has not been initialised.',
          },
        },
        { status: 500 },
      );
    case 'server_error':
    default:
      logger.error(
        { requestId: ctx.requestId, err: result.error },
        'list-plans: unhandled error',
      );
      return NextResponse.json(
        { error: { code: 'server_error', message: 'Internal server error.' } },
        { status: 500 },
      );
  }
}

// ---------------------------------------------------------------------------
// POST /api/plans — create plan (T102, US2)
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest): Promise<NextResponse> {
  // Admin-only write gate
  const ctx = await requireAdminContext(request, {
    resource: 'plan',
    action: 'write',
  });
  if ('response' in ctx) return ctx.response;

  // Parse body first (needed for hash + zod)
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

  // Idempotency-Key header is required by contract
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

  // Classify the request for replay/conflict
  const bodyHash = hashRequestBody(rawBody, 'POST /api/plans');
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
  // first — reserve the slot so concurrent workers conflict
  await reserveIdempotencyRecord(tenant, keyCheck.key, bodyHash);

  const deps = buildPlansDeps(tenant);

  const sourceIp = ctx.sourceIp ?? null;
  const result = await createPlan(
    {
      input: rawBody as Parameters<typeof createPlan>[0]['input'],
      actorUserId: ctx.current.user.id,
      requestId: ctx.requestId,
      sourceIp,
      idempotencyKey: keyCheck.key,
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
            message: 'Plan body failed validation.',
            details: { issues: result.error.issues },
          },
        },
        { status: 400 },
      );
    case 'partnership_corporate_mismatch':
      return NextResponse.json(
        {
          error: {
            code: 'partnership_corporate_mismatch',
            message: 'Partnership/corporate integrity rule violated.',
            details: { issues: result.error.issues },
          },
        },
        { status: 422 },
      );
    case 'duplicate_plan':
      return NextResponse.json(
        {
          error: {
            code: 'duplicate_plan',
            message:
              'A plan with the same plan_id and plan_year already exists for this tenant.',
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
    case 'audit_failed': {
      // create-plan inserts the row BEFORE emitting audit, so a failure
      // here means the plan IS in the database but the audit trail is
      // missing. Surface plan_id in the structured log so on-call can
      // backfill the audit row from the request payload — the previous
      // message claimed "NOT persisted" which was a lie and triggered
      // client retries → duplicate_plan 409.
      const planRef =
        rawBody && typeof rawBody === 'object'
          ? {
              plan_id: (rawBody as { plan_id?: unknown }).plan_id ?? null,
              plan_year: (rawBody as { plan_year?: unknown }).plan_year ?? null,
            }
          : { plan_id: null, plan_year: null };
      logger.error(
        { requestId: ctx.requestId, ...planRef, err: result.error },
        'create-plan: row persisted but audit write failed — operator backfill needed',
      );
      return NextResponse.json(
        {
          error: {
            code: 'audit_failed',
            message:
              'Plan was created but audit trail write failed. Contact ops.',
          },
        },
        { status: 500 },
      );
    }
    case 'server_error':
    default:
      logger.error(
        { requestId: ctx.requestId, err: result.error },
        'create-plan: unhandled error',
      );
      return NextResponse.json(
        { error: { code: 'server_error', message: 'Internal server error.' } },
        { status: 500 },
      );
  }
}
