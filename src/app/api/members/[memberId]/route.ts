/**
 * /api/members/[memberId]  — GET (T068, US2) + PATCH (T090, US3).
 *
 * GET: admin + manager read, cross-tenant probe → 404 + audit.
 * PATCH: admin-only write. Dispatches on body shape:
 *   - presence of `new_plan_id` → change-plan use case
 *     (may return 409 `bundle_change_requires_confirmation` or 422
 *     warning — override_reason_code bypasses warnings per FR-006a)
 *   - otherwise → update-member (field-level partial update with
 *     diff tracking for the audit payload)
 *
 * Idempotency-Key required on PATCH. 404 when cross-tenant / unknown.
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
import { getMember, updateMember, changePlan } from '@/modules/members';
import type { MemberId } from '@/modules/members';
import { buildMembersDeps } from '@/modules/members/members-deps';
import { serialiseMember, serialiseContact } from '../_serialise';

const paramsSchema = z.object({
  memberId: z.string().uuid(),
});

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ memberId: string }> },
): Promise<NextResponse> {
  const ctx = await requireAdminContext(request, {
    resource: 'members',
    action: 'read',
  });
  if ('response' in ctx) return ctx.response;

  const resolved = await params;
  const parsed = paramsSchema.safeParse(resolved);
  if (!parsed.success) {
    return NextResponse.json(
      { error: { code: 'not_found', message: 'Member not found.' } },
      { status: 404 },
    );
  }

  const url = new URL(request.url);
  const includeDob = url.searchParams.get('include') === 'date_of_birth';

  const tenant = resolveTenantFromRequest(request);
  const deps = buildMembersDeps(tenant);
  const result = await getMember(
    parsed.data.memberId as MemberId,
    { actorUserId: ctx.current.user.id, requestId: ctx.requestId },
    deps,
  );

  if (!result.ok) {
    if (result.error.type === 'not_found') {
      return NextResponse.json(
        { error: { code: 'not_found', message: 'Member not found.' } },
        { status: 404 },
      );
    }
    logger.error(
      { requestId: ctx.requestId, err: result.error },
      'get-member: unhandled',
    );
    return NextResponse.json(
      { error: { code: 'server_error', message: 'Internal server error.' } },
      { status: 500 },
    );
  }

  return NextResponse.json(
    {
      ...serialiseMember(result.value.member),
      contacts: result.value.contacts.map((c) =>
        serialiseContact(c, {
          includeDateOfBirth: includeDob && ctx.current.user.role === 'admin',
        }),
      ),
    },
    { status: 200 },
  );
}

// --- PATCH (T090, US3) -------------------------------------------------------

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ memberId: string }> },
): Promise<NextResponse> {
  const ctx = await requireAdminContext(request, {
    resource: 'members',
    action: 'write',
  });
  if ('response' in ctx) return ctx.response;

  const resolved = await params;
  const parsed = paramsSchema.safeParse(resolved);
  if (!parsed.success) {
    return NextResponse.json(
      { error: { code: 'not_found', message: 'Member not found.' } },
      { status: 404 },
    );
  }
  const memberId = parsed.data.memberId as MemberId;

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json(
      { error: { code: 'invalid_body', message: 'Body must be valid JSON.' } },
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
  const bodyHash = hashRequestBody(rawBody, `PATCH /api/members/${memberId}`);
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
  // Post-ship R6 Batch 2b — surface Upstash outage as 503 instead of
  // silently continuing. Mirrors `_idempotency-guard.ts:106-125` from
  // Batch 1d. PATCH on a member can mutate plan/status — a silent
  // drop + retry could double-apply the change.
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

  const deps = buildMembersDeps(tenant);
  const meta = { actorUserId: ctx.current.user.id, requestId: ctx.requestId };
  const body = rawBody as Record<string, unknown>;
  const isPlanChange = typeof body['new_plan_id'] === 'string';

  if (isPlanChange) {
    // F8 Phase 7 T188 / 063 Option A — wire the F8 listener pair (supersede
    // pending tier-upgrade + reschedule renewal cadence) into the change-plan
    // call. The listeners run POST-COMMIT — AFTER the F3 plan-flip and
    // member_plan_manually_changed audit have committed durably. Each listener
    // opens its OWN runInTenant tx (best-effort; a listener failure is logged,
    // counted, and swallowed and does NOT roll back the already-committed
    // plan-flip). See f2-plan-change-bridge.ts § Failure semantics.
    const { f8OnManualPlanChangeCallbacks } = await import('@/modules/renewals');
    const planChangeDeps = {
      ...deps,
      manualPlanChangeListeners: f8OnManualPlanChangeCallbacks(tenant.slug),
    };
    const result = await changePlan(memberId, rawBody, meta, planChangeDeps);
    if (result.ok) {
      const responseBody = serialiseMember(result.value);
      await rememberIdempotentResponse(tenant, keyCheck.key, bodyHash, {
        status: 200,
        body: responseBody,
      });
      return NextResponse.json(responseBody, { status: 200 });
    }
    switch (result.error.type) {
      case 'invalid_body':
        return NextResponse.json(
          {
            error: {
              code: 'invalid_body',
              message: 'Body failed validation.',
              details: { issues: result.error.issues },
            },
          },
          { status: 400 },
        );
      case 'invalid_override_reason':
        return NextResponse.json(
          {
            error: {
              code: 'validation_error',
              message: 'Invalid override reason.',
              details: result.error,
            },
          },
          { status: 400 },
        );
      case 'not_found':
        return NextResponse.json(
          { error: { code: 'not_found', message: 'Member not found.' } },
          { status: 404 },
        );
      case 'plan_not_found':
        return NextResponse.json(
          { error: { code: 'plan_not_found', message: 'Target plan not found.' } },
          { status: 404 },
        );
      case 'bundle_change_requires_confirmation':
        return NextResponse.json(
          {
            error: {
              code: 'bundle_change_requires_confirmation',
              message:
                'Bundle change requires confirmation. Re-submit with confirm_bundle_change=true.',
              details: result.error,
            },
          },
          { status: 409 },
        );
      case 'turnover_out_of_band':
        return NextResponse.json(
          {
            error: {
              code: 'turnover_warning',
              message:
                'Turnover is outside the new plan band. Provide override_reason_code to confirm.',
              details: result.error,
            },
          },
          { status: 422 },
        );
      case 'startup_too_old':
        return NextResponse.json(
          {
            error: {
              code: 'startup_warning',
              message: 'Founded year exceeds new plan duration limit.',
              details: result.error,
            },
          },
          { status: 422 },
        );
      case 'server_error':
      default:
        logger.error(
          { requestId: ctx.requestId, err: result.error },
          'change-plan: unhandled',
        );
        return NextResponse.json(
          { error: { code: 'server_error', message: 'Internal server error.' } },
          { status: 500 },
        );
    }
  }

  // Plain field update
  const result = await updateMember(memberId, rawBody, meta, deps);
  if (result.ok) {
    const responseBody = serialiseMember(result.value);
    await rememberIdempotentResponse(tenant, keyCheck.key, bodyHash, {
      status: 200,
      body: responseBody,
    });
    return NextResponse.json(responseBody, { status: 200 });
  }
  switch (result.error.type) {
    case 'invalid_body':
      return NextResponse.json(
        {
          error: {
            code: 'invalid_body',
            message: 'Body failed validation.',
            details: { issues: result.error.issues },
          },
        },
        { status: 400 },
      );
    case 'invalid_country':
    case 'invalid_tax_id':
      return NextResponse.json(
        {
          error: {
            code: 'validation_error',
            message: 'Domain validation failed.',
            details: result.error,
          },
        },
        { status: 400 },
      );
    case 'not_found':
      return NextResponse.json(
        { error: { code: 'not_found', message: 'Member not found.' } },
        { status: 404 },
      );
    case 'server_error':
    default:
      logger.error(
        { requestId: ctx.requestId, err: result.error },
        'update-member: unhandled',
      );
      return NextResponse.json(
        { error: { code: 'server_error', message: 'Internal server error.' } },
        { status: 500 },
      );
  }
}
