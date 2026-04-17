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
  await reserveIdempotencyRecord(tenant, keyCheck.key, bodyHash);

  const deps = buildMembersDeps(tenant);
  const result = await createMember(
    rawBody,
    {
      actorUserId: ctx.current.user.id,
      requestId: ctx.requestId,
    },
    deps,
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
      return NextResponse.json(
        { error: { code: 'conflict', message: result.error.reason } },
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
