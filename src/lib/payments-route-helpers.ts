/**
 * Shared response-shape helpers for F5 payment + refund route handlers
 *
 * Eliminates the duplicated `baseHeaders` + `errorResponse` boilerplate
 * previously inlined in:
 *   - `src/app/api/payments/initiate/route.ts`
 *   - `src/app/api/payments/[id]/cancel/route.ts`
 *   - `src/app/api/refunds/initiate/route.ts`
 *   - `src/app/api/webhooks/stripe/route.ts` (baseHeaders only)
 *
 * The contract these helpers enforce is the F5 response-headers
 * baseline that every route MUST honour:
 *   - `X-Correlation-Id`     — always present (echoed if request supplied)
 *   - `Cache-Control`        — `no-store, private` (PCI: payment-flow
 *                              responses must never enter shared caches)
 *   - `Retry-After`          — only on `429 rate_limited` and on retryable
 *                              `502 processor_unavailable` (Q2 fold-in:
 *                              derivation lives here, not at call sites)
 *
 * Centralising the shape prevents the contract from drifting per-route
 * (e.g. one route forgetting `Cache-Control` after a future copy-paste).
 */
import { NextResponse } from 'next/server';
import {
  messagesFor,
  type F5RouteErrorCode,
} from '@/lib/payments-errors-i18n';

/**
 * Standard response headers every F5 route MUST set.
 *
 * `extra` is merged after the baseline; callers cannot accidentally
 * drop `Cache-Control` / `X-Correlation-Id` even by passing `extra`
 * keys that look similar.
 */
export function baseHeaders(
  correlationId: string,
  extra?: Record<string, string>,
): HeadersInit {
  return {
    'Cache-Control': 'no-store, private',
    'X-Correlation-Id': correlationId,
    ...(extra ?? {}),
  };
}

export interface ErrorResponseExtra {
  /**
   * Seconds the client should wait before retrying. Set on 429
   * `rate_limited` and on retryable 502 `processor_unavailable`.
   * Permanent processor failures + idempotency conflicts MUST NOT
   * carry this header (would mislead upstream proxies + monitoring
   * into thinking a retry would help).
   */
  readonly retryAfterSeconds?: number;
  /**
   * Per-field validation messages from a zod `safeParse` error,
   * keyed by JSONPath. Surfaces only on 400 `invalid_input`.
   */
  readonly fieldErrors?: Record<string, string[]>;
}

/**
 * Build a JSON error response with the F5 envelope shape:
 *
 *     {
 *       error: { code, message, messageThai, fieldErrors? },
 *       correlationId
 *     }
 *
 * Every error response across F5 routes flows through this helper so
 * the bilingual `message` + `messageThai` pair, the `correlationId`,
 * and the `Cache-Control` / `X-Correlation-Id` / `Retry-After`
 * headers stay consistent. Spec authority:
 * `specs/009-online-payment/contracts/payments-api.md` § 4.
 */
export function errorResponse(
  status: number,
  code: F5RouteErrorCode,
  correlationId: string,
  extra?: ErrorResponseExtra,
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
  const extraHeaders: Record<string, string> = {};
  if (extra?.retryAfterSeconds !== undefined) {
    extraHeaders['Retry-After'] = String(extra.retryAfterSeconds);
  }
  return NextResponse.json(body, {
    status,
    headers: baseHeaders(correlationId, extraHeaders),
  });
}

/**
 * PCI / log-hygiene telemetry extractor for use-case error results
 *
 * Replaces the ternary-chain copy that appeared verbatim in 3 routes
 * (`payments/initiate`, `refunds/initiate`, `payments/[id]/cancel`)
 * for processing the closed-union error shape returned by every F5
 * use-case:
 *
 *     | { code: 'processor_unavailable'; kind?: 'retryable' | 'permanent' | 'idempotency_conflict'; reason: string }
 *     | { code: '<other>'; ... }
 *
 * Returns:
 *   - `processorErrorKind` — bounded discriminator for log payload
 *     (`undefined` on error codes other than `processor_unavailable`,
 *     and on cancel-payment's variant which lacks the `kind` field)
 *   - `processorErrorReason` — closed-union literal for log payload
 *     (NEVER raw Stripe SDK text — every F5 use-case's
 *     `reason` is a typed literal-union)
 *   - `retryAfterSeconds` — `30` for retryable processor failures (or
 *     for any `processor_unavailable` on routes whose error union
 *     lacks a `kind` field, e.g. cancel-payment); `undefined` for
 *     permanent failures, idempotency conflicts, F4 bridge errors,
 *     and non-processor errors. Permanent / non-retryable failures
 *     MUST NOT carry Retry-After (would mislead upstream proxies +
 *     monitoring into thinking a retry would help).
 */
export function buildUseCaseErrorTelemetry(error: {
  readonly code: string;
  readonly kind?: unknown;
  readonly reason?: unknown;
}): {
  readonly processorErrorKind: string | undefined;
  readonly processorErrorReason: string | undefined;
  readonly retryAfterSeconds: number | undefined;
} {
  const isProcessorUnavailable = error.code === 'processor_unavailable';
  const processorErrorKind =
    isProcessorUnavailable && typeof error.kind === 'string'
      ? error.kind
      : undefined;
  const processorErrorReason =
    isProcessorUnavailable && typeof error.reason === 'string'
      ? error.reason
      : undefined;
  const retryAfterSeconds =
    isProcessorUnavailable &&
    (processorErrorKind === 'retryable' || processorErrorKind === undefined)
      ? 30
      : undefined;
  return { processorErrorKind, processorErrorReason, retryAfterSeconds };
}
