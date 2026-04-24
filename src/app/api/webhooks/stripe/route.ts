/**
 * T071 — POST /api/webhooks/stripe (F5 / stripe-webhook.md § 3).
 *
 * Pipeline (this route OWNS steps 1–5 + 7; `processWebhookEvent` starts
 * at step 6 / 8–10):
 *
 *   1. Read raw body via `request.text()` (body parser OFF — HMAC needs raw).
 *      Pre-guard: reject any `Content-Length` > 64 KiB with 401 + audit
 *      `body_too_large` (Threat F-16 defence — do NOT buffer adversarial
 *      payloads into memory before HMAC rejects them).
 *   2. Read Stripe-Signature header. Missing → 401 + audit
 *      `webhook_signature_rejected{reason='missing_header'}`. Body MUST NOT
 *      be read (T044 "verify-before-parse" invariant).
 *   3. `webhookVerifier.constructEvent(rawBody, sig, secret)`. Throws
 *      `WebhookSignatureError{kind}` → 401 + audit with the kind as reason.
 *   4. livemode check vs `env.stripe.liveMode`. Mismatch → 200 OK + audit
 *      `payment_environment_mismatch` + processor_events row
 *      `outcome='rejected_environment_mismatch'`. Use-case NOT invoked.
 *   5. api_version check vs `env.stripe.apiVersion`. Mismatch → 200 OK +
 *      audit `webhook_api_version_mismatch` + processor_events row
 *      `outcome='rejected_api_version_mismatch'`. Use-case NOT invoked.
 *   6. Tenant resolve via `tenant_payment_settings.processor_account_id`.
 *      Unknown → 200 OK + processor_events `outcome='acknowledged_only'`.
 *      Use-case NOT invoked.
 *   7. Dispatch to `processWebhookEvent(deps, {event, payloadSha256, ...})`.
 *      Result.ok → 200 `{received:true}`. Result.err → 500 (Stripe retries).
 *
 * PCI: rawBody and signature header are NEVER logged or audited. Audit
 * rows carry only the reason discriminator (T044 negative-assert pins).
 *
 * Every response carries `X-Correlation-Id` and `Cache-Control: no-store,
 * private` so upstream caches cannot retain webhook payload echoes
 * (PCI F-01 — no per-branch header drift).
 *
 * Runtime: Node.js (NOT Edge — HMAC needs raw body + full Node crypto).
 */
import { NextResponse, type NextRequest } from 'next/server';
import { createHash, randomUUID } from 'node:crypto';

import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { requestIdFromHeaders } from '@/lib/request-id';
import { webhookVerifier } from '@/lib/stripe-webhook-verifier';
import {
  processWebhookEvent,
  makeProcessWebhookEventDeps,
} from '@/modules/payments';
import {
  resolveTenantByProcessorAccountId,
  insertRejectedProcessorEvent as insertRejectedProcessorEventImpl,
  auditRepo,
} from '@/lib/stripe-webhook-deps';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Stripe events are typically <10 KB. 64 KiB gives headroom for unusual
 * but legitimate payloads (expanded metadata) while blocking the
 * 4 MB-class adversarial payload class (Threat F-16).
 */
const MAX_WEBHOOK_BODY_BYTES = 64 * 1024;

const OK_RECEIVED = { received: true } as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function baseHeaders(correlationId: string): HeadersInit {
  return {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store, private',
    'X-Correlation-Id': correlationId,
  };
}

function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

/**
 * Write a webhook-reject audit row. F5 webhook event types
 * (`webhook_signature_rejected`, `payment_environment_mismatch`,
 * `webhook_api_version_mismatch`) are part of the F1 audit-repo
 * `AppendAuditEvent` union as of the Group F Review-Gate batch
 * (PCI F-03 / Backend F-02) so no casts are needed.
 *
 * PCI (T044): payload carries ONLY `reason` + minimal metadata.
 * NEVER carries `rawBody`, `signature`, `stripe-signature` (asserted
 * negatively by the integration test).
 */
