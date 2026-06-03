/**
 * T070 — POST /api/payments/[id]/cancel (F5 / payments-api.md § 2).
 *
 * Member-initiated cancellation of own pending payment.
 * Member-own ownership enforcement lives in the use-case (`cancelPayment`);
 * the route only forwards context. RBAC gate on role=member lives there
 * too via `isAllowed(input.actorRole, 'payments', 'cancel-own')`.
 */
import { NextResponse, type NextRequest } from 'next/server';

import { requireMemberContext } from '@/lib/member-context';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { requestIdFromHeaders } from '@/lib/request-id';
import { randomUUID } from 'node:crypto';
import { rateLimiter } from '@/lib/auth-deps';
import { logger } from '@/lib/logger';
import { errKind } from '@/lib/log-id';
import {
  cancelPayment,
  makeCancelPaymentDeps,
  parsePaymentId,
} from '@/modules/payments';
import { type F5RouteErrorCode } from '@/lib/payments-errors-i18n';
import {
  baseHeaders,
  buildUseCaseErrorTelemetry,
  errorResponse,
} from '@/lib/payments-route-helpers';
import { retryAfterSecondsFromRl } from '@/lib/rate-limit-helpers';
import {
  f5AuditAdapter,
  f5RetentionFor,
  type ActorRef,
} from '@/lib/stripe-webhook-deps';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function httpStatusForUseCaseError(code: string): {
  status: number;
  routeCode: F5RouteErrorCode;
} {
  switch (code) {
    case 'forbidden_role':
      return { status: 403, routeCode: 'forbidden_role' };
    // Enumeration defence (PCI F-02 / Threat OQ-1 / Constitution
    // Principle I): both "payment does not exist" and "payment belongs
    // to a different actor" return HTTP 403 + `payment_not_accessible`.
    // Audit trail retains the cross-tenant discriminator via the
    // use-case's `payment_cross_tenant_probe` emission.
    case 'payment_not_found':
    case 'forbidden_payment':
      return { status: 403, routeCode: 'payment_not_accessible' };
    case 'payment_not_cancelable':
      return { status: 409, routeCode: 'payment_not_cancelable' };
    case 'processor_unavailable':
      return { status: 502, routeCode: 'processor_unavailable' };
    default:
      return { status: 500, routeCode: 'internal_error' };
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const requestId = requestIdFromHeaders(request.headers);
  const correlationId = randomUUID();

  // 1 — Member auth.
  let memberCtx: Awaited<ReturnType<typeof requireMemberContext>>;
  try {
    memberCtx = await requireMemberContext(request);
  } catch (e) {
    const code = (e as { code?: string } | null)?.code;
    if (code === 'forbidden_role') {
      return errorResponse(403, 'forbidden_role', correlationId);
    }
    if (code === 'unauthorized' || code === 'no-session') {
      return errorResponse(401, 'unauthorized', correlationId);
    }
    logger.error(
      { errKind: errKind(e), requestId, correlationId },
      'payments.cancel.member_context_throw',
    );
    return errorResponse(500, 'internal_error', correlationId);
  }
  if (memberCtx && 'response' in memberCtx && memberCtx.response) {
    return memberCtx.response;
  }
  // Audit 2026-04-25 finding #21: drop legacy casts; rely on
  // MemberContext discriminated-union narrowing.
  if (!memberCtx || 'response' in memberCtx) {
    return errorResponse(500, 'internal_error', correlationId);
  }

  const tenantCtx = resolveTenantFromRequest(request);
  const actorUserId = memberCtx.current.user.id;
  const actorRole = memberCtx.current.user.role as
    | 'admin'
    | 'manager'
    | 'member';
  const actorMemberId = memberCtx.memberId;

  // 2 — Rate limit.
  const rl = await rateLimiter.check(
    `payments.cancel:${tenantCtx.slug}:${actorUserId}`,
    20,
    300,
  );
  if (!rl.success) {
    const retryAfterSeconds = retryAfterSecondsFromRl(rl);
    logger.warn(
      { tenantId: tenantCtx.slug, userId: actorUserId, requestId, correlationId, reset: rl.reset },
      'payments.cancel.rate_limited',
    );
    // Threat F-09 — emit an append-only audit row so spamming cancel
    // leaves a forensic trail. Best-effort: never 5xx the route
    // because the audit write failed.
    //
    // Migrated post-PR #20 review from F1 generic `auditRepo.append`
    // to F5 typed `f5AuditAdapter.emit` (see initiate/route.ts for
    // rationale).
    try {
      await f5AuditAdapter.emit(null, {
        tenantId: tenantCtx.slug,
        requestId,
        eventType: 'payment_cancel_rate_limited',
        actorUserId: actorUserId as ActorRef,
        summary: `payments.cancel rate-limited for tenant=${tenantCtx.slug}`,
        payload: {},
        retentionYears: f5RetentionFor('payment_cancel_rate_limited'),
      });
    } catch (e) {
      logger.error(
        {
          errKind: errKind(e),
          correlationId,
          tenantId: tenantCtx.slug,
        },
        'payments.cancel.rate_limited_audit_failed',
      );
    }
    return errorResponse(429, 'rate_limited', correlationId, { retryAfterSeconds });
  }

  // 3 — Parse [id] from URL.
  // Audit 2026-04-25 finding #22: use Domain `parsePaymentId` so the
  // route + Domain share a single source of truth for the ULID-like
  // shape (payment.ts RE_ULID_LIKE). Previous duplicated regex had
  // already drifted in spirit (no comment binding the two).
  const resolvedParams = await params;
  const parsed = parsePaymentId(resolvedParams.id ?? '');
  if (!parsed.ok) {
    return errorResponse(400, 'invalid_input', correlationId);
  }
  const paymentId = parsed.value;

  // 4 — Use-case.
  try {
    const deps = makeCancelPaymentDeps(tenantCtx.slug);
    const result = await cancelPayment(deps, {
      tenantId: tenantCtx.slug,
      actorUserId,
      actorRole,
      actorMemberId,
      paymentId,
      requestId,
    });

    if (result.ok) {
      return NextResponse.json(
        {
          payment: {
            id: result.value.paymentId,
            status: result.value.status,
            completedAt: result.value.completedAt,
          },
          correlationId,
        },
        { status: 200, headers: baseHeaders(correlationId) },
      );
    }

    const errCode = result.error.code;
    const { status, routeCode } = httpStatusForUseCaseError(errCode);
    // R3: shared telemetry extractor — cancel's error union has no
    // `kind` field, so `processorErrorKind === undefined` triggers
    // the helper's "default-to-30s back-off on `processor_unavailable`"
    // branch (matches cancel's prior behaviour byte-identically).
    const { processorErrorKind, processorErrorReason, retryAfterSeconds } =
      buildUseCaseErrorTelemetry(result.error);
    logger.warn(
      {
        requestId,
        correlationId,
        tenantId: tenantCtx.slug,
        userId: actorUserId,
        paymentId,
        useCaseErrorCode: errCode,
        httpStatus: status,
        routeCode,
        ...(processorErrorKind ? { processorErrorKind } : {}),
        ...(processorErrorReason ? { processorErrorReason } : {}),
      },
      'payments.cancel.use_case_error',
    );
    return errorResponse(
      status,
      routeCode,
      correlationId,
      retryAfterSeconds !== undefined ? { retryAfterSeconds } : undefined,
    );
  } catch (e) {
    logger.error(
      {
        errKind: errKind(e),
        requestId,
        correlationId,
        tenantId: tenantCtx.slug,
      },
      'payments.cancel.unexpected_throw',
    );
    return errorResponse(500, 'internal_error', correlationId);
  }
}
