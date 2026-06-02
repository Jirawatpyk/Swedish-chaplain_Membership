/**
 * T111 — POST /api/refunds/initiate (F5 / Phase 6 / payments-api.md § 3).
 *
 * Admin-initiated refund against a succeeded Payment. Mirrors the
 * shape of `/api/payments/initiate` (T069); the differences are:
 *   - Auth via `requireAdminContext` (manager → 403)
 *   - Rate limit 20 / 5min per (tenant, actor) — looser than
 *     payment.initiate's 10/5min on purpose: legitimate admin batch-
 *     refund workflows (e.g. processing 6 cancellations after a
 *     board meeting) need headroom; a 4×/min sustained rate is well
 *     above any realistic throughput so abuse still trips the limit
 *   - 404 `payment_not_found` is NOT collapsed (admin-only surface;
 *     cross-tenant defended by RLS, not by HTTP-shape opacity)
 *   - 502 `f4_bridge_error` is a DISTINCT route code (not collapsed
 *     under `processor_unavailable`) so monitoring routes F4 CN-
 *     issuance failures to the F4 on-call channel
 *
 * Runtime: Node.js (Stripe SDK + argon2 require Node).
 */
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { requireAdminContext } from '@/lib/admin-context';
import { asSatang } from '@/lib/money';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { requestIdFromHeaders } from '@/lib/request-id';
import { rateLimiter } from '@/lib/auth-deps';
import { retryAfterSecondsFromRl } from '@/lib/rate-limit-helpers';
import { logger } from '@/lib/logger';
import { randomUUID } from 'node:crypto';
import {
  issueRefund,
  makeIssueRefundDeps,
  type IssueRefundError,
} from '@/modules/payments';
import { type F5RouteErrorCode } from '@/lib/payments-errors-i18n';
import {
  baseHeaders,
  buildUseCaseErrorTelemetry,
  errorResponse,
} from '@/lib/payments-route-helpers';
import {
  f5AuditAdapter,
  f5RetentionFor,
  type ActorRef,
} from '@/lib/stripe-webhook-deps';
import { errKind } from '@/lib/log-id';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// `paymentId` length 20–40 covers the Domain `RE_ULID_LIKE` regex; the
// use-case re-validates via `parsePaymentId` so a malformed string that
// passes this length check still fails downstream with `invalid_payment_id`.
//
// `amountSatang` accepts BOTH `number` (current 20M-THB cap fits safely
// inside `Number.MAX_SAFE_INTEGER`) AND `string` (BigInt-future-safe for
// tenants exceeding the safe-integer window). The output envelope
// already serialises bigint as string per audit finding #20 — the input
// union closes the symmetry so a tenant that exceeds the safe-integer
// window can post `"3000000000000"` (3T satang ≈ 30B THB) without
// silent precision loss. The use-case + DB schema are bigint-native.
//
// `reason` blocks CR/LF so the value renders cleanly in the credit-note
// PDF + audit log without forcing downstream consumers to escape newlines.
const REASON_NO_NEWLINE_RE = /^[^\r\n]+$/;
const AMOUNT_SATANG_MAX = 2_000_000_000n; // 20M THB cap — raise via spec amendment, not silent inflation
const InitiateRefundBody = z.object({
  paymentId: z.string().min(20).max(40),
  amountSatang: z
    .union([
      z.number().int().positive(),
      z.string().regex(/^\d+$/, 'amountSatang must be a positive integer string'),
    ])
    .transform((v) => BigInt(v))
    .refine((v) => v > 0n && v <= AMOUNT_SATANG_MAX, {
      message: `amountSatang must be > 0 and ≤ ${AMOUNT_SATANG_MAX}`,
    }),
  reason: z
    .string()
    .min(1)
    .max(500)
    .regex(REASON_NO_NEWLINE_RE, 'reason must be a single line'),
});

/**
 * Q5: typed switch — exhaustive over the use-case error union so a
 * future variant addition fails the build instead of silently falling
 * through to `internal_error`.
 */
