/**
 * GET /api/fee-config (T148, US5, contracts/plans-api.md § 12) +
 * PATCH /api/fee-config (T148, US5, contracts/plans-api.md § 13).
 *
 * GET: admin + manager (read). Returns the tenant's fee config row.
 * PATCH: admin only. Requires `Idempotency-Key` header. Editable fields
 *        `vat_rate` and `registration_fee_minor_units`; `currency_code`
 *        is immutable in F2 once plans exist (critique R1) — returns
 *        422 `currency_code_immutable_in_f2` with `details` per contract.
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
  getFeeConfig,
  updateFeeConfig,
  type FeeConfigPatchInput,
} from '@/modules/plans';
import { buildPlansDeps } from '@/modules/plans/plans-deps';
import type { TenantFeeConfig } from '@/modules/plans';

const CURRENCY_IMMUTABLE_REMEDIATION =
  'Delete or soft-delete all plans for this tenant, then change currency, then rebuild plans. Proper currency migration with FX-rate-aware revaluation is an F10 concern.';

function serialize(row: TenantFeeConfig) {
  return {
    tenant_id: row.tenant_id,
    currency_code: row.currency_code,
    vat_rate: row.vat_rate,
    registration_fee_minor_units: row.registration_fee_minor_units,
    registration_fee_display: formatMinorUnits(
      row.registration_fee_minor_units,
      row.currency_code,
    ),
    updated_at: row.updated_at.toISOString(),
  };
}

/**
 * Minimal server-side formatter — the authoritative Intl.NumberFormat
 * path lives in the React shell (locale-aware). For the API response
 * we just return a plain "{symbol}{major.dd}" string in the tenant's
 * currency. The UI is free to reformat.
 */
function formatMinorUnits(minor: number, currency: string): string {
  const major = (minor / 100).toFixed(2);
  const withCommas = major.replace(/\B(?=(\d{3})+(?!\d))/, ',');
  // Keep currency code — no symbol lookup table in F2.
  return `${currency} ${withCommas}`;
}

// ---------------------------------------------------------------------------
// GET /api/fee-config — admin + manager read
// ---------------------------------------------------------------------------

export async function GET(request: NextRequest): Promise<NextResponse> {
  const ctx = await requireAdminContext(request, {
    resource: 'fee_config',
    action: 'read',
  });
  if ('response' in ctx) return ctx.response;

  const tenant = resolveTenantFromRequest(request);
  const deps = buildPlansDeps(tenant);

  const result = await getFeeConfig({
    tenant: deps.tenant,
    feeConfigRepo: deps.feeConfigRepo,
  });

  if (result.ok) {
    return NextResponse.json(serialize(result.value), { status: 200 });
  }

  if (result.error.type === 'not_found') {
    return NextResponse.json(
      { error: { code: 'not_found', message: 'Fee config not found.' } },
      { status: 404 },
    );
  }

  logger.error(
    { requestId: ctx.requestId, err: result.error },
    'get-fee-config: unhandled error',
  );
  return NextResponse.json(
    { error: { code: 'server_error', message: 'Internal server error.' } },
    { status: 500 },
  );
}

// ---------------------------------------------------------------------------
// PATCH /api/fee-config — admin only
// ---------------------------------------------------------------------------

export async function PATCH(request: NextRequest): Promise<NextResponse> {
  const ctx = await requireAdminContext(request, {
    resource: 'fee_config',
    action: 'write',
  });
  if ('response' in ctx) return ctx.response;

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
  const bodyHash = hashRequestBody(rawBody, 'PATCH /api/fee-config');
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

  const result = await updateFeeConfig(
    {
      patch: rawBody as FeeConfigPatchInput,
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
    const body = serialize(result.value);
    await rememberIdempotentResponse(tenant, keyCheck.key, bodyHash, {
      status: 200,
      body,
    });
    return NextResponse.json(body, { status: 200 });
  }

  switch (result.error.type) {
    case 'not_found':
      return NextResponse.json(
        { error: { code: 'not_found', message: 'Fee config not found.' } },
        { status: 404 },
      );
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
    case 'currency_code_immutable_in_f2':
      return NextResponse.json(
        {
          error: {
            code: 'currency_code_immutable_in_f2',
            message:
              'currency_code is immutable in F2 while non-deleted plans exist for this tenant.',
            details: {
              current_currency_code: result.error.current_currency_code,
              attempted_currency_code: result.error.attempted_currency_code,
              non_deleted_plan_count: result.error.non_deleted_plan_count,
              remediation: CURRENCY_IMMUTABLE_REMEDIATION,
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
        'update-fee-config: audit write failed',
      );
      return NextResponse.json(
        { error: { code: 'audit_failed', message: 'Audit trail write failed.' } },
        { status: 500 },
      );
    case 'server_error':
    default:
      logger.error(
        { requestId: ctx.requestId, err: result.error },
        'update-fee-config: unhandled error',
      );
      return NextResponse.json(
        { error: { code: 'server_error', message: 'Internal server error.' } },
        { status: 500 },
      );
  }
}
