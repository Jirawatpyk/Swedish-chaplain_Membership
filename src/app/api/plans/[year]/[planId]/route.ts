/**
 * GET /api/plans/[year]/[planId] (T079, US1 + US3, contracts/plans-api.md § 2) +
 * PATCH /api/plans/[year]/[planId] (T118, US3, contracts/plans-api.md § 4) +
 * DELETE /api/plans/[year]/[planId] (T134, US4 FR-010).
 *
 * GET: returns one plan or 404. The 404 path is deliberately identical
 * for "plan never existed" and "plan belongs to a different tenant" —
 * the RLS layer silently filters cross-tenant rows, and the use case
 * appends a `plan_not_found` audit event that the F13 scan correlates
 * offline. Request path NEVER runs a BYPASS RLS query (critique E6).
 *
 * PATCH: admin-only partial update. Requires `Idempotency-Key` header.
 * Maps use-case error variants to HTTP: `prior_year_locked_fields`
 * → 422 with `details.locked_fields` + `suggested_action`,
 * `not_found` → 404, `invalid_body` → 400,
 * `partnership_corporate_mismatch` → 422,
 * `idempotency_conflict` → 409.
 *
 * DELETE: admin-only soft-delete. Requires `Idempotency-Key`. Maps
 * `has_active_members` → 409 with `details.affected_member_count`,
 * `not_found` → 404, `idempotency_conflict` → 409.
 */
import { NextResponse, type NextRequest } from 'next/server';
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
import {
  asPlanSlug,
  asPlanYear,
  getPlan,
  softDeletePlan,
  updatePlan,
} from '@/modules/plans';
import { buildPlansDeps } from '@/modules/plans/plans-deps';
import { serialisePlan } from '@/app/api/plans/_serialise-plan';
import { planPathSchema as pathSchema } from '@/app/api/plans/_schemas';
import { readOnlyModeResponse } from '@/app/api/plans/_read-only-guard';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ year: string; planId: string }> },
): Promise<NextResponse> {
  const ctx = await requireAdminContext(request, {
    resource: 'plan',
    action: 'read',
  });
  if ('response' in ctx) return ctx.response;

  const raw = await params;
  const parsed = pathSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: {
          code: 'invalid_path',
          message: 'Invalid path parameters.',
          details: { issues: parsed.error.issues },
        },
      },
      { status: 400 },
    );
  }

  const tenant = resolveTenantFromRequest(request);
  const deps = buildPlansDeps(tenant);

  const result = await getPlan(
    {
      planId: asPlanSlug(parsed.data.planId),
      year: asPlanYear(parsed.data.year),
    },
    {
      tenant: deps.tenant,
      planRepo: deps.planRepo,
      audit: deps.audit,
      actorUserId: ctx.current.user.id,
      requestId: ctx.requestId,
      sourceIp: ctx.sourceIp,
      method: 'GET',
      route: `/api/plans/${parsed.data.year}/${parsed.data.planId}`,
    },
  );

  if (result.ok) {
    return NextResponse.json(serialisePlan(result.value), { status: 200 });
  }

  if (result.error.type === 'not_found') {
    return NextResponse.json(
      { error: { code: 'not_found', message: 'Plan not found.' } },
      { status: 404 },
    );
  }

  if (result.error.type === 'server_error') {
    logger.error(
      { requestId: ctx.requestId, err: result.error },
      'get-plan: server error',
    );
    return NextResponse.json(
      { error: { code: 'server_error', message: 'Internal server error.' } },
      { status: 500 },
    );
  }

  // Exhaustive fallback — should not be reachable
  logger.error(
    { requestId: ctx.requestId },
    'get-plan: unhandled error variant',
  );
  return NextResponse.json(
    { error: { code: 'server_error', message: 'Internal server error.' } },
    { status: 500 },
  );
}

// ---------------------------------------------------------------------------
// PATCH /api/plans/[year]/[planId] — update plan (T118, US3)
// ---------------------------------------------------------------------------

