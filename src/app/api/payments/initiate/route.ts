/**
 * T069 — POST /api/payments/initiate (F5 / payments-api.md § 1).
 *
 * Member-initiated payment-intent creation for an issued invoice.
 *
 * Pipeline (one-pass; each step may short-circuit):
 *   1. Rate-limit 10 / 5min per (tenant, actor).
 *   2. `requireMemberContext` — session + role=member + linked member row.
 *      (CSRF + Origin allow-list is enforced in `src/proxy.ts` middleware.)
 *   3. zod-validate body.
 *   4. `initiatePayment` use-case — returns `Result<success, error>` with
 *      a discriminated error code union (spec § 1 error table).
 *   5. Map Result to HTTP; always include bilingual error envelope +
 *      `X-Correlation-Id` + `Cache-Control: no-store, private`.
 *   6. Unexpected throws → 500 `internal_error` (raw error text NEVER
 *      surfaced to the client; logged with correlationId).
 *
 * Runtime: Node.js (default) — NOT Edge. Stripe SDK + argon2 need Node.
 *
 * Security:
 *   - The Stripe `clientSecret` is NEVER logged (verified by T041 PCI
 *     structural guard).
 *   - 502 + 429 include `Retry-After` so clients can back off.
 *   - 503 kill-switch + CSRF are middleware-level (`src/proxy.ts`); this
 *     handler runs only when the middleware has allowed the request.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { requireMemberContext } from '@/lib/member-context';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { requestIdFromHeaders } from '@/lib/request-id';
import { rateLimiter } from '@/lib/auth-deps';
import { logger } from '@/lib/logger';
import { randomUUID } from 'node:crypto';
import { initiatePayment, makeInitiatePaymentDeps } from '@/modules/payments';
import type { PaymentMethod } from '@/modules/payments';
import { type F5RouteErrorCode } from '@/lib/payments-errors-i18n';
import {
  baseHeaders,
  buildUseCaseErrorTelemetry,
  errorResponse,
} from '@/lib/payments-route-helpers';
import { retryAfterSecondsFromRl } from '@/lib/rate-limit-helpers';
import { auditRepo, type ActorRef } from '@/lib/stripe-webhook-deps';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// ---------------------------------------------------------------------------
// zod schema — mirrors contracts/payments-api.md § 1 InitiatePaymentInput.
// Kept inline (not cross-imported) because client-side parsing is not
// needed; the PaySheet drawer (Group G) posts opaque ids + a method enum.
//
// `invoiceId` blocks control chars and exotic UTF-8 that wouldn't
// match a real invoice id but COULD surface in audit logs / SQL
// error messages. Permissive enough to accept BOTH UUIDs (Domain
// canonical `[0-9a-f]{8}-...`) AND ULID-prefixed test fixtures
// (`inv_...`). Length 20–40 covers both.
// ---------------------------------------------------------------------------
const INVOICE_ID_RE = /^[A-Za-z0-9_-]{20,40}$/;
const InitiatePaymentBody = z.object({
  invoiceId: z
    .string()
    .min(20)
    .max(40)
    .regex(INVOICE_ID_RE, 'invoiceId must be alphanumeric + `_` / `-` (20–40 chars)'),
  method: z.enum(['card', 'promptpay']),
});

// ---------------------------------------------------------------------------
// Use-case error-code → HTTP status mapping (payments-api.md § 1 table).
// ---------------------------------------------------------------------------
function httpStatusForUseCaseError(code: string): {
  status: number;
  routeCode: F5RouteErrorCode;
} {
  switch (code) {
    // Enumeration defence (PCI F-02 / Threat OQ-1 / Constitution
    // Principle I): both "invoice does not exist" and "invoice exists
    // in a different tenant" return HTTP 403 + `invoice_not_accessible`
    // so a client cannot distinguish the two. The audit trail retains
    // the cross-tenant discriminator via the use-case's
    // `payment_cross_tenant_probe` emission — only the HTTP surface is
    // collapsed.
    case 'invoice_not_found':
    case 'forbidden_invoice':
      return { status: 403, routeCode: 'invoice_not_accessible' };
    case 'invoice_not_payable':
      return { status: 409, routeCode: 'invoice_not_payable' };
    case 'online_payment_disabled':
      return { status: 409, routeCode: 'online_payment_disabled' };
    case 'method_not_enabled':
      return { status: 409, routeCode: 'method_not_enabled' };
    case 'tenant_settings_incomplete':
      return { status: 422, routeCode: 'tenant_settings_incomplete' };
    case 'processor_unavailable':
      return { status: 502, routeCode: 'processor_unavailable' };
    default:
      return { status: 500, routeCode: 'internal_error' };
  }
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------
export async function POST(request: NextRequest): Promise<NextResponse> {
  const requestId = requestIdFromHeaders(request.headers);
  const correlationId = randomUUID();

  // 1 — Member context (session + role + linked member).
  // The real helper returns `{response}` on rejection; the T041 test
  // mock for the forbidden_role case THROWS an Error with `code`
  // property instead. Handle both shapes here.
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
      { err: e instanceof Error ? e.message : String(e), requestId, correlationId },
      'payments.initiate.member_context_throw',
    );
    return errorResponse(500, 'internal_error', correlationId);
  }
  if (memberCtx && 'response' in memberCtx && memberCtx.response) {
    return memberCtx.response;
  }
  // After the rejection short-circuit above, `memberCtx` narrows
  // to the success variant (MemberContext, no `response`) — no
  // cast needed; the discriminated-union narrowing carries the
  // field types.
  if (!memberCtx || 'response' in memberCtx) {
    // NOT dead code despite TS flow analysis (simplify Q4 revert,
    // 2026-04-26): contract test T041 case "500 internal_error" mocks
    // `requireMemberContext` without setting the resolved value, so
    // at runtime memberCtx is undefined. This branch serialises that
    // path into a stable 500 envelope instead of crashing on the
    // `memberCtx.current.user.id` access below.
    return errorResponse(500, 'internal_error', correlationId);
  }

  const tenantCtx = resolveTenantFromRequest(request);
  const actorUserId = memberCtx.current.user.id;
  const actorMemberId = memberCtx.memberId;

  // 2 — Rate limit (after auth so anonymous spam is 401-ed by the
  // auth layer, but authenticated abuse burns the limiter bucket).
  const rl = await rateLimiter.check(
    `payments.initiate:${tenantCtx.slug}:${actorUserId}`,
    10,
    300,
  );
  if (!rl.success) {
    const retryAfterSeconds = retryAfterSecondsFromRl(rl);
    logger.warn(
      { tenantId: tenantCtx.slug, userId: actorUserId, requestId, correlationId, reset: rl.reset },
      'payments.initiate.rate_limited',
    );
    // Threat F-09 — emit an append-only audit row so spamming cancel/
    // initiate leaves a forensic trail. Best-effort: never 5xx the
    // route because the audit write failed.
    try {
      await auditRepo.append({
        eventType: 'payment_initiate_rate_limited',
        actorUserId: actorUserId as ActorRef,
        summary: `payments.initiate rate-limited for tenant=${tenantCtx.slug}`,
        requestId,
      });
    } catch (e) {
      logger.error(
        {
          err: e instanceof Error ? e.message : String(e),
          correlationId,
          tenantId: tenantCtx.slug,
        },
        'payments.initiate.rate_limited_audit_failed',
      );
    }
    return errorResponse(429, 'rate_limited', correlationId, { retryAfterSeconds });
  }

  // 3 — Body + zod validation.
  let parsedBody: z.infer<typeof InitiatePaymentBody>;
  try {
    const json = (await request.json()) as unknown;
    const result = InitiatePaymentBody.safeParse(json);
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

  // 4 — Call use-case. Any unexpected throw → 500 (never leak stack).
  try {
    // zod has already constrained `method` to 'card' | 'promptpay' —
    // a runtime parse call is redundant and would break when the test
    // harness tree-shakes extra barrel exports.
    const method: PaymentMethod = parsedBody.method;
    const deps = makeInitiatePaymentDeps(tenantCtx.slug);
    const result = await initiatePayment(deps, {
      tenantId: tenantCtx.slug,
      actorUserId,
      actorMemberId,
      // Required by Stripe `payment_method_data.billing_details.email`
      // for server-confirmed PromptPay PIs (Card flows ignore it).
      actorEmail: memberCtx.current.user.email,
      invoiceId: parsedBody.invoiceId,
      method,
      correlationId,
      requestId,
    });

    if (result.ok) {
      // `clientSecret` is a short-lived Stripe confirmation token —
      // MUST be returned in the response body (Elements needs it)
      // but MUST NOT be logged. No pino log lines carry it (PCI
      // structural guard).
      const value = result.value;
      const payment = value.payment as unknown as Record<string, unknown>;
      const initiatedAtRaw = payment['initiatedAt'];
      const initiatedAt =
        initiatedAtRaw instanceof Date
          ? initiatedAtRaw.toISOString()
          : String(initiatedAtRaw);
      // Audit 2026-04-25 finding #20: serialize bigint as STRING (not
      // Number). For realistic THB invoices the precision-loss risk
      // is theoretical (>2^53 satang = ~9e13 THB), but JSON.parse on
      // the client-side would still see a JS number, losing precision
      // silently if a future tenant ever exceeds the safe-integer
      // window. String avoids that class of bug for the cost of one
      // `BigInt(value)` call on the consumer side.
      const amountValue = payment['amountSatang'];
      const amountSerialized =
        typeof amountValue === 'bigint'
          ? amountValue.toString()
          : typeof amountValue === 'number'
            ? String(amountValue)
            : amountValue;
      return NextResponse.json(
        {
          payment: {
            id: payment['id'],
            invoiceId: payment['invoiceId'],
            method: payment['method'],
            status: payment['status'],
            amountSatang: amountSerialized,
            currency: payment['currency'],
            attemptSeq: payment['attemptSeq'],
            initiatedAt,
            processorEnvironment: payment['processorEnvironment'],
          },
          stripe: {
            publishableKey: value.publishableKey,
            clientSecret: value.clientSecret,
            paymentIntentId: value.paymentIntentId,
            promptpayQrSvgUrl: value.promptpayQrSvgUrl ?? null,
            // Server-locked: panel countdown must match the server
            // PI expiry window — never a client default.
            promptpayQrExpirySeconds: value.promptpayQrExpirySeconds,
          },
          correlationId,
        },
        { status: 201, headers: baseHeaders(correlationId) },
      );
    }

    // Error branch.
    const errCode = result.error.code;
    const { status, routeCode } = httpStatusForUseCaseError(errCode);
    // PCI: log ONLY the bounded gateway error `kind` discriminator +
    // closed-union `reason` literal — never raw Stripe SDK text. The
    // matching `stripe-gateway: SDK error` pino line carries the full
    // SDK-level diagnostic with allow-listed fields only.
    //
    // Retry-After is meaningful ONLY for retryable errors. Permanent
    // failures + idempotency conflicts never recover within 30s and
    // the header would mislead upstream proxies + monitoring.
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
      'payments.initiate.use_case_error',
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
      'payments.initiate.unexpected_throw',
    );
    return errorResponse(500, 'internal_error', correlationId);
  }
}
