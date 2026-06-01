/**
 * POST /api/members/bulk (T107, US4).
 *
 * Bulk action endpoint: archive, change_plan, send_portal_invite.
 * Enforces ≤100 row cap (FR-019a), per-actor rate limit of 10 ops /
 * 10 min (FR-019b), and all-or-nothing transaction semantics (FR-019).
 *
 * RBAC: admin-only (`members:bulk` / `write`).
 *
 * Round-2 review fixes:
 *   - C-1: rate-limit is enforced ONCE here (removed from use case).
 *   - I-2: `Retry-After` matches the 600s window.
 *   - I-5: audit write for rate-limit breach is wrapped in try/catch.
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
import { bulkAction, bulkSendPortalInvite } from '@/modules/members';
import { buildMembersDeps } from '@/modules/members/members-deps';
import { rateLimiter } from '@/modules/auth';
import {
  BULK_CAP,
  BULK_RATE_MAX,
  BULK_RATE_WINDOW_SECONDS,
} from '@/lib/members-bulk-constants';

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
  //    a key for an obviously invalid request).
  //    Round-6 S-2: intentionally duplicates zod's `.max(BULK_CAP)` for
  //    defense-in-depth — rejects oversized payloads before the idempotency
  //    key is reserved (avoids wasting a key slot on invalid requests).
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
  // Post-ship R6 Batch 2b — surface Upstash outage as 503 instead of
  // silently continuing. Mirrors `_idempotency-guard.ts:106-125` from
  // Batch 1d. Bulk operations are especially sensitive because a
  // silent drop + retry would duplicate the entire batch.
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

  // 5. Rate limit check (per-actor token bucket — single enforcement point).
  const rateLimitKey = `bulk:${tenant.slug}:${ctx.current.user.id}`;
  const rl = await rateLimiter.check(
    rateLimitKey,
    BULK_RATE_MAX,
    BULK_RATE_WINDOW_SECONDS,
  );
  if (!rl.success) {
    // Round-2 review I-5: wrap audit write in try/catch so a failed
    // audit write doesn't mask the 429 — we still want to respond to
    // the client and log the audit failure separately.
    const deps = buildMembersDeps(tenant);
    try {
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
    } catch (e) {
      logger.warn(
        { err: e, requestId: ctx.requestId },
        'bulk-action: rate-limit audit write failed (non-fatal)',
      );
    }
    return NextResponse.json(
      {
        error: {
          code: 'bulk_rate_limit_exceeded',
          message: `Rate limit exceeded: maximum ${BULK_RATE_MAX} bulk operations per ${BULK_RATE_WINDOW_SECONDS / 60} minutes.`,
          details: { remaining: rl.remaining, reset: rl.reset },
        },
      },
      {
        status: 429,
        // Round-2 review I-2: match the actual window (600s), not 300.
        headers: { 'Retry-After': String(BULK_RATE_WINDOW_SECONDS) },
      },
    );
  }

  // 6. Execute bulk action use case (rate limit NOT passed — single-
  //    enforcement-point rule per round-2 review C-1).
  const deps = buildMembersDeps(tenant);

  // 6a. send_portal_invite — go-live P1-17. A SEPARATE use case (not bulkAction):
  //     invites are best-effort per member (a queued invite cannot be un-queued)
  //     and the per-member createUser runs in F1's owner-role tx, which
  //     chamber_app cannot join — so this must NOT share bulkAction's
  //     all-or-nothing runInTenant. Returns a 200 with per-member buckets even
  //     when some members are skipped/failed (partial-success is still 200).
  if (
    rawBody &&
    typeof rawBody === 'object' &&
    (rawBody as Record<string, unknown>).action === 'send_portal_invite'
  ) {
    const inviteResult = await bulkSendPortalInvite(
      rawBody,
      {
        actorUserId: ctx.current.user.id,
        requestId: ctx.requestId,
        sourceIp: ctx.sourceIp,
      },
      {
        tenant: deps.tenant,
        memberRepo: deps.memberRepo,
        contactRepo: deps.contactRepo,
        createUser: deps.createUser,
      },
    );

    if (inviteResult.ok) {
      const body = {
        invited: inviteResult.value.invited.map((i) => ({
          member_id: i.memberId,
          contact_id: i.contactId,
          user_id: i.userId,
          email: i.email,
        })),
        skipped: inviteResult.value.skipped.map((s) => ({
          member_id: s.memberId,
          reason: s.reason,
        })),
        failed: inviteResult.value.failed.map((f) => ({
          member_id: f.memberId,
          code: f.code,
        })),
        counts: inviteResult.value.counts,
      };
      try {
        await rememberIdempotentResponse(tenant, keyCheck.key, bodyHash, {
          status: 200,
          body,
        });
      } catch (e) {
        logger.warn(
          { err: e, requestId: ctx.requestId },
          'bulk-invite: rememberIdempotentResponse failed (non-fatal)',
        );
      }
      return NextResponse.json(body, { status: 200 });
    }

    if (inviteResult.error.type === 'bulk_cap_exceeded') {
      return NextResponse.json(
        {
          error: {
            code: 'bulk_cap_exceeded',
            message: `Cannot exceed ${BULK_CAP} members per batch.`,
            details: { count: inviteResult.error.count, max: BULK_CAP },
          },
        },
        { status: 400 },
      );
    }
    return NextResponse.json(
      {
        error: {
          code: 'invalid_body',
          message: 'Body failed validation.',
          details: { issues: inviteResult.error.issues },
        },
      },
      { status: 400 },
    );
  }

  const result = await bulkAction(
    rawBody,
    {
      actorUserId: ctx.current.user.id,
      requestId: ctx.requestId,
    },
    {
      tenant: deps.tenant,
      memberRepo: deps.memberRepo,
      audit: deps.audit,
      clock: deps.clock,
      plans: deps.plans,
    },
  );

  if (result.ok) {
    const body = {
      updated_count: result.value.updatedCount,
      audit_event_count: result.value.auditEventCount,
    };
    // Round-6 S-3: wrap in try/catch so a Redis/cache failure doesn't
    // prevent the client from receiving its 200 — the mutation already
    // committed. A missed replay-cache write only means a future retry
    // with the same key won't short-circuit (acceptable degradation).
    try {
      await rememberIdempotentResponse(tenant, keyCheck.key, bodyHash, {
        status: 200,
        body,
      });
    } catch (e) {
      logger.warn(
        { err: e, requestId: ctx.requestId },
        'bulk-action: rememberIdempotentResponse failed (non-fatal)',
      );
    }
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
    case 'not_found':
      return NextResponse.json(
        {
          error: {
            code: 'not_found',
            message: 'Member not found.',
            details: { member_id: result.error.memberId },
          },
        },
        { status: 404 },
      );
    case 'plan_not_found':
      return NextResponse.json(
        {
          error: {
            code: 'plan_not_found',
            message: 'Target plan does not exist in this tenant.',
            details: { plan_id: result.error.planId },
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