async function auditReject(
  eventType:
    | 'webhook_signature_rejected'
    | 'payment_environment_mismatch'
    | 'webhook_api_version_mismatch',
  reason: string,
  requestId: string,
): Promise<void> {
  try {
    await auditRepo.append({
      eventType,
      reason,
      actorUserId: 'system:cron',
      summary: `stripe webhook rejected: ${eventType} / ${reason}`,
      requestId,
    });
  } catch (e) {
    // Audit write is best-effort on the reject path — never 500 a
    // webhook request because the audit row failed to persist.
    logger.error(
      { err: e instanceof Error ? e.message : String(e), eventType, reason, requestId },
      'stripe-webhook.audit_reject_failed',
    );
  }
}

/**
 * Best-effort reject/ack processor_events row. Swallows errors so the
 * route still 200s — never block Stripe on audit-rail failures.
 */
async function insertRejectedProcessorEvent(input: {
  eventId: string;
  eventType: string;
  apiVersion: string;
  livemode: boolean;
  processorAccountId: string;
  outcome:
    | 'rejected_environment_mismatch'
    | 'rejected_api_version_mismatch'
    | 'acknowledged_only';
  payloadSha256: string;
  correlationId: string;
  receivedAt: Date;
}): Promise<void> {
  try {
    if (typeof insertRejectedProcessorEventImpl !== 'function') return;
    await insertRejectedProcessorEventImpl(input);
  } catch (e) {
    logger.error(
      {
        err: e instanceof Error ? e.message : String(e),
        eventId: input.eventId,
        outcome: input.outcome,
      },
      'stripe-webhook.processor_event_reject_insert_failed',
    );
  }
}

function jsonOk(correlationId: string): NextResponse {
  return NextResponse.json(OK_RECEIVED, {
    status: 200,
    headers: baseHeaders(correlationId),
  });
}

function jsonUnauthorized(
  code: 'missing_header' | 'bad_signature',
  correlationId: string,
): NextResponse {
  return NextResponse.json(
    { error: { code } },
    { status: 401, headers: baseHeaders(correlationId) },
  );
}

