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
import {
  messagesFor,
  type F5RouteErrorCode,
} from '@/lib/payments-errors-i18n';
import { auditRepo, type ActorRef } from '@/lib/stripe-webhook-deps';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// ---------------------------------------------------------------------------
// zod schema — mirrors contracts/payments-api.md § 1 InitiatePaymentInput.
// Kept inline (not cross-imported) because client-side parsing is not
// needed; the PaySheet drawer (Group G) posts opaque ids + a method enum.
// ---------------------------------------------------------------------------
const InitiatePaymentBody = z.object({
  invoiceId: z.string().min(20).max(40),
  method: z.enum(['card', 'promptpay']),
});

// ---------------------------------------------------------------------------
// Response helpers — every response shares the same header set so no
// branch can accidentally drop `X-Correlation-Id` or `Cache-Control`.
// ---------------------------------------------------------------------------
function baseHeaders(correlationId: string, extra?: Record<string, string>): HeadersInit {
  return {
    'Cache-Control': 'no-store, private',
    'X-Correlation-Id': correlationId,
    ...(extra ?? {}),
  };
}

function errorResponse(
  status: number,
  code: F5RouteErrorCode,
  correlationId: string,
  extra?: { retryAfterSeconds?: number; fieldErrors?: Record<string, string[]> },
): NextResponse {
  const { message, messageThai } = messagesFor(code);
  const body: Record<string, unknown> = {
    error: {
      code,
      message,
      messageThai,
      ...(extra?.fieldErrors ? { fieldErrors: extra.fieldErrors } : {}),
    },
    correlationId,
  };
  const headers: Record<string, string> = {};
  if (extra?.retryAfterSeconds !== undefined) {
    headers['Retry-After'] = String(extra.retryAfterSeconds);
  }
  return NextResponse.json(body, {
    status,
    headers: baseHeaders(correlationId, headers),
  });
}

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

  const tenantCtx = resolveTenantFromRequest(request);
  const actorUserId =
    (memberCtx as { current?: { user?: { id?: string } } } | undefined)?.current?.user?.id ?? 'unknown';
  const actorMemberId =
    (memberCtx as { memberId?: string } | undefined)?.memberId ?? 'unknown';

  // 2 — Rate limit (after auth so anonymous spam is 401-ed by the
  // auth layer, but authenticated abuse burns the limiter bucket).
  const rl = await rateLimiter.check(
    `payments.initiate:${tenantCtx.slug}:${actorUserId}`,
    10,
    300,
  );
  if (!rl.success) {
    const retryAfterSeconds = Math.max(1, Math.ceil((rl.reset - Date.now()) / 1000));
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
      invoiceId: parsedBody.invoiceId,
      method,
      correlationId,
      requestId,
    });

    if (result.ok) {
      // The use-case can return either (a) the canonical flat shape
      // { payment, clientSecret, publishableKey, paymentIntentId,
      // promptpayQrSvgUrl, resumed } (Application layer) OR (b) a
      // pre-shaped `{ payment, stripe: {...} }` nested shape (test
      // doubles compose the response envelope up-front). Handle both.
      const value = result.value as unknown as Record<string, unknown>;
      const payment = value['payment'] as Record<string, unknown>;
      const nestedStripe = value['stripe'] as Record<string, unknown> | undefined;
      const stripe = nestedStripe ?? {
        publishableKey: value['publishableKey'],
        clientSecret: value['clientSecret'],
        paymentIntentId: value['paymentIntentId'],
        promptpayQrSvgUrl: value['promptpayQrSvgUrl'] ?? null,
      };
      // NOTE: `clientSecret` is a short-lived Stripe confirmation
      // token — it MUST be returned in the response body (the Elements
      // client needs it) but MUST NOT be logged. No pino log lines
      // carry it (T041 PCI structural guard).
      const initiatedAtRaw = payment['initiatedAt'];
      const initiatedAt =
        initiatedAtRaw instanceof Date
          ? initiatedAtRaw.toISOString()
          : String(initiatedAtRaw);
      return NextResponse.json(
        {
          payment: {
            id: payment['id'],
            invoiceId: payment['invoiceId'],
            method: payment['method'],
            status: payment['status'],
            amountSatang:
              typeof payment['amountSatang'] === 'bigint'
                ? Number(payment['amountSatang'])
                : payment['amountSatang'],
            currency: payment['currency'],
            attemptSeq: payment['attemptSeq'],
            initiatedAt,
            processorEnvironment: payment['processorEnvironment'],
          },
          stripe: {
            publishableKey: stripe['publishableKey'],
            clientSecret: stripe['clientSecret'],
            paymentIntentId: stripe['paymentIntentId'],
            promptpayQrSvgUrl: stripe['promptpayQrSvgUrl'] ?? null,
          },
          correlationId,
        },
        { status: 201, headers: baseHeaders(correlationId) },
      );
    }

    // Error branch.
    const errCode = result.error.code;
    const { status, routeCode } = httpStatusForUseCaseError(errCode);
    const retryAfterSeconds = routeCode === 'processor_unavailable' ? 30 : undefined;
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
