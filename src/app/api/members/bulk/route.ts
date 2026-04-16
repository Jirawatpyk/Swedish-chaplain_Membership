/**
 * POST /api/members/bulk (T107, US4).
 *
 * Bulk action endpoint: archive, change_plan, send_portal_invite.
 * Enforces ≤100 row cap (FR-019a), per-actor rate limit of 10 ops /
 * 10 min (FR-019b), and all-or-nothing transaction semantics (FR-019).
 *
 * RBAC: admin-only (`members:bulk` / `write`).
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
import { bulkAction, BULK_CAP } from '@/modules/members';
import { buildMembersDeps } from '@/modules/members/members-deps';
import { rateLimiter } from '@/modules/auth';

export async function POST(request: NextRequest): Promise<NextResponse> {
  // 1. RBAC — admin-only, `members:bulk` resource
  const ctx = await requireAdminContext(request, {
    resource: 'members:bulk',
    action: 'write',
  });
  if ('response' in ctx) return ctx.response;

  // 2. Parse body
  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json(
      { error: { code: 'invalid_body', message: 'Body must be valid JSON.' } },
      { status: 400 },
    );
  }

  // 3. Pre-validation: cap check before idempotency (no point reserving
  //    a key for an obviously invalid request)
  if (
    rawBody &&
    typeof rawBody === 'object' &&
    'member_ids' in rawBody &&
    Array.isArray((rawBody as Record<string, unknown>).member_ids) &&
    ((rawBody as Record<string, unknown>).member_ids as unknown[]).length > BULK_CAP
  ) {
    return NextResponse.json(
      {
        error: {
          code: 'bulk_cap_exceeded',
          message: `Cannot exceed ${BULK_CAP} members per batch.`,
          details: {
            count: ((rawBody as Record<string, unknown>).member_ids as unknown[]).length,
            max: BULK_CAP,
          },
        },
      },
      { status: 400 },
    );
  }

  // 4. Idempotency-Key
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
  const bodyHash = hashRequestBody(rawBody, 'POST /api/members/bulk');
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

  // 5. Rate limit check (per-actor token bucket)
  const rateLimitKey = `bulk:${tenant.slug}:${ctx.current.user.id}`;
  const rl = await rateLimiter.check(rateLimitKey, 10, 600);
  if (!rl.success) {
    // Emit rate-limit audit via use case deps
    const deps = buildMembersDeps(tenant);
    await deps.audit.record(tenant, {
      type: 'bulk_action_rate_limit_exceeded',
      actorUserId: ctx.current.user.id,
      requestId: ctx.requestId,
      summary: `bulk rate limit exceeded for actor ${ctx.current.user.id}`,
      payload: {
        action: (rawBody as Record<string, unknown>)?.action ?? 'unknown',
        remaining: rl.remaining,
        reset: rl.reset,
      },
    });
    return NextResponse.json(
      {
        error: {
          code: 'bulk_rate_limit_exceeded',
          message: 'Rate limit exceeded: maximum 10 bulk operations per 10 minutes.',
          details: { remaining: rl.remaining, reset: rl.reset },
        },
      },
      { status: 429, headers: { 'Retry-After': '300' } },
    );
  }

  // 6. Execute bulk action use case
  const deps = buildMembersDeps(tenant);
  const result = await bulkAction(
    rawBody,
    {
      actorUserId: ctx.current.user.id,
      requestId: ctx.requestId,
    },
    {
      ...deps,
      rateLimit: rateLimiter,
    },
  );

  if (result.ok) {
    const body = {
      updated_count: result.value.updatedCount,
      audit_event_count: result.value.auditEventCount,
    };
    await rememberIdempotentResponse(tenant, keyCheck.key, bodyHash, {
      status: 200,
      body,
    });
    return NextResponse.json(body, { status: 200 });
  }

  // 7. Error mapping
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
    case 'bulk_cap_exceeded':
      return NextResponse.json(
        {
          error: {
            code: 'bulk_cap_exceeded',
            message: `Cannot exceed ${BULK_CAP} members per batch.`,
            details: { count: result.error.count, max: BULK_CAP },
          },
        },
        { status: 400 },
      );
    case 'rate_limited':
      return NextResponse.json(
        {
          error: {
            code: 'bulk_rate_limit_exceeded',
            message: 'Rate limit exceeded.',
          },
        },
        { status: 429, headers: { 'Retry-After': '300' } },
      );
    case 'not_found':
      return NextResponse.json(
        {
          error: {
            code: 'not_found',
            message: 'One or more members not found.',
            details: { missing_ids: result.error.missingIds },
          },
        },
        { status: 404 },
      );
    case 'state_error':
      return NextResponse.json(
        {
          error: {
            code: 'state_error',
            message: `State transition failed for member ${result.error.memberId}.`,
            details: { member_id: result.error.memberId, code: result.error.code },
          },
        },
        { status: 409 },
      );
    case 'server_error':
    default:
      logger.error(
        { requestId: ctx.requestId, err: result.error },
        'bulk-action: unhandled',
      );
      return NextResponse.json(
        { error: { code: 'server_error', message: 'Internal server error.' } },
        { status: 500 },
      );
  }
}
