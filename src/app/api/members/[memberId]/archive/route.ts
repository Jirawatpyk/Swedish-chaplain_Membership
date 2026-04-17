/**
 * POST /api/members/[memberId]/archive (T140, US7).
 *
 * Admin-only soft-delete. Cascades session revocation for linked
 * contacts. Idempotency-Key required per endpoints spec.
 *
 * Error mapping:
 *   400 invalid_body          — body fails zod (reason > 500 chars)
 *   400 missing_idempotency_key
 *   403 forbidden             — RBAC (via requireAdminContext)
 *   404 not_found             — member absent or cross-tenant
 *   409 idempotency_conflict  — same key, different body
 *   409 state_error           — already archived
 *   500 server_error          — anything else
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
import { archiveMember } from '@/modules/members';
import type { MemberId } from '@/modules/members';
import { buildMembersDeps } from '@/modules/members/members-deps';
import { serialiseMember } from '../../_serialise';

const paramsSchema = z.object({
  memberId: z.string().uuid(),
});

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ memberId: string }> },
): Promise<NextResponse> {
  const ctx = await requireAdminContext(request, {
    resource: 'members',
    action: 'write',
  });
  if ('response' in ctx) return ctx.response;

  const resolved = await params;
  const parsedParams = paramsSchema.safeParse(resolved);
  if (!parsedParams.success) {
    return NextResponse.json(
      { error: { code: 'not_found', message: 'Member not found.' } },
      { status: 404 },
    );
  }
  const memberId = parsedParams.data.memberId as MemberId;

  // Body is optional for archive — client may send `{}` or `{ reason }`.
  // R003 (staff-review-20260417-us7) — attempt the JSON parse
  // unconditionally. Gating on `content-length` header lost the body on
  // malformed POSTs that omitted the header (fetch/curl occasionally do).
  // A missing or malformed body falls through to `{}` and the zod schema
  // accepts the empty-object case correctly.
  let rawBody: unknown = {};
  try {
    const text = await request.text();
    if (text.length > 0) {
      rawBody = JSON.parse(text);
    }
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
  const bodyHash = hashRequestBody(
    rawBody,
    `POST /api/members/${memberId}/archive`,
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

  const deps = buildMembersDeps(tenant);
  const result = await archiveMember(
    memberId,
    rawBody,
    { actorUserId: ctx.current.user.id, requestId: ctx.requestId },
    deps,
  );

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
    case 'not_found':
      return NextResponse.json(
        { error: { code: 'not_found', message: 'Member not found.' } },
        { status: 404 },
      );
    case 'state_error':
      return NextResponse.json(
        {
          error: {
            code: 'state_error',
            message: 'Member is already archived.',
            details: { code: result.error.code },
          },
        },
        { status: 409 },
      );
    case 'server_error':
    default:
      logger.error(
        { requestId: ctx.requestId, err: result.error },
        'archive-member: unhandled',
      );
      return NextResponse.json(
        { error: { code: 'server_error', message: 'Internal server error.' } },
        { status: 500 },
      );
  }
}