function httpStatusForUseCaseError(code: IssueRefundError['code']): {
  status: number;
  routeCode: F5RouteErrorCode;
} {
  switch (code) {
    case 'invalid_payment_id':
      // Path-shape validation failure; surface as 400 invalid_input
      // so the client knows to re-check the request body rather than
      // the resource state.
      return { status: 400, routeCode: 'invalid_input' };
    case 'payment_not_found':
      return { status: 404, routeCode: 'payment_not_found' };
    case 'payment_not_refundable':
      return { status: 409, routeCode: 'payment_not_refundable' };
    case 'refund_exceeds_remaining':
      return { status: 409, routeCode: 'refund_exceeds_remaining' };
    case 'refund_in_progress':
      return { status: 409, routeCode: 'refund_in_progress' };
    case 'tenant_settings_missing':
      return { status: 422, routeCode: 'tenant_settings_incomplete' };
    case 'processor_unavailable':
      return { status: 502, routeCode: 'processor_unavailable' };
    case 'f4_bridge_error':
      // Q3: distinct route code so monitoring + UI can distinguish a
      // Stripe outage (re-try later) from an F4 CN-issuance failure
      // (Stripe refund DID succeed; ops follow up via the out-of-
      // band-refund runbook).
      return { status: 502, routeCode: 'f4_bridge_error' };
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const requestId = requestIdFromHeaders(request.headers);
  const correlationId = randomUUID();

  // F1: explicit `'refund'` resource +
  // `'write'` action — previously the call relied on the helper's
  // default `auth:user/write` policy which gates refunds via the
  // user-management permission. With a dedicated resource the RBAC
  // table (`auth/domain/policies.ts`) now expresses the actual
  // refund permission directly: admin-only, no read surface (the
  // refund-history view is part of the `payment` timeline resource).
  const adminCtx = await requireAdminContext(request, {
    resource: 'refund',
    action: 'write',
  });
  if ('response' in adminCtx && adminCtx.response) {
    return adminCtx.response as NextResponse;
  }

  const tenantCtx = resolveTenantFromRequest(request);
  const actorUserId = adminCtx.current.user.id;

  // 20/5min — looser than initiate-payment's 10/5min so legitimate
  // admin batch-refund workflows have headroom; abuse still trips
  // the limit since 4×/min sustained is well above realistic.
  const rl = await rateLimiter.check(
    `refunds.initiate:${tenantCtx.slug}:${actorUserId}`,
    20,
    300,
  );
  if (!rl.success) {
    const retryAfterSeconds = retryAfterSecondsFromRl(rl);
    logger.warn(
      { tenantId: tenantCtx.slug, userId: actorUserId, requestId, correlationId, reset: rl.reset },
      'refunds.initiate.rate_limited',
    );
    // n24 — forensic trail for the 429 in the append-only audit_log, mirroring
    // payments.initiate's `payment_initiate_rate_limited`. Fires before any
    // tenant tx, so it uses the F5 typed adapter directly (not runInTenant).
    // Best-effort: an audit hiccup must NOT change the 429 response.
    try {
      await f5AuditAdapter.emit(null, {
        tenantId: tenantCtx.slug,
        requestId,
        eventType: 'refund_initiate_rate_limited',
        actorUserId: actorUserId as ActorRef,
        summary: `refunds.initiate rate-limited for tenant=${tenantCtx.slug}`,
        payload: {},
        retentionYears: f5RetentionFor('refund_initiate_rate_limited'),
      });
    } catch (e) {
      logger.error(
        { errKind: errKind(e), correlationId, tenantId: tenantCtx.slug },
        'refunds.initiate.rate_limited_audit_failed',
      );
    }
    return errorResponse(429, 'rate_limited', correlationId, { retryAfterSeconds });
  }

  let parsedBody: z.infer<typeof InitiateRefundBody>;
  try {
    const json = (await request.json()) as unknown;
    const result = InitiateRefundBody.safeParse(json);
    if (!result.success) {
      const fieldErrors: Record<string, string[]> = {};
      for (const issue of result.error.issues) {
        const path = issue.path.join('.');
        (fieldErrors[path] ??= []).push(issue.message);
      }
      return errorResponse(400, 'invalid_input', correlationId, { fieldErrors });
    }
    parsedBody = result.data;
  } catch {
    return errorResponse(400, 'invalid_input', correlationId);
  }

  try {
    const deps = makeIssueRefundDeps(tenantCtx.slug);
    const result = await issueRefund(deps, {
      tenantId: tenantCtx.slug,
      paymentId: parsedBody.paymentId,
      // Schema's `.transform(BigInt)` already returned a bigint — pass
      // through directly. Number/string union accepted at boundary
      // (R002 polish — bigint-symmetric input, no silent precision
      // loss for tenants exceeding the safe-integer window).
      // F5R3 H-5 (2026-05-16) — brand at the HTTP boundary. Zod
      // already validated > 0 and integer; asSatang re-validates
      // non-negative as defence-in-depth.
      amountSatang: asSatang(parsedBody.amountSatang),
      reason: parsedBody.reason,
      actorUserId,
      correlationId,
      requestId,
    });

    if (result.ok) {
      const v = result.value;
      // Audit 2026-04-25 finding #20: serialise bigints as strings so
      // a future tenant exceeding the JS safe-integer window does not
      // silently lose precision in the JSON envelope.
      return NextResponse.json(
        {
          refund: {
            id: v.refund.id,
            paymentId: v.refund.paymentId,
            invoiceId: v.refund.invoiceId,
            amountSatang: v.refund.amountSatang.toString(),
            reason: v.refund.reason,
            status: v.refund.status,
            processorRefundId: v.refund.processorRefundId,
            creditNoteId: v.refund.creditNoteId,
            creditNoteNumber: v.refund.creditNoteNumber,
            completedAt: v.refund.completedAt,
          },
          payment: {
            id: v.payment.id,
            status: v.payment.status,
            refundedAmountSatang: v.payment.refundedAmountSatang.toString(),
            remainingRefundableSatang: v.payment.remainingRefundableSatang.toString(),
          },
          invoice: {
            id: v.invoice.id,
            status: v.invoice.status,
          },
          correlationId,
        },
        { status: 201, headers: baseHeaders(correlationId) },
      );
    }

    const errCode = result.error.code;
    const { status, routeCode } = httpStatusForUseCaseError(errCode);
    // PCI: log ONLY the bounded `kind` discriminator + closed-union
    // `reason` literal — never raw Stripe SDK text.
    const { processorErrorKind, processorErrorReason, retryAfterSeconds } =
      buildUseCaseErrorTelemetry(result.error);
    logger.warn(
      {
        requestId,
        correlationId,
        tenantId: tenantCtx.slug,
        userId: actorUserId,
        useCaseErrorCode: errCode,
        httpStatus: status,
        routeCode,
        ...(processorErrorKind ? { processorErrorKind } : {}),
        ...(processorErrorReason ? { processorErrorReason } : {}),
      },
      'refunds.initiate.use_case_error',
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
        err: e instanceof Error ? e.message : String(e),
        requestId,
        correlationId,
        tenantId: tenantCtx.slug,
        userId: actorUserId,
      },
      'refunds.initiate.unexpected_throw',
    );
    return errorResponse(500, 'internal_error', correlationId);
  }
}
