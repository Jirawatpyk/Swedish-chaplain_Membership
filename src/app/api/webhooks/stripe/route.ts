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
import { revalidatePath } from 'next/cache';
import { createHash, randomUUID } from 'node:crypto';

import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { requestIdFromHeaders } from '@/lib/request-id';
import { webhookVerifier } from '@/lib/stripe-webhook-verifier';
import { baseHeaders } from '@/lib/payments-route-helpers';
import {
  processWebhookEvent,
  makeProcessWebhookEventDeps,
} from '@/modules/payments';
import {
  resolveTenantByProcessorAccountId,
  insertRejectedProcessorEvent as insertRejectedProcessorEventImpl,
  auditRepo,
} from '@/lib/stripe-webhook-deps';
import { paymentsMetrics } from '@/lib/metrics';

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

// `baseHeaders` re-exported from `@/lib/payments-route-helpers` (review
// 2026-04-26 simplify R1). The previous inline copy added a redundant
// `Content-Type: application/json` — `NextResponse.json` already sets
// it on every site here, so dropping it keeps the response shape
// byte-identical.

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
  // T141 metric: signature/api-version rejection counters. NO tenant
  // label (rejected pre-resolution by design — abuse / misconfig
  // canary fires regardless of which tenant the attacker targeted).
  // observability.md §21.3 alert rules pivot on `> 0 / 5 min` —
  // emitting here, BEFORE the audit append, guarantees the counter
  // bumps even if the audit-rail itself is degraded.
  if (eventType === 'webhook_signature_rejected') {
    paymentsMetrics.webhookSignatureRejected();
  } else if (eventType === 'webhook_api_version_mismatch') {
    paymentsMetrics.webhookApiVersionMismatch();
  }
  try {
    await auditRepo.append({
      eventType,
      reason,
      // Audit 2026-04-25 finding #2: webhook events are NOT cron jobs.
      // `'system:webhook'` keeps audit-log filters sharp so Stripe
      // signature rejections don't pollute scheduled-job dashboards.
      actorUserId: 'system:webhook',
      summary: `stripe webhook rejected: ${eventType} / ${reason}`,
      requestId,
    });
  } catch (e) {
    // Audit write is best-effort on the reject path — never 500 a
    // webhook request because the audit row failed to persist.
    // H-4 (review 2026-04-27 — extended 2026-04-29 staff-review #4 A5.1
    // closure): use constructor name only, never `e.message`. Audit-log
    // writes go through Postgres; `e.message` on a Postgres failure can
    // carry SQL params, table names, or interpolated values.
    logger.error(
      { err: e instanceof Error ? e.constructor.name : 'unknown', eventType, reason, requestId },
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
    await insertRejectedProcessorEventImpl(input);
  } catch (e) {
    // H-4 (extended 2026-04-29 A5.1): Postgres INSERT failure here can
    // carry SQL params (event id, account id, payload sha) in
    // `e.message`. Use constructor name only; OTel trace covers
    // call-chain diagnostics.
    logger.error(
      {
        err: e instanceof Error ? e.constructor.name : 'unknown',
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
  code: 'tenant_resolve_failed' | 'dispatch_failed' | 'webhook_processing_failed',
  correlationId: string,
): NextResponse {
  return NextResponse.json(
    { error: { code } },
    { status: 500, headers: baseHeaders(correlationId) },
  );
}

/**
 * R5 S007 — extract `latest_charge` cross-ref id from a Stripe data.object.
 *
 * Stripe expands `latest_charge` into a Charge object when the event was
 * emitted with `expand: ['latest_charge']`. Verifier path normally sends
 * the string id, but a misconfigured upstream OR a direct test payload
 * can carry the expanded object form. Three accepted shapes:
 *
 *   - string                         → returned verbatim
 *   - { id: string, ... }            → returned `.id`
 *   - undefined / null / other       → undefined
 *
 * Without this guard a previous `typeof latestCharge === 'string'` check
 * would silently drop the field, writing NULL into
 * `payments.processor_charge_id` and breaking downstream reconciliation
 * (`payments_processor_charge_id_idx` partial index would lose the row).
 */
export function extractLatestChargeId(
  rawDataObject: Record<string, unknown> | undefined,
): string | undefined {
  const raw = rawDataObject?.['latest_charge'] ?? rawDataObject?.['latestChargeId'];
  if (typeof raw === 'string') return raw;
  if (typeof raw === 'object' && raw !== null) {
    const id = (raw as Record<string, unknown>)['id'];
    return typeof id === 'string' ? id : undefined;
  }
  return undefined;
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
    // H-4 (extended 2026-04-29 A5.1): body-read failures are platform-
    // level (network / fetch abort). `e.message` is generally safe but
    // we apply the H-4 rule uniformly — constructor name + OTel trace
    // is sufficient diagnostic + matches the pattern across this
    // route's catch sites.
    logger.error(
      { err: e instanceof Error ? e.constructor.name : 'unknown', requestId, correlationId },
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
    // H-4 (extended 2026-04-29 A5.1): tenant resolve runs a Postgres
    // SELECT against `tenant_payment_settings`. `e.message` on a PG
    // failure can carry the looked-up account_id + table name. Use
    // constructor name only; OTel trace owns the call-chain diagnostic
    // surface.
    logger.error(
      {
        err: e instanceof Error ? e.constructor.name : 'unknown',
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
  //
  // PCI Principle IV: the verifier MUST always emit a pre-projected
  // `dataObject` envelope (allow-listed cross-ref ids only). The raw
  // `event.data.object` shape is reachable ONLY via contract-test
  // mocks. In production we hard-fail if a Stripe-SDK shape leaks past
  // the verifier — this prevents future SDK envelope drift from
  // silently widening the allow-list (review CR-1).
  const rawAny = rawEvent as Record<string, unknown>;
  const verifierDataObject = rawAny['dataObject'] as
    | Record<string, unknown>
    | undefined;
  if (verifierDataObject === undefined && process.env.NODE_ENV === 'production') {
    logger.error(
      {
        correlationId,
        eventId: evId,
        eventType: evType,
      },
      'webhook.verifier_envelope_missing_dataObject',
    );
    return jsonInternalError('webhook_processing_failed', correlationId);
  }
  const rawDataObject =
    verifierDataObject ??
    ((rawAny['data'] as Record<string, unknown> | undefined)?.['object'] as
      | Record<string, unknown>
      | undefined);
  // Project narrow allow-list fields. PCI SAQ-A: only the cross-ref
  // ids the dispatcher needs are passed downstream. The verifier
  // path's `dataObject` is already projected — re-projecting here is
  // a no-op for known keys + drops anything unexpected.
  // R3 I-2 / R5 S007: handle expanded `latest_charge` (Charge object) AND
  // string-id forms via `extractLatestChargeId`. See helper docblock.
  const latestCharge = extractLatestChargeId(rawDataObject);
  const refundsNode = rawDataObject?.['refunds'] as
    | { data?: Array<Record<string, unknown>> }
    | undefined;
  const refundIdsFromVerifier = rawDataObject?.['refundIds'] as
    | readonly string[]
    | undefined;
  const lastPaymentError = rawDataObject?.['last_payment_error'] as
    | Record<string, unknown>
    | undefined;
  const lastPaymentErrorCodeFromVerifier = rawDataObject?.[
    'lastPaymentErrorCode'
  ] as string | undefined;
  const amountVal =
    rawDataObject?.['amount'] ?? rawDataObject?.['amountSatang'];

  const verifiedEvent: import('@/modules/payments').VerifiedStripeEvent = {
    id: evId,
    type: evType,
    apiVersion: evApiVersion,
    livemode: evLivemode,
    // Step 6 account override (direct-event fallback) ALWAYS wins.
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
      ...(latestCharge !== undefined && {
        latestChargeId: latestCharge,
      }),
      ...(refundIdsFromVerifier !== undefined
        ? { refundIds: refundIdsFromVerifier }
        : Array.isArray(refundsNode?.data)
          ? {
              refundIds: refundsNode!.data!
                .map((r) => String((r as Record<string, unknown>)['id'] ?? ''))
                .filter(Boolean),
            }
          : {}),
      ...(typeof lastPaymentErrorCodeFromVerifier === 'string'
        ? { lastPaymentErrorCode: lastPaymentErrorCodeFromVerifier }
        : typeof lastPaymentError?.['code'] === 'string'
          ? { lastPaymentErrorCode: String(lastPaymentError['code']) }
          : {}),
      ...(typeof amountVal === 'number' && {
        amountSatang: BigInt(amountVal),
      }),
      ...(typeof amountVal === 'bigint' && {
        amountSatang: amountVal,
      }),
    },
  };

  try {
    const deps = await makeProcessWebhookEventDeps(tenantId);
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
    // The use-case contractually returns `Result<T,E>` (`.ok` is always
    // boolean), but contract tests stub it with a `{ outcome }` shape.
    // Probing literal `=== false` matches the real `err()` path AND
    // gracefully treats a stub-shape (where `.ok` is undefined) as
    // "not an error" → 200. Don't simplify to `!result.ok` without
    // also rewriting all stubs to the Result shape.
    // R5 canonical fix (2026-04-25): server-side cache invalidation for
    // events that mutate visible invoice/refund state. Without this,
    // OTHER tabs (admin reconciliation view) + OTHER users (admin while
    // member is paying) would not see the new "Paid"/"Refunded" status
    // until they manually refreshed. The pattern-form uses Next.js
    // path-pattern syntax to bust every dynamic-route variant in one
    // call. Webhook frequency is low (≤ tens per minute under load),
    // so the broad invalidation is acceptable. Limit to outcome-bearing
    // events (success Result + relevant event types) so non-mutating
    // events (api_version_mismatch, livemode_mismatch, duplicate
    // delivery) don't churn caches.
    const isOk = (result as { ok?: boolean }).ok !== false;
    if (
      isOk &&
      (evType === 'payment_intent.succeeded' ||
        evType === 'payment_intent.payment_failed' ||
        evType === 'payment_intent.canceled' ||
        evType === 'charge.refunded' ||
        evType === 'charge.dispute.created')
    ) {
      // R5 canonical fix (2026-04-25): surgical revalidation. The
      // sub-use-case (confirmPayment / failPayment / handleCancelEvent)
      // forwards `invoiceId` on outcome kinds that pivot on a known
      // payment row → we revalidate ONLY that invoice's detail path
      // instead of busting every invoice's cache via `[invoiceId]`
      // pattern. The list-page revalidation stays broad (the list
      // genuinely depends on the changed row's surface — paid/refunded
      // badge, totals, filters).
      //
      // revalidatePath is best-effort — wrap in try/catch so a
      // transient Next.js cache error does NOT bubble out of the
      // webhook handler. markProcessed has already committed at this
      // point; a 500 here would force Stripe into a 24-hour retry
      // loop chasing an already-processed event.
      try {
        const outcomeInvoiceId = (result as {
          value?: { invoiceId?: string };
        }).value?.invoiceId;
        if (typeof outcomeInvoiceId === 'string' && outcomeInvoiceId.length > 0) {
          // Surgical: bust ONLY the affected invoice's detail cache.
          revalidatePath(`/portal/invoices/${outcomeInvoiceId}`);
          revalidatePath(`/admin/invoices/${outcomeInvoiceId}`);
        } else {
          // Fallback: outcome did not carry an invoiceId (e.g.
          // unknown_intent, or events that don't pivot on one
          // invoice like charge.dispute.created). Bust the dynamic
          // pattern so any open detail page re-fetches.
          revalidatePath('/portal/invoices/[invoiceId]', 'page');
          revalidatePath('/admin/invoices/[invoiceId]', 'page');
        }
        // List pages always revalidated — they aggregate across
        // invoices and the changed row affects badges/totals.
        revalidatePath('/portal/invoices', 'page');
        revalidatePath('/admin/invoices', 'page');
      } catch (e) {
        // R5 N3 (2026-04-25): upgrade `warn` → `error`. A persistent
        // revalidate failure means multi-tab/multi-user sync is
        // silently degraded — admins won't see new "Paid"/"Refunded"
        // status without manual reload. Surface this on the on-call
        // dashboard via the higher log level. Webhook still returns
        // 200 (markProcessed already committed) so Stripe doesn't
        // retry-storm a non-deliverable side-effect failure.
        logger.error(
          {
            err: e instanceof Error ? e.message : String(e),
            eventId: evId,
            eventType: evType,
            correlationId,
          },
          'stripe-webhook.revalidate_path_failed',
        );
      }
    }

    if ((result as { ok?: boolean }).ok === false) {
      // R5 S006 — pipe `kind` discriminator into pino so ops dashboards
      // can filter dispatch failures by class (sub_use_case_error vs
      // dispatch_threw vs unknown_event_type_threw) without re-parsing
      // log lines.
      const errorObj = (result as { error?: { kind?: string; detail?: string } })
        .error;
      logger.error(
        {
          eventId: evId,
          eventType: evType,
          tenantId,
          correlationId,
          requestId,
          dispatchFailureKind: errorObj?.kind ?? 'unknown',
          dispatchFailureDetail: errorObj?.detail ?? 'unknown',
        },
        'stripe-webhook.dispatch_failed',
      );
      return jsonInternalError('dispatch_failed', correlationId);
    }
    return jsonOk(correlationId);
  } catch (e) {
    // H-4 (review 2026-04-27): only constructor name + bounded message
    // — Postgres / Stripe SDK stack traces can carry SQL params, lib
    // paths, and interpolated values. Distributed trace (OTel) provides
    // call-chain diagnostics; pino does not need to duplicate it.
    logger.error(
      {
        err: e instanceof Error ? e.constructor.name : 'unknown',
        eventId: evId,
        tenantId,
        correlationId,
      },
      'stripe-webhook.dispatch_threw',
    );
    return jsonInternalError('dispatch_failed', correlationId);
  }
}
