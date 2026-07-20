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

// #1 (2026-07-11) — bilingual self-describing copy for the 202 async-refund
// response. Route-internal API strings (mirrors the `payments-errors-i18n`
// const-table convention: kept out of the global i18n JSON to avoid
// inflating `check:i18n`). The admin UI renders its OWN localised toast
// (EN/TH/SV) via `admin.refund.success.pendingToast` off the 202 status.
const REFUND_PENDING_MESSAGE_EN =
  'Refund submitted — awaiting confirmation from the payment processor.';
const REFUND_PENDING_MESSAGE_TH =
  'ส่งคำขอคืนเงินแล้ว — กำลังรอการยืนยันจากผู้ให้บริการชำระเงิน';

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
    case 'f4_preflight_read_error':
      // B.1 review Fix#1: the PRE-FLIGHT F4 credited-total read failed BEFORE
      // any Stripe call — money did NOT move, the refund is safe to retry, and
      // NO orphaned out-of-band refund exists. Still 502 (a transient F4 read
      // failure), but a DISTINCT route code from `f4_bridge_error` so an
      // on-call does NOT hunt a non-existent orphaned refund via the
      // out-of-band-refund runbook. Retrying the same request is the fix.
      return { status: 502, routeCode: 'f4_preflight_read_error' };
    // I1 (Task 7) — 502 like its read-failure sibling (the fault is ours, not
    // the request's), but a DISTINCT code because the copy must not say
    // "retry". The gate axes could not be computed at all, so every identical
    // retry fails identically; the admin is told to contact support while the
    // bridge's dedicated metric pages SRE.
    case 'f4_preflight_gate_underivable':
      return { status: 502, routeCode: 'f4_preflight_gate_underivable' };
    // F-4 (money-remediation Task 7) — all three are 409, NEVER 502. The
    // refund was refused BEFORE Stripe: no money moved, no orphaned refund
    // exists, and retrying the identical request changes nothing. A 502 here
    // would read as "try again", which is exactly the click F-3 proved
    // expensive.
    //
    // Kept as three DISTINCT route codes rather than one collapsed code
    // because the operator response differs per axis (see each copy string).
    case 'f4_preflight_invalid_status':
      // Look at the invoice: it was voided after payment, or is already fully
      // credited.
      return { status: 409, routeCode: 'f4_preflight_invalid_status' };
    case 'f4_preflight_not_creditable':
      // Permanent (§105). A credit note is the wrong instrument for this
      // buyer; no amount of retrying or waiting changes that.
      return { status: 409, routeCode: 'f4_preflight_not_creditable' };
    case 'f4_preflight_receipt_rendering':
      // TRANSIENT, and the only receipt state that is: the async worker is
      // still `pending` and the reconcile cron sweeps stuck pending rows. The
      // copy says "wait", and here that is true.
      return { status: 409, routeCode: 'f4_preflight_receipt_rendering' };
    case 'f4_preflight_receipt_render_stuck':
      // NOT transient — `failed` or NULL. Distinct from its sibling because
      // the copy must say "escalate", not "wait". Telling an admin to wait a
      // few minutes for a render that will never happen strands the member's
      // money with nobody alerted, which is the defect C2 exists to remove.
      return { status: 409, routeCode: 'f4_preflight_receipt_render_stuck' };
    case 'f4_bridge_error':
      // Q3: distinct route code so monitoring + UI can distinguish a
      // Stripe outage (re-try later) from an F4 CN-issuance failure
      // (Stripe refund DID succeed; ops follow up via the out-of-
      // band-refund runbook).
      return { status: 502, routeCode: 'f4_bridge_error' };
    case 'f4_bridge_deferred':
      // Money-remediation F-3. Stripe SETTLED the refund; only the credit note
      // is outstanding and the stale-pending sweep retries it. Still 502
      // (the request did not fully complete) but a DISTINCT route code, and
      // therefore distinct copy: `f4_bridge_error`'s "issuance failed" reads
      // as retryable, and the admin retrying is precisely what turned this
      // into a double refund before the row stopped being marked `failed`.
      return { status: 502, routeCode: 'f4_bridge_deferred' };
    case 'refund_needs_reconciliation':
      // 409, NOT 502 — retrying changes nothing. A prior refund on this
      // payment settled at Stripe but was recorded `failed`, so the
      // remaining-refundable maths is blind to money that already left.
      // A human must reconcile via `docs/runbooks/out-of-band-refund.md`.
      return { status: 409, routeCode: 'refund_needs_reconciliation' };
    // S3 (Task 7 remediation) — exhaustiveness, asserted rather than implied.
    //
    // Today this switch is already total by structure: it has no `default:`,
    // the return type excludes `undefined`, and `noImplicitReturns` is on, so
    // a missing case fails the build. But that guarantee is one keystroke from
    // gone — anyone adding `default: return { status: 500, routeCode:
    // 'internal_error' }` (which reads as defensive hardening and would pass
    // review) silently converts every FUTURE missing case into a 500 on a
    // money surface.
    //
    // This arm survives that edit: there is already a default, so adding
    // another is a duplicate-case error, and the compile failure now NAMES the
    // unhandled variant instead of the opaque "lacks ending return statement".
    default: {
      const exhaustive: never = code;
      throw new Error(
        `httpStatusForUseCaseError: unhandled IssueRefundError code ${JSON.stringify(exhaustive)}`,
      );
    }
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
      // #1 (2026-07-11) — an async Stripe refund (`pending`/`requires_action`)
      // is NOT booked at creation time. Return 202 Accepted: the refund row
      // is `pending` with its processor id attached, and the eventual
      // `charge.refund.updated` webhook finalises it. Bilingual `message`
      // pair mirrors the error envelope; the admin UI shows its own
      // localised "awaiting confirmation" toast off the 202 status.
      if (v.kind === 'pending') {
        return NextResponse.json(
          {
            refund: {
              id: v.refund.id,
              status: v.refund.status,
              processorRefundId: v.refund.processorRefundId,
            },
            message: REFUND_PENDING_MESSAGE_EN,
            messageThai: REFUND_PENDING_MESSAGE_TH,
            correlationId,
          },
          { status: 202, headers: baseHeaders(correlationId) },
        );
      }
      // v.kind === 'succeeded' — credit note booked synchronously.
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
        // I8 (Task 7 remediation) — the `status` payload on
        // `f4_preflight_invalid_status` was documented as letting ops tell a
        // voided invoice from a fully-credited one "without a second query",
        // and then was never logged, never returned, and never read anywhere.
        // The docstring promised on-call a field that did not exist. Emit it.
        // Bounded enum (`draft|issued|paid|void|credited|partially_credited`)
        // — no PII, nothing to redact.
        ...(result.error.code === 'f4_preflight_invalid_status'
          ? { invoiceStatus: result.error.status }
          : {}),
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
        // Safe error classifier only — a raw e.message from a NeonDbError /
        // Stripe SDK error can carry SQL/schema fragments or endpoint URLs that
        // must not reach the log sink (same log-hygiene rule as n43 + L174).
        errKind: errKind(e),
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