export async function PATCH(
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

  // Parse body
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

  // Idempotency-Key required
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
    rawBody,
    `PATCH /api/plans/${parsedPath.data.year}/${parsedPath.data.planId}`,
  );
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
  // Post-ship R6 C3 — 503 on Redis outage.
  {
    const reserved = await reserveIdempotencyRecord(tenant, keyCheck.key, bodyHash);
    if (!reserved.ok) {
      return NextResponse.json(
        {
          error: {
            code: 'idempotency_reservation_failed',
            message:
              'Idempotency reservation temporarily unavailable. Retry shortly.',
          },
        },
        { status: 503, headers: { 'Retry-After': '5' } },
      );
    }
  }

  const deps = buildPlansDeps(tenant);

  const result = await updatePlan(
    {
      planId: asPlanSlug(parsedPath.data.planId),
      year: asPlanYear(parsedPath.data.year),
      patch: rawBody as Parameters<typeof updatePlan>[0]['patch'],
      actorUserId: ctx.current.user.id,
      requestId: ctx.requestId,
      sourceIp: ctx.sourceIp ?? null,
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
      status: 200,
      body,
    });
    return NextResponse.json(body, { status: 200 });
  }

  switch (result.error.type) {
    case 'invalid_body':
      return NextResponse.json(
        {
          error: {
            code: 'invalid_body',
            message: 'Patch body failed validation.',
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
    case 'not_found':
      return NextResponse.json(
        { error: { code: 'not_found', message: 'Plan not found.' } },
        { status: 404 },
      );
    case 'prior_year_locked_fields':
      return NextResponse.json(
        {
          error: {
            code: 'prior_year_locked_fields',
            message:
              'Cannot edit pricing, eligibility, benefits, or scope on a previous-year plan.',
            details: {
              locked_fields: result.error.locked_fields,
              suggested_action: 'clone_to_current_year',
              clone_action_path: '/api/plans/clone',
            },
          },
        },
        { status: 422 },
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
        'update-plan: audit write failed',
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
        'update-plan: unhandled error',
      );
      return NextResponse.json(
        { error: { code: 'server_error', message: 'Internal server error.' } },
        { status: 500 },
      );
  }
}

// ---------------------------------------------------------------------------
// DELETE /api/plans/[year]/[planId] — soft-delete plan (T134, US4)
// ---------------------------------------------------------------------------

export async function DELETE(
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
    `DELETE /api/plans/${parsedPath.data.year}/${parsedPath.data.planId}`,
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
  // Post-ship R6 C3 — 503 on Redis outage.
  {
    const reserved = await reserveIdempotencyRecord(tenant, keyCheck.key, bodyHash);
    if (!reserved.ok) {
      return NextResponse.json(
        {
          error: {
            code: 'idempotency_reservation_failed',
            message:
              'Idempotency reservation temporarily unavailable. Retry shortly.',
          },
        },
        { status: 503, headers: { 'Retry-After': '5' } },
      );
    }
  }

  const deps = buildPlansDeps(tenant);

  const result = await softDeletePlan(
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
      audit: deps.audit,
      clock: deps.clock,
      members: deps.members,
    },
  );

  if (result.ok) {
    const body = serialisePlan(result.value);
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
    case 'has_active_members':
      return NextResponse.json(
        {
          error: {
            code: 'plan_has_active_members',
            message:
              'This plan has active members attached and cannot be deleted.',
            details: { affected_member_count: result.error.count },
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
        'soft-delete-plan: audit write failed',
      );
      return NextResponse.json(
        { error: { code: 'audit_failed', message: 'Audit trail write failed.' } },
        { status: 500 },
      );
    case 'server_error':
    default:
      logger.error(
        { requestId: ctx.requestId, err: result.error },
        'soft-delete-plan: unhandled error',
      );
      return NextResponse.json(
        { error: { code: 'server_error', message: 'Internal server error.' } },
        { status: 500 },
      );
  }
}
