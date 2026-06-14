/**
 * F8-completion Slice 3 · Task 3.2 —
 * POST `/api/admin/members/[id]/renew`.
 *
 * Admin "renew / reactivate a lapsed member" reachable path. Creates a
 * fresh `awaiting_payment` renewal cycle for a lapsed member + issues a
 * §86/4 renewal invoice (at the member's frozen plan price) the member
 * then pays. Wraps the `adminRenewLapsedMember` use-case (Task 3.1).
 *
 * Slug name `[id]` matches the existing F3 admin route family
 * (`/api/admin/members/[id]/block-auto-reactivation` etc.) — Next.js
 * requires consistent dynamic-segment slug names within the same path
 * tree.
 *
 * Auth: admin role only (`action='write'`). Manager 403 emits
 * `f8_role_violation_blocked` audit via `requireRenewalAdminContext`
 * (mirrors block-auto-reactivation + cancel-cycle routes). NOT a
 * manager-exception surface — issuing a §86/4 tax document is a
 * write-class admin action.
 *
 * Body: empty `{}` (confirmation-only). BOTH the frozen §86/4 price AND
 * the plan_year are server-derived inside the use-case — there is NO price
 * NOR plan_year field on the request body (L2, 068 security review: a
 * renewal §86/4 is a tax document; neither its amount nor its fiscal year
 * may be client-influenceable). A client-supplied `plan_year` is ignored.
 *
 * Rate-limit (L3, 068 security review): 30/5min per (tenant, admin) —
 * defence-in-depth on a money endpoint (each call issues a §86/4 +
 * triggers a member email). Mirrors `send-reminder-now`.
 */
import { type NextRequest } from 'next/server';
import { randomUUID } from 'node:crypto';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { rateLimiter } from '@/lib/auth-deps';
import { retryAfterSecondsFromRl } from '@/lib/rate-limit-helpers';
import {
  errorResponse,
  successResponse,
  requireRenewalAdminContext,
} from '@/lib/renewals-route-helpers';
import { adminRenewLapsedMember, makeRenewalsDeps } from '@/modules/renewals';

/**
 * L3 — 30 requests per 5 minutes per (tenant, admin). Generous headroom
 * for legitimate "reactivate a batch of lapsed members at the desk" work
 * while bounding accidental click-storms / scripted abuse on a money path
 * that issues a §86/4 + sends a member email per call. Mirrors the
 * send-reminder-now cap.
 */
const RL_LIMIT = 30;
const RL_WINDOW_SECONDS = 300;

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  if (!env.features.f8Renewals) {
    return errorResponse({
      status: 503,
      code: 'feature_disabled',
      correlationId: randomUUID(),
    });
  }

  const ctx = await requireRenewalAdminContext(request, 'write');
  if ('response' in ctx) return ctx.response;

  const tenantCtx = resolveTenantFromRequest(request);

  // L3 — rate-limit AFTER the RBAC gate (a rejected manager must not
  // consume a token), BEFORE any §86/4 work. Per (tenant, admin) money
  // endpoint defence-in-depth.
  const rl = await rateLimiter.check(
    `f8:renew-lapsed:${tenantCtx.slug}:${ctx.current.user.id}`,
    RL_LIMIT,
    RL_WINDOW_SECONDS,
  );
  if (!rl.success) {
    return errorResponse({
      status: 429,
      code: 'rate_limited',
      correlationId: ctx.correlationId,
      headers: { 'Retry-After': String(retryAfterSecondsFromRl(rl)) },
    });
  }

  const { id: memberId } = await context.params;

  // The request body is confirmation-only. We still parse it to reject
  // malformed JSON (a 400 oracle for a broken client), but there is NO
  // schema field to validate — both price + plan_year are server-derived
  // (L2). A client-supplied `plan_year` is silently ignored, not honoured.
  try {
    await request.json();
  } catch {
    return errorResponse({
      status: 400,
      code: 'invalid_body',
      correlationId: ctx.correlationId,
    });
  }

  const deps = makeRenewalsDeps(tenantCtx.slug);

  try {
    const result = await adminRenewLapsedMember(deps, {
      tenantId: tenantCtx.slug,
      memberId,
      actorUserId: ctx.current.user.id,
      actorRole: 'admin',
      requestId: ctx.requestId,
      correlationId: ctx.correlationId,
    });
    if (!result.ok) {
      switch (result.error.kind) {
        case 'invalid_input':
          return errorResponse({
            status: 400,
            code: 'invalid_input',
            correlationId: ctx.correlationId,
            details: { message: result.error.message },
          });
        case 'member_not_found':
          return errorResponse({
            status: 404,
            code: 'member_not_found',
            correlationId: ctx.correlationId,
          });
        case 'member_archived':
          // 068 cluster C — the member exists but is archived. 409 (conflict
          // with current state): the admin must un-archive the member before
          // renewing. Rejected before any cycle is created (no orphan).
          return errorResponse({
            status: 409,
            code: 'member_archived',
            correlationId: ctx.correlationId,
          });
        case 'member_has_active_cycle':
          return errorResponse({
            status: 409,
            code: 'member_has_active_cycle',
            correlationId: ctx.correlationId,
          });
        case 'plan_not_found':
          return errorResponse({
            status: 422,
            code: 'plan_not_found',
            correlationId: ctx.correlationId,
          });
        case 'invoice_issue_failed':
          return errorResponse({
            status: 502,
            code: 'invoice_issue_failed',
            correlationId: ctx.correlationId,
            details: { stage: result.error.stage },
          });
        case 'server_error':
          return errorResponse({
            status: 500,
            code: 'server_error',
            correlationId: ctx.correlationId,
          });
        default: {
          const _exhaustive: never = result.error;
          void _exhaustive;
          return errorResponse({
            status: 500,
            code: 'server_error',
            correlationId: ctx.correlationId,
          });
        }
      }
    }
    return successResponse(
      {
        cycle_id: result.value.cycleId,
        invoice_id: result.value.invoiceId,
        cycle_status: result.value.cycleStatus,
      },
      ctx.correlationId,
    );
  } catch (e) {
    logger.error(
      {
        err: e instanceof Error ? e : new Error(String(e)),
        correlationId: ctx.correlationId,
        memberId,
        tenantId: tenantCtx.slug,
      },
      'admin-renew-lapsed-member route unexpected error',
    );
    return errorResponse({
      status: 500,
      code: 'server_error',
      correlationId: ctx.correlationId,
    });
  }
}