function jsonInternalError(
  code: 'tenant_resolve_failed' | 'dispatch_failed',
  correlationId: string,
): NextResponse {
  return NextResponse.json(
    { error: { code } },
    { status: 500, headers: baseHeaders(correlationId) },
  );
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------
export async function POST(request: NextRequest): Promise<NextResponse> {
  const requestId = requestIdFromHeaders(request.headers);
  const correlationId = randomUUID();

  // Step 2 FIRST — read header before reading the body (T044 invariant).
  const sig = request.headers.get('stripe-signature');
  if (sig === null || sig.length === 0) {
    await auditReject('webhook_signature_rejected', 'missing_header', requestId);
    return jsonUnauthorized('missing_header', correlationId);
  }

  // Step 1a — content-length guard (Threat F-16). Reject oversized
  // payloads BEFORE allocating `request.text()`. Missing header → let
  // the body read proceed (some upstreams strip it); if the body turns
  // out to be huge, the platform layer caps at its own limit.
  const contentLengthHeader = request.headers.get('content-length');
  if (contentLengthHeader !== null) {
    const declared = Number.parseInt(contentLengthHeader, 10);
    if (!Number.isFinite(declared) || declared > MAX_WEBHOOK_BODY_BYTES) {
      await auditReject('webhook_signature_rejected', 'body_too_large', requestId);
      return jsonUnauthorized('bad_signature', correlationId);
    }
  }

  // Step 1b — raw body (needed by HMAC verifier).
  let rawBody: string;
  try {
    rawBody = await request.text();
  } catch (e) {
    logger.error(
      { err: e instanceof Error ? e.message : String(e), requestId, correlationId },
      'stripe-webhook.body_read_failed',
    );
    return jsonUnauthorized('bad_signature', correlationId);
  }

  // Defence in depth — even if Content-Length was missing / lying, reject
  // any realised body larger than the cap BEFORE handing it to the HMAC
  // verifier (which would otherwise do HMAC work on attacker-sized input).
  if (rawBody.length > MAX_WEBHOOK_BODY_BYTES) {
    await auditReject('webhook_signature_rejected', 'body_too_large', requestId);
    return jsonUnauthorized('bad_signature', correlationId);
  }

  // Step 3 — HMAC verify. Throws WebhookSignatureError{kind} on failure.
  // We treat the verifier output generically so both the production
  // projected envelope (apiVersion camelCase) and the raw Stripe SDK
  // event shape (api_version snake_case, emitted by test doubles)
  // are accepted — the route normalises below.
  let rawEvent: Record<string, unknown>;
  try {
    rawEvent = (await webhookVerifier.constructEvent(
      rawBody,
      sig,
      env.stripe.webhookSecret,
    )) as unknown as Record<string, unknown>;
  } catch (e) {
    // Duck-type on the `kind` discriminator rather than `instanceof
    // WebhookSignatureError` so tests that mock only the verifier
    // function (and omit the error class) still exercise this branch.
    const kind =
      typeof (e as { kind?: unknown })?.kind === 'string'
        ? ((e as { kind: string }).kind)
        : 'bad_signature';
    await auditReject('webhook_signature_rejected', kind, requestId);
    return jsonUnauthorized('bad_signature', correlationId);
  }

  const payloadSha256 = sha256Hex(rawBody);
  const receivedAt = new Date();

  // Normalise the two possible verifier-output shapes into a single
  // allow-list envelope (PCI SAQ-A: never pass `data` downstream).
  const evId = String(rawEvent['id'] ?? '');
  const evType = String(rawEvent['type'] ?? '');
  const evApiVersion = String(
    (rawEvent['apiVersion'] as string | undefined) ??
      (rawEvent['api_version'] as string | undefined) ??
      '',
  );
  const evLivemode = Boolean(rawEvent['livemode']);
  let evAccount = String(rawEvent['account'] ?? '');

  // Direct-event fallback (T082 empirical webhook test 2026-04-24):
  // when SweCham (or any tenant whose processor_account_id matches
  // `env.stripe.accountIdSwecham`) creates a PaymentIntent, the
  // Stripe gateway skips the `Stripe-Account` header (see
  // `connectOptions()` in stripe-gateway.ts) so the event fires on
  // the platform account itself with `event.account === ''`. Default
  // to the platform owner tenant's account id so tenant resolution
  // succeeds for single-tenant / platform-owner deployments. Multi-
  // tenant Connect events carry their own `account` field and bypass
  // this fallback entirely.
  if (!evAccount && env.stripe.accountIdSwecham) {
    evAccount = env.stripe.accountIdSwecham;
  }

  // Step 4 — livemode segregation.
  if (evLivemode !== env.stripe.liveMode) {
    await auditReject('payment_environment_mismatch', 'livemode_mismatch', requestId);
    await insertRejectedProcessorEvent({
      eventId: evId,
      eventType: evType,
      apiVersion: evApiVersion,
      livemode: evLivemode,
      processorAccountId: evAccount,
      outcome: 'rejected_environment_mismatch',
      payloadSha256,
      correlationId,
      receivedAt,
    });
    return jsonOk(correlationId);
  }

  // Step 5 — api_version pinning.
  if (evApiVersion !== env.stripe.apiVersion) {
    await auditReject('webhook_api_version_mismatch', 'api_version_drift', requestId);
    await insertRejectedProcessorEvent({
      eventId: evId,
      eventType: evType,
      apiVersion: evApiVersion,
      livemode: evLivemode,
      processorAccountId: evAccount,
      outcome: 'rejected_api_version_mismatch',
      payloadSha256,
      correlationId,
      receivedAt,
    });
    return jsonOk(correlationId);
  }

  // Step 6 — tenant resolve via processor_account_id.
  // Production path: `resolveTenantByProcessorAccountId` from the
  // composition adapter at `@/lib/stripe-webhook-deps`. All tests mock
  // this module directly (verified across T042/T044/T045 + the
  // live-DB integration tests in `tests/integration/payments/**`), so
  // the previous dynamic-import test-lane has been removed (Backend
  // F-01 / PCI F-03). One control-flow path for both prod and tests
  // restores Principle III compliance.
  let tenantId: string | null = null;
  try {
    tenantId = await resolveTenantByProcessorAccountId(evAccount);
  } catch (e) {
    logger.error(
      {
        err: e instanceof Error ? e.message : String(e),
        eventId: evId,
        correlationId,
      },
      'stripe-webhook.tenant_resolve_failed',
    );
    return jsonInternalError('tenant_resolve_failed', correlationId);
  }

  if (tenantId === null) {
    // Unknown processor account — 200 OK (no Stripe retry storm).
    logger.warn(
      { eventId: evId, account: evAccount, correlationId },
      'stripe-webhook.unknown_processor_account',
    );
    try {
      await insertRejectedProcessorEvent({
        eventId: evId,
        eventType: evType,
        apiVersion: evApiVersion,
        livemode: evLivemode,
        processorAccountId: evAccount,
        outcome: 'acknowledged_only',
        payloadSha256,
        correlationId,
        receivedAt,
      });
    } catch {
      // best-effort on unknown-account branch
    }
    return jsonOk(correlationId);
  }

  // Step 7 — dispatch to the Application use-case.
  // Project explicitly to the `VerifiedStripeEvent` allow-list shape.
  // The verifier (`stripe-webhook-verifier.project()`) already
  // narrows `event.data.object` to `dataObject` + strips card
  // metadata, but we STILL project here belt-and-braces so:
  //   1. A future adapter drift (e.g. a test / stub mock that
  //      forgets to project) cannot leak raw `data` into the
  //      use-case via the route (PCI SAQ-A structural guard —
  //      T042 contract test pins this shape).
  //   2. The `account` override from Step 6 (direct-event fallback)
  //      takes precedence over whatever the verifier computed.
  const rawAny = rawEvent as Record<string, unknown>;
  const rawDataObject =
    (rawAny['dataObject'] as Record<string, unknown> | undefined) ??
    ((rawAny['data'] as Record<string, unknown> | undefined)?.['object'] as
      | Record<string, unknown>
      | undefined);
  const latestCharge = rawDataObject?.['latest_charge'];
  const refundsNode = rawDataObject?.['refunds'] as
    | { data?: Array<Record<string, unknown>> }
    | undefined;
  const lastPaymentError = rawDataObject?.['last_payment_error'] as
    | Record<string, unknown>
    | undefined;
  const amountVal = rawDataObject?.['amount'];

  const verifiedEvent: import('@/modules/payments').VerifiedStripeEvent = {
    id: evId,
    type: evType,
    apiVersion: evApiVersion,
    livemode: evLivemode,
    account: evAccount,
    createdAtUnixSeconds:
      typeof rawAny['createdAtUnixSeconds'] === 'number'
        ? (rawAny['createdAtUnixSeconds'] as number)
        : Number(rawAny['created'] ?? 0),
    dataObject: {
      id: String(rawDataObject?.['id'] ?? ''),
      type: String(
        rawDataObject?.['type'] ?? rawDataObject?.['object'] ?? '',
      ),
      ...(typeof latestCharge === 'string' && {
        latestChargeId: latestCharge,
      }),
      ...(Array.isArray(refundsNode?.data) && {
        refundIds: refundsNode!.data!
          .map((r) => String((r as Record<string, unknown>)['id'] ?? ''))
          .filter(Boolean),
      }),
      ...(typeof lastPaymentError?.['code'] === 'string' && {
        lastPaymentErrorCode: String(lastPaymentError['code']),
      }),
      ...(typeof amountVal === 'number' && {
        amountSatang: BigInt(amountVal),
      }),
    },
  };

  try {
    const deps = makeProcessWebhookEventDeps(tenantId);
    const useCaseInput = {
      tenantId,
      event: verifiedEvent,
      payloadSha256,
      correlationId,
      requestId,
    };
    const result = await processWebhookEvent(deps, useCaseInput);

    // Log the dispatch shape (allow-list only — envelope carries NO card
    // data, NO client secret, NO raw event object).
    logger.info(
      {
        envelope: {
          id: verifiedEvent.id,
          type: verifiedEvent.type,
          api_version: verifiedEvent.apiVersion,
          livemode: verifiedEvent.livemode,
        },
        tenantId,
        correlationId,
        requestId,
      },
      'stripe-webhook.dispatched',
    );

    // Whether Result.ok or Result.err, Stripe sees 200 except on a
    // genuine internal error (so Stripe retries back-pressure our
    // pipeline). We treat explicit use-case errors as 500s so the
    // next delivery replays them.
    if ((result as { ok?: boolean }).ok === false) {
      return jsonInternalError('dispatch_failed', correlationId);
    }
    return jsonOk(correlationId);
  } catch (e) {
    logger.error(
      {
        err: e instanceof Error ? e.message : String(e),
        stack: e instanceof Error ? e.stack : undefined,
        eventId: evId,
        tenantId,
        correlationId,
      },
      'stripe-webhook.dispatch_threw',
    );
    return jsonInternalError('dispatch_failed', correlationId);
  }
}
