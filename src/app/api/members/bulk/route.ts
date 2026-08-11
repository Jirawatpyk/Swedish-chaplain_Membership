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
import { requireApiPermission } from '@/lib/rbac';
import { mappedLegacy } from '@/modules/auth/domain/permissions/legacy-shim';
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
  bulkAction,
  bulkSendPortalInvite,
  bulkEnrolAutoInvoice,
  bulkUnenrolAutoInvoice,
} from '@/modules/members';
import { buildMembersDeps } from '@/modules/members/members-deps';
import { bulkSendRenewalReminder, makeRenewalsDeps } from '@/modules/renewals';
import { rateLimiter } from '@/modules/auth';
import {
  BULK_CAP,
  BULK_RATE_MAX,
  BULK_RATE_WINDOW_SECONDS,
} from '@/lib/members-bulk-constants';

export async function POST(request: NextRequest): Promise<NextResponse> {
  // 1. RBAC — admin-only, `members:bulk` resource
  const ctx = await requireApiPermission(request, 'members.bulk', mappedLegacy('members:bulk', 'write'));
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
        deleteInvitedUser: deps.deleteInvitedUser,
        // Phase D / Task 13 — the already_linked arm now falls through to
        // resendBouncedInvite, which needs these; all already provided by
        // buildMembersDeps. (Response-body mapping of the `resent` bucket +
        // UI copy landed in Task 14 below.)
        reissueInvitation: deps.reissueInvitation,
        userEmails: deps.userEmails,
        audit: deps.audit,
        clock: deps.clock,
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
        resent: inviteResult.value.resent.map((r) => ({
          member_id: r.memberId,
          contact_id: r.contactId,
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

    // go-live /code-review #33 — these validation errors still hold the
    // idempotency reservation made above. Remember the response so a same-key +
    // same-body retry replays this 400 deterministically instead of getting a
    // stuck `idempotency_reservation_failed`. (A corrected body must use a new
    // key — same key + different body is an idempotency_conflict by design.)
    const errorResponse =
      inviteResult.error.type === 'bulk_cap_exceeded'
        ? {
            status: 400 as const,
            body: {
              error: {
                code: 'bulk_cap_exceeded' as const,
                message: `Cannot exceed ${BULK_CAP} members per batch.`,
                details: { count: inviteResult.error.count, max: BULK_CAP },
              },
            },
          }
        : {
            status: 400 as const,
            body: {
              error: {
                code: 'invalid_body' as const,
                message: 'Body failed validation.',
                details: { issues: inviteResult.error.issues },
              },
            },
          };
    try {
      await rememberIdempotentResponse(tenant, keyCheck.key, bodyHash, errorResponse);
    } catch (e) {
      logger.warn(
        { err: e, requestId: ctx.requestId },
        'bulk-invite: rememberIdempotentResponse (error path) failed (non-fatal)',
      );
    }
    return NextResponse.json(errorResponse.body, { status: errorResponse.status });
  }

  // 6b. send_renewal_reminder — #4 members-ux. Like send_portal_invite this is
  //     best-effort per member (a queued reminder email cannot be un-queued), so
  //     it is a SEPARATE cross-module call into F8's dispatch (reusing
  //     sendReminderNow per member), NOT bulkAction's all-or-nothing tx. Returns
  //     200 with per-member buckets even when some members are skipped/failed.
  if (
    rawBody &&
    typeof rawBody === 'object' &&
    (rawBody as Record<string, unknown>).action === 'send_renewal_reminder'
  ) {
    const memberIds = (rawBody as Record<string, unknown>).member_ids;
    const renewalsDeps = makeRenewalsDeps(tenant.slug);
    const reminderResult = await bulkSendRenewalReminder(renewalsDeps, {
      tenantId: tenant.slug,
      memberIds: Array.isArray(memberIds) ? (memberIds as string[]) : [],
      actorUserId: ctx.current.user.id,
      correlationId: ctx.requestId,
      requestId: ctx.requestId,
    });

    if (reminderResult.ok) {
      const body = {
        sent: reminderResult.value.sent,
        skipped: reminderResult.value.skipped.map((s) => ({
          member_id: s.memberId,
          reason: s.reason,
        })),
        failed: reminderResult.value.failed.map((f) => ({
          member_id: f.memberId,
          code: f.code,
        })),
        counts: reminderResult.value.counts,
      };
      try {
        await rememberIdempotentResponse(tenant, keyCheck.key, bodyHash, {
          status: 200,
          body,
        });
      } catch (e) {
        logger.warn(
          { err: e, requestId: ctx.requestId },
          'bulk-reminder: rememberIdempotentResponse failed (non-fatal)',
        );
      }
      return NextResponse.json(body, { status: 200 });
    }

    // invalid_input — remember the 400 so a same-key retry replays it
    // deterministically instead of getting a stuck reservation (parity with the
    // invite branch).
    const errorResponse = {
      status: 400 as const,
      body: {
        error: {
          code: 'invalid_body' as const,
          message: 'Body failed validation.',
          details: { message: reminderResult.error.message },
        },
      },
    };
    try {
      await rememberIdempotentResponse(tenant, keyCheck.key, bodyHash, errorResponse);
    } catch (e) {
      logger.warn(
        { err: e, requestId: ctx.requestId },
        'bulk-reminder: rememberIdempotentResponse (error path) failed (non-fatal)',
      );
    }
    return NextResponse.json(errorResponse.body, { status: errorResponse.status });
  }

  // 6b. enrol_auto_invoice — 107-auto-invoice Task 15. A SEPARATE use case
  //     (not a `bulkAction` arm): it needs the `membershipAccess` port that
  //     bulkAction has no use for, and it reports per-member SKIP BUCKETS
  //     rather than bulkAction's single `updatedCount`. Everything before
  //     this point — RBAC, the ≤100 cap, Idempotency-Key, the per-actor
  //     rate limit — is deliberately SHARED, not re-implemented.
  //
  //     Skips are not failures: a batch where every member was already
  //     enrolled or is terminated is still a 200 with zeroed counters.
  //     Only invalid input / a missing member / an infra fault errors.
  if (
    rawBody &&
    typeof rawBody === 'object' &&
    (rawBody as Record<string, unknown>).action === 'enrol_auto_invoice'
  ) {
    const enrolResult = await bulkEnrolAutoInvoice(
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
        membershipAccess: deps.membershipAccess,
      },
    );

    if (enrolResult.ok) {
      const body = {
        enrolled: enrolResult.value.enrolled,
        skipped_already: enrolResult.value.skippedAlready,
        skipped_terminated: enrolResult.value.skippedTerminated,
        skipped_erased: enrolResult.value.skippedErased,
      };
      try {
        await rememberIdempotentResponse(tenant, keyCheck.key, bodyHash, {
          status: 200,
          body,
        });
      } catch (e) {
        logger.warn(
          { err: e, requestId: ctx.requestId },
          'bulk-enrol-auto-invoice: rememberIdempotentResponse failed (non-fatal)',
        );
      }
      return NextResponse.json(body, { status: 200 });
    }

    const enrolError = enrolResult.error;
    const errorResponse =
      enrolError.type === 'invalid_body'
        ? {
            status: 400 as const,
            body: {
              error: {
                code: 'invalid_body' as const,
                message: 'Body failed validation.',
                details: { issues: enrolError.issues },
              },
            },
          }
        : enrolError.type === 'bulk_cap_exceeded'
          ? {
              status: 400 as const,
              body: {
                error: {
                  code: 'bulk_cap_exceeded' as const,
                  message: `Cannot exceed ${BULK_CAP} members per batch.`,
                  details: { count: enrolError.count, max: BULK_CAP },
                },
              },
            }
          : enrolError.type === 'not_found'
            ? {
                status: 404 as const,
                body: {
                  error: {
                    code: 'not_found' as const,
                    message: 'Member not found.',
                    details: { member_id: enrolError.memberId },
                  },
                },
              }
            : {
                status: 500 as const,
                body: {
                  error: {
                    code: 'server_error' as const,
                    message: 'Internal server error.',
                  },
                },
              };

    if (errorResponse.status === 500) {
      logger.error(
        { requestId: ctx.requestId, err: enrolError },
        'bulk-enrol-auto-invoice: unhandled',
      );
    } else {
      // Same rationale as the invite arm (go-live /code-review #33): these
      // deterministic client errors still hold the idempotency reservation
      // made above, so cache them — otherwise a same-key + same-body retry
      // gets a stuck `idempotency_reservation_failed`. 5xx is deliberately
      // NOT cached: an infra fault must stay retryable with the same key.
      try {
        await rememberIdempotentResponse(
          tenant,
          keyCheck.key,
          bodyHash,
          errorResponse,
        );
      } catch (e) {
        logger.warn(
          { err: e, requestId: ctx.requestId },
          'bulk-enrol-auto-invoice: rememberIdempotentResponse (error path) failed (non-fatal)',
        );
      }
    }
    return NextResponse.json(errorResponse.body, { status: errorResponse.status });
  }

  // 6c. unenrol_auto_invoice — 107-auto-invoice Task 18. The counterpart to
  //     6b, and structurally identical: everything before this point — RBAC,
  //     the ≤100 cap, Idempotency-Key, the per-actor rate limit — is SHARED,
  //     not re-implemented.
  //
  //     Two differences from the enrol arm, both intentional:
  //       - Fewer deps. Un-enrol needs no `membershipAccess` (it applies no
  //         membership-state gate) and no `clock` (there is no timestamp to
  //         write — it nulls the column).
  //       - Two buckets, not three. The only skip is "was not enrolled",
  //         which is an idempotent no-op rather than a refusal.
  //
  //     It stays admin-only even though un-enrolling is strictly
  //     de-escalating: the endpoint is admin-gated as a whole, and a
  //     manager who could silently flip the flag off could mask a member's
  //     billing state from the treasurer's queue.
  if (
    rawBody &&
    typeof rawBody === 'object' &&
    (rawBody as Record<string, unknown>).action === 'unenrol_auto_invoice'
  ) {
    const unenrolResult = await bulkUnenrolAutoInvoice(
      rawBody,
      {
        actorUserId: ctx.current.user.id,
        requestId: ctx.requestId,
      },
      {
        tenant: deps.tenant,
        memberRepo: deps.memberRepo,
        audit: deps.audit,
      },
    );

    if (unenrolResult.ok) {
      const body = {
        unenrolled: unenrolResult.value.unenrolled,
        skipped_not_enrolled: unenrolResult.value.skippedNotEnrolled,
      };
      try {
        await rememberIdempotentResponse(tenant, keyCheck.key, bodyHash, {
          status: 200,
          body,
        });
      } catch (e) {
        logger.warn(
          { err: e, requestId: ctx.requestId },
          'bulk-unenrol-auto-invoice: rememberIdempotentResponse failed (non-fatal)',
        );
      }
      return NextResponse.json(body, { status: 200 });
    }

    const unenrolError = unenrolResult.error;
    const errorResponse =
      unenrolError.type === 'invalid_body'
        ? {
            status: 400 as const,
            body: {
              error: {
                code: 'invalid_body' as const,
                message: 'Body failed validation.',
                details: { issues: unenrolError.issues },
              },
            },
          }
        : unenrolError.type === 'bulk_cap_exceeded'
          ? {
              status: 400 as const,
              body: {
                error: {
                  code: 'bulk_cap_exceeded' as const,
                  message: `Cannot exceed ${BULK_CAP} members per batch.`,
                  details: { count: unenrolError.count, max: BULK_CAP },
                },
              },
            }
          : unenrolError.type === 'not_found'
            ? {
                status: 404 as const,
                body: {
                  error: {
                    code: 'not_found' as const,
                    message: 'Member not found.',
                    details: { member_id: unenrolError.memberId },
                  },
                },
              }
            : {
                status: 500 as const,
                body: {
                  error: {
                    code: 'server_error' as const,
                    message: 'Internal server error.',
                  },
                },
              };

    if (errorResponse.status === 500) {
      logger.error(
        { requestId: ctx.requestId, err: unenrolError },
        'bulk-unenrol-auto-invoice: unhandled',
      );
    } else {
      // Same rationale as the enrol arm: these deterministic client errors
      // still hold the idempotency reservation made above, so cache them.
      // 5xx is deliberately NOT cached — an infra fault must stay retryable
      // with the same key.
      try {
        await rememberIdempotentResponse(
          tenant,
          keyCheck.key,
          bodyHash,
          errorResponse,
        );
      } catch (e) {
        logger.warn(
          { err: e, requestId: ctx.requestId },
          'bulk-unenrol-auto-invoice: rememberIdempotentResponse (error path) failed (non-fatal)',
        );
      }
    }
    return NextResponse.json(errorResponse.body, { status: errorResponse.status });
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
      // The transitioned member ids — the client's archive success toast posts
      // an `unarchive` bulk action with exactly these for a precise Undo.
      updated_ids: result.value.updatedIds,
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
      // The client maps `code` → localized copy; the message here is a
      // generic non-leaky fallback (no member UUID / dev-y interpolation).
      // The member id + domain code are preserved under `details` for
      // observability (parity with the not_found / plan_not_found arms above
      // and with the inline-edit route's sanitized state_error).
      return NextResponse.json(
        {
          error: {
            code: 'state_error',
            message: 'Member state transition is not allowed.',
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
