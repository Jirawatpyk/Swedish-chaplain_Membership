/**
 * GET /api/members (T063, US2) + POST /api/members (T051, US1).
 *
 * GET: admin + manager read — directory list with substring search +
 * filters + cursor pagination. Per contracts/members-api.md § 1.
 *
 * POST: admin-only create with primary contact. Requires Idempotency-Key
 * header. Validation layer returns 400/404/409/422 per contract.
 *
 * RBAC: GET resource='members' action='read'; POST action='write'.
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
import { env } from '@/lib/env';
import { createMember, directorySearch } from '@/modules/members';
import { buildMembersDeps } from '@/modules/members/members-deps';
import type { MemberId } from '@/modules/members';
import { serialiseDirectoryRow } from './_serialise';

// --- GET (list) --------------------------------------------------------------

const listQuerySchema = z.object({
  q: z.string().trim().min(1).max(200).optional(),
  plan_year: z.coerce.number().int().min(2020).max(2100).optional(),
  plan_id: z.string().min(1).optional(),
  country: z.string().length(2).optional(),
  status: z
    .string()
    .regex(/^(active|inactive|archived)(,(active|inactive|archived))*$/)
    .optional(),
  show_archived: z.coerce.boolean().optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

export async function GET(request: NextRequest): Promise<NextResponse> {
  const ctx = await requireAdminContext(request, {
    resource: 'members',
    action: 'read',
  });
  if ('response' in ctx) return ctx.response;

  const url = new URL(request.url);
  const raw: Record<string, string> = {};
  for (const [k, v] of url.searchParams.entries()) raw[k] = v;

  const parsed = listQuerySchema.safeParse(raw);
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

  const statuses = parsed.data.status
    ? (parsed.data.status.split(',') as ('active' | 'inactive' | 'archived')[])
    : parsed.data.show_archived
      ? (['active', 'inactive', 'archived'] as const)
      : (['active', 'inactive'] as const);

  const deps = buildMembersDeps(tenant);
  const result = await directorySearch(
    { tenant, memberRepo: deps.memberRepo },
    {
      ...(parsed.data.q !== undefined && { q: parsed.data.q }),
      ...(parsed.data.plan_year !== undefined && {
        planYear: parsed.data.plan_year,
      }),
      ...(parsed.data.plan_id !== undefined && { planId: parsed.data.plan_id }),
      ...(parsed.data.country !== undefined && { country: parsed.data.country }),
      ...(parsed.data.cursor !== undefined && { cursor: parsed.data.cursor }),
      ...(parsed.data.limit !== undefined && { limit: parsed.data.limit }),
      status: [...statuses],
    },
  );

  if (!result.ok) {
    logger.error(
      { requestId: ctx.requestId, err: result.error },
      'directory-search: unhandled error',
    );
    return NextResponse.json(
      { error: { code: 'server_error', message: 'Internal server error.' } },
      { status: 500 },
    );
  }

  return NextResponse.json(
    {
      items: result.value.items.map(serialiseDirectoryRow),
      next_cursor: result.value.nextCursor,
    },
    { status: 200 },
  );
}

// --- POST (create) -----------------------------------------------------------

export async function POST(request: NextRequest): Promise<NextResponse> {
  const ctx = await requireAdminContext(request, {
    resource: 'members',
    action: 'write',
  });
  if ('response' in ctx) return ctx.response;

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

  const bodyHash = hashRequestBody(rawBody, 'POST /api/members');
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
  // Batch 1d. The prior fire-and-forget call meant a retry could
  // create a duplicate member when Redis dropped the reservation.
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
  // F8-completion Slice 1 · Task 1.6 — wire the F8 onboarding listener
  // (create the new member's initial renewal cycle) into the create path
  // when F8 is enabled. The listener runs POST-COMMIT — AFTER the member +
  // contact + audit rows have committed durably — in its OWN runInTenant tx
  // (best-effort; a failure is logged + counted and does NOT roll back the
  // already-committed member create). Mirrors the changePlan wiring at
  // [memberId]/route.ts. When F8 is off, createMember is unchanged.
  const createDeps = env.features.f8Renewals
    ? {
        ...deps,
        onboardingListeners: (
          await import('@/modules/renewals')
        ).f8OnCreateMemberCallbacks(tenant.slug),
      }
    : deps;
  const result = await createMember(
    rawBody,
    {
      actorUserId: ctx.current.user.id,
      requestId: ctx.requestId,
    },
    createDeps,
  );

  if (result.ok) {
    const body = {
      member_id: result.value.memberId as MemberId,
      primary_contact_id: result.value.contactId,
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
            message: 'Body failed validation.',
            details: { issues: result.error.issues },
          },
        },
        { status: 400 },
      );
    case 'invalid_email':
    case 'invalid_phone':
    case 'invalid_country':
    case 'invalid_tax_id':
    case 'invalid_override_reason':
    // PR-B task 8 — secondary-contact domain validation, same 400 shape.
    case 'invalid_secondary_email':
    case 'invalid_secondary_phone':
    case 'secondary_email_same_as_primary':
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
    case 'plan_not_found':
      return NextResponse.json(
        { error: { code: 'plan_not_found', message: 'Plan not found.' } },
        { status: 404 },
      );
    case 'turnover_out_of_band':
      return NextResponse.json(
        {
          error: {
            code: 'turnover_warning',
            message: 'Turnover is outside the plan band. Provide override_reason_code to confirm.',
            details: result.error,
          },
        },
        { status: 422 },
      );
    case 'age_not_eligible':
      return NextResponse.json(
        {
          error: {
            code: 'age_warning',
            message: 'Primary contact does not meet plan age requirement.',
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
            message: 'Founded year exceeds plan duration limit.',
            details: result.error,
          },
        },
        { status: 422 },
      );
    case 'soft_duplicate':
      return NextResponse.json(
        {
          error: {
            code: 'soft_duplicate',
            message:
              'A member with the same company name + country already exists. Re-submit with confirm_soft_duplicate:true to proceed.',
            details: result.error,
          },
        },
        { status: 409 },
      );
    case 'conflict':
      // PR-B task 8 — `reason` moved OUT of the user-visible `message` and
      // into `details.reason` (the `soft_duplicate` arm above is the
      // in-repo precedent for a discriminator living in `details`). `code`
      // stays 'conflict' so existing clients keep working; the message is
      // now a fixed, non-leaking string and `mapMemberCreateServerError`
      // switches on `details.reason` to highlight the field that actually
      // collided (member / primary contact / secondary contact).
      return NextResponse.json(
        {
          error: {
            code: 'conflict',
            message: 'A record with this value already exists.',
            details: { reason: result.error.reason },
          },
        },
        { status: 409 },
      );
    case 'audit_failed':
      logger.error(
        { requestId: ctx.requestId },
        'create-member: audit write failed',
      );
      return NextResponse.json(
        { error: { code: 'audit_failed', message: 'Audit trail failed.' } },
        { status: 500 },
      );
    case 'server_error':
    default:
      logger.error(
        { requestId: ctx.requestId, err: result.error },
        'create-member: unhandled',
      );
      return NextResponse.json(
        { error: { code: 'server_error', message: 'Internal server error.' } },
        { status: 500 },
      );
  }
}
