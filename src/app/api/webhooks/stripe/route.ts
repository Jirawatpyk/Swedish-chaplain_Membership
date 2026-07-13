/**
 * POST /api/webhooks/stripe (F5 / stripe-webhook.md § 3).
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
import { asSatang } from '@/lib/money';
import { requestIdFromHeaders } from '@/lib/request-id';
import { webhookVerifier, WebhookSignatureError } from '@/lib/stripe-webhook-verifier';
import { baseHeaders } from '@/lib/payments-route-helpers';
import {
  processWebhookEvent,
  makeProcessWebhookEventDeps,
  SYSTEM_ACTOR_STRIPE_WEBHOOK,
  type ProcessWebhookEventError,
  type VerifiedStripeEvent,
} from '@/modules/payments';
import {
  resolveTenantByProcessorAccountId,
  insertRejectedProcessorEvent as insertRejectedProcessorEventImpl,
  auditRepo,
} from '@/lib/stripe-webhook-deps';
// F5R3 CR-3 (2026-05-16) — direct F5 audit-adapter + retention helper
// import for the permanent-failure typed-payload emit. The route is a
// Stripe-side system surface so this is composition-root code (not
// Application — no Principle III violation). Convention across other
// composition-root files (page.tsx + api/.../route.ts) is to silence
// `no-restricted-imports` on the specific composition-root line.
 
import { f5AuditAdapter } from '@/modules/payments/infrastructure/audit/drizzle-payments-audit';
 
import {
  retentionFor as f5RetentionFor,
} from '@/modules/payments/application/ports/audit-port';
// F5R3 H-6 (2026-05-16) — single-source-of-truth allow-list shared
// with the F5 dispatcher (process-webhook-event.ts). Prevents drift
// between which event types are dispatched vs which trigger
// revalidatePath.
 
import { F5_HANDLED_EVENT_TYPES_SET } from '@/modules/payments/application/ports/webhook-verifier-port';
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

// F5R3 SIMPLIFY-L1 (2026-05-16) — single-use OK_RECEIVED const
// inlined at the call site (one place). `as const` preserved no
// observable behaviour through NextResponse.json's runtime
// stringification.

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
  // F5R3 CR-3 (2026-05-16) — `webhook_dispatch_permanent_failure`
  // moved off this helper into a direct `f5AuditAdapter.emit(null,
  // …)` call. Reason: F1's auditRepo.append doesn't persist the
  // JSONB `payload` column, so the typed payload promised in
  // F5AuditPayloadByType was silently dropped. The 3 events kept
  // here are TRUE pre-tenant-resolution rejections that don't have a
  // typed-payload contract (low-stakes ops events, F1-format
  // `{reason}` is sufficient).
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
    // webhook request because the audit row failed to persist. Use
    // constructor name only (Postgres errors can carry SQL params /
    // table names in .message).
    //
    // F5R1-E1 — emit a metric counter so SRE can alert on sustained
    // audit-rail outage. Without this counter, a chronic audit-write
    // failure would silently drop the forensic 5/10y compliance trail
    // for signature-rejection / api-version-mismatch / livemode-
    // mismatch events; pino logs roll off in 30 days. Mirrors the F8
    // `coordinatorAuditEmitFailed` pattern.
    paymentsMetrics.webhookRejectAuditFailed();
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
  return NextResponse.json({ received: true }, {
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

/**
 * Task C.4 / M-f — pure re-projection of the verifier's `dataObject`
 * into the allow-list shape forwarded to `processWebhookEvent`.
 *
 * Extracted verbatim (behaviour-preserving) from the POST handler,
 * where this rebuild used to be inlined. That inlining is how Bugs
 * #5 (`amountProjectionFailed` dropped) and #6 (`disputeId` dropped)
 * happened: the envelope is projected TWICE — once by the verifier's
 * own `project()`, and again here by copying a fixed allow-list of
 * known keys, which silently drops anything the allow-list forgot.
 * C.1/C.2 already closed those two specific gaps; this extraction
 * plus `tests/unit/payments/webhook-reprojection-superset.test.ts`
 * closes the whole BUG CLASS — the test builds a synthetic verifier
 * envelope with every optional `VerifiedStripeEvent['dataObject']`
 * key set and asserts each survives this function, so a future key
 * (e.g. PR-A's `refundStatus`) added to the verifier but forgotten
 * here fails CI instead of silently dropping in production.
 *
 * PCI SAQ-A: still an allow-list projection — only id-like cross-ref
 * fields + amount/error-code scalars are copied, never the wide
 * Stripe object.
 */
export function reprojectDataObject(
  rawDataObject: Record<string, unknown> | undefined,
): VerifiedStripeEvent['dataObject'] {
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
  // F5R2-M5 — narrow `last_payment_error` extraction so the wide
  // `Record<string, unknown>` object is NOT bound in the route's
  // local scope. PCI SAQ-A risk: future logger/response-body additions
  // could accidentally include the full Stripe error object (which
  // can carry card_brand, card_last4, decline reason text). Extract
  // ONLY the `code` string here; downstream consumers see a single
  // `lastPaymentErrorCode` field instead of the wide envelope.
  const lastPaymentErrorRawCode = (
    rawDataObject?.['last_payment_error'] as Record<string, unknown> | undefined
  )?.['code'];
  const lastPaymentErrorCodeFromVerifier = rawDataObject?.[
    'lastPaymentErrorCode'
  ] as string | undefined;
  const amountVal =
    rawDataObject?.['amount'] ?? rawDataObject?.['amountSatang'];

  return {
    id: String(rawDataObject?.['id'] ?? ''),
    type: String(
      rawDataObject?.['type'] ?? rawDataObject?.['object'] ?? '',
    ),
    // F5R1-IMP5 docstring — `latestChargeId` is absent from the
    // envelope when `extractLatestChargeId` returns undefined,
    // which covers BOTH "field missing" AND "field present but
    // not a string/object-with-id" (verifier's defensive null
    // projection for object-form charges). Downstream consumers
    // MUST NOT trust this field — `confirmPayment` + `failPayment`
    // both re-fetch the PI via `retrievePaymentIntent` for card
    // metadata. Documented here so a future consumer doesn't
    // start trusting the envelope without re-verifying via the
    // gateway.
    ...(latestCharge !== undefined && {
      latestChargeId: latestCharge,
    }),
    // Bug #6 fix (Task C.2) — the verifier sets `disputeId` on the
    // `charge.dispute.created` branch (see stripe-webhook-verifier.ts
    // `project()`'s dispute arm), but this re-projection previously
    // rebuilt `dataObject` from an allow-list that omitted it,
    // silently dropping it before `processWebhookEvent` could audit
    // the real dispute id — the `dispute_created` audit row recorded
    // `dispute_id: null` in production. PCI SAQ-A: this is an id-like
    // string only, never card/charge metadata.
    ...(rawDataObject?.['disputeId']
      ? { disputeId: String(rawDataObject['disputeId']) }
      : {}),
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
      : typeof lastPaymentErrorRawCode === 'string'
        ? { lastPaymentErrorCode: lastPaymentErrorRawCode }
        : {}),
    // F5R3 H-5 (2026-05-16) — brand at Stripe→Application boundary.
    ...(typeof amountVal === 'number' && {
      amountSatang: asSatang(BigInt(amountVal)),
    }),
    ...(typeof amountVal === 'bigint' && {
      amountSatang: asSatang(amountVal),
    }),
    // Bug #5 fix — preserve the verifier-set `amountProjectionFailed`
    // flag through this re-projection. In production `rawEvent` IS
    // the verifier's already-projected envelope (see comment above
    // this block), so `rawDataObject['amountProjectionFailed']` is
    // the flag `stripe-webhook-verifier.ts` `project()` set. Without
    // this copy, the H-4 dead-letter guard in
    // `process-charge-refunded.ts` never fires in prod because the
    // route silently dropped the flag on its way to the use-case.
    ...(rawDataObject?.['amountProjectionFailed'] === true
      ? { amountProjectionFailed: true }
      : {}),
    // PR-A Task A.9 (#1) — preserve the verifier-set `refundStatus`
    // through this re-projection. The `charge.refund.updated` verifier
    // arm (A.10) sets it; `processRefundUpdated` (A.11) needs it to
    // finalize a pending refund. Copied HERE (ahead of A.10) so the
    // single-projection superset guard already covers it and A.10 does
    // not have to re-add the copy. PCI SAQ-A: a bare status string only.
    ...(typeof rawDataObject?.['refundStatus'] === 'string'
      ? { refundStatus: rawDataObject['refundStatus'] }
      : {}),
  };
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
    // F5R2-TY-B — narrow via `instanceof WebhookSignatureError` (the
    // canonical Application-port error class) so a future variant
    // added to the `kind` union forces this consumer to handle it.
    // Pre-fix duck-type on `e.kind` accepted ANY object with a string
    // `kind` field — a thrown TypeError from an env-config bug
    // (e.g. `cannot read .secret of undefined`) silently became
    // `kind='bad_signature'` because TypeError has no `kind`. Now
    // genuine-but-non-shape exceptions fall to the else branch and
    // bump a distinct counter.
    let kind: WebhookSignatureError['kind'] | 'verifier_internal_error';
    if (e instanceof WebhookSignatureError) {
      kind = e.kind;
    } else {
      // Internal verifier error (env/config drift, OOM, undici fetch
      // crash). Pino-log the constructor name + bump a counter so
      // SRE distinguishes "Stripe sent bad signature" from "our
      // verifier exploded". Audit row still emitted via auditReject
      // so the forensic trail is consistent across both classes.
      logger.error(
        {
          err: e instanceof Error ? e.constructor.name : 'unknown',
          correlationId,
          requestId,
        },
        'stripe-webhook.verifier_internal_error',
      );
      kind = 'verifier_internal_error';
    }
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

  // Direct-event fallback — when SweCham (the platform-owner tenant)
  // creates a PaymentIntent, the gateway skips the `Stripe-Account`
  // header (see `connectOptions` in stripe-gateway.ts) so the event
  // fires on the platform account with `event.account === ''`.
  //
  // F5R1-IMP4 fix — gate the fallback on `env.tenant.slug ===
  // 'swecham'`. On a multi-tenant deploy (F11), an empty `event.account`
  // is NOT a missing-account-header signal — it is a malformed event
  // or a platform-owner event from a non-SweCham deployment. Falling
  // back to SweCham's account id would mis-route F11 tenant webhooks
  // to the SweCham tenant context. Multi-tenant deploys land here
  // with an empty account → tenant resolution returns null →
  // acknowledged_only path emits + 200-acks Stripe without state change.
  if (
    !evAccount &&
    env.stripe.accountIdSwecham &&
    env.tenant.slug === 'swecham'
  ) {
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

  const verifiedEvent: VerifiedStripeEvent = {
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
    dataObject: reprojectDataObject(rawDataObject),
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
    // F5R3 H-6 (2026-05-16) — single-source-of-truth membership check
    // against `F5_HANDLED_EVENT_TYPES_SET`. Pre-fix the inline OR
    // chain was a copy of the dispatcher's switch-case literal list;
    // adding a new event type to one but forgetting the other
    // silently dropped revalidation on the new branch. The Set lives
    // next to the dispatcher's typed `F5HandledEventType` union so
    // both consumers stay in lockstep.
    if (isOk && evType !== null && F5_HANDLED_EVENT_TYPES_SET.has(evType)) {
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
        // F5R3 CR-5 (2026-05-16) — explicit ops-visibility log on the
        // `auto_refund_given_up` outcome. The metric already fired at
        // the use-case level; this complements it with a queryable
        // pino line so SREs can correlate the give-up with surrounding
        // request-id context. Pino message starts with the runbook-
        // grep prefix so dashboards filtering on
        // 'stripe-webhook.auto_refund_given_up' surface this class
        // distinct from routine success.
        const outcomeKind = (result as {
          value?: { kind?: string };
        }).value?.kind;
        if (outcomeKind === 'auto_refund_given_up') {
          logger.error(
            {
              eventId: evId,
              eventType: evType,
              tenantId,
              correlationId,
              requestId,
              runbook: 'docs/runbooks/out-of-band-refund.md',
            },
            'stripe-webhook.auto_refund_given_up',
          );
        }
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
        // Upgrade warn → error: a persistent revalidate failure means
        // multi-tab/multi-user sync is silently degraded — admins won't
        // see new Paid/Refunded status without manual reload. Webhook
        // still returns 200 (markProcessed already committed) so Stripe
        // does not retry-storm a non-deliverable side-effect failure.
        //
        // F5R1-IMP3 — bump a metric counter so alert rules (attached
        // to OTel counters, not log strings) can fire on sustained
        // Next-cache outage. Plus H-4: use `e.constructor.name` not
        // `e.message` — Next.js cache errors are framework-level and
        // the raw string can carry path arguments; constructor name
        // is sufficient diagnostic + matches the H-4 hygiene rule
        // applied at every other catch in this file.
        paymentsMetrics.webhookRevalidatePathFailed();
        logger.error(
          {
            err: e instanceof Error ? e.constructor.name : 'unknown',
            eventId: evId,
            eventType: evType,
            correlationId,
          },
          'stripe-webhook.revalidate_path_failed',
        );
      }
    }

    if (!result.ok) {
      // Pipe `kind` discriminator into pino so ops dashboards can
      // filter dispatch failures by class (sub_use_case_error vs
      // dispatch_threw vs unknown_event_type_threw) without re-parsing
      // log lines.
      //
      // F5R2-CRIT-2 — narrow the result.error via the actual
      // `ProcessWebhookEventError` type via `!result.ok` Result-union
      // narrowing (the typed Result helper). Compile-time guarantee:
      // `permanence` is required on every err() site in
      // process-webhook-event.ts, so reading it directly cannot
      // return undefined. The pre-fix `(result as {ok?:boolean}).ok
      // === false` cast + `errorObj?.permanence ?? 'transient'`
      // defaulting was a safety net that erased the type-level
      // guarantee — if a future refactor accidentally dropped
      // `permanence` from one err site, the route would silently
      // mis-classify it as transient → Stripe 72h retry storm
      // regression. Importing + narrowing on the proper type makes
      // that regression a build error.
      const dispatchError: ProcessWebhookEventError = result.error;
      const permanence = dispatchError.permanence;
      logger.error(
        {
          eventId: evId,
          eventType: evType,
          tenantId,
          correlationId,
          requestId,
          dispatchFailureKind: dispatchError.kind,
          dispatchFailureDetail: dispatchError.detail,
          permanence,
        },
        'stripe-webhook.dispatch_failed',
      );
      // F5R1-E14 — metric counter for dispatch failure. Pino logs
      // alone roll off in 30 days; SRE alert rules attached to OTel
      // counters need this to fire on sustained dispatch failures
      // (permanence + kind labels split transient infra outages from
      // permanent F4 schema-drift class).
      paymentsMetrics.webhookDispatchFailed(permanence, dispatchError.kind);

      // F5R1-IMP2 — permanent errors must NOT cause Stripe retries
      // (72h retry storm + audit-log pollution). 200-ack with a
      // forensic flag in the response body so ops dashboards can
      // distinguish these from successful dispatches when scanning
      // Stripe's webhook delivery log. Transient errors stay 500 so
      // Stripe retries through the outage window.
      if (permanence === 'permanent') {
        // F5R3 CR-3 (2026-05-16) — emit through F5 audit-adapter
        // (typed payload persists in the JSONB `payload` column) NOT
        // F1 auditRepo.append (which only writes the `reason` string
        // and silently drops the typed shape promised by
        // F5AuditPayloadByType). Pre-fix R2-C2 wired this through
        // auditReject → auditRepo.append, leaving SRE queries that
        // pivot on `payload->>'dispatch_failure_kind'` returning zero
        // rows. The forensic data was visible only in pino logs +
        // the human-readable summary string — both rotate after 30d
        // while the audit row is supposed to carry 5y compliance
        // retention. The adapter's null-tx path is best-effort
        // (log-and-swallow + useCaseAuditEmitFailed counter), so the
        // 200-ack to Stripe is never blocked by audit-rail outage.
        await f5AuditAdapter.emit(null, {
          tenantId,
          requestId,
          eventType: 'webhook_dispatch_permanent_failure',
          actorUserId: SYSTEM_ACTOR_STRIPE_WEBHOOK,
          summary: `stripe webhook dispatch permanently failed: ${dispatchError.kind}/${dispatchError.detail}`,
          payload: {
            event_id: evId ?? 'unknown',
            stripe_event_type: evType ?? 'unknown',
            dispatch_failure_kind: dispatchError.kind,
            dispatch_failure_detail: dispatchError.detail,
          },
          retentionYears: f5RetentionFor('webhook_dispatch_permanent_failure'),
        });
        // F5R2-C2 — drop `detail` from response body to avoid leaking
        // F4 bridge taxonomy / internal error codes to the Stripe
        // Dashboard webhook delivery log (visible to anyone with
        // Stripe read access). The forensic detail is captured in
        // the audit row + pino log line + metric counter above.
        // Use baseHeaders() for consistent Cache-Control: no-store
        // across all branches (F5R2-L2 — PCI F-01 cache hygiene).
        return NextResponse.json(
          {
            ok: true,
            dispatched: false,
            reason: 'permanent_failure_acknowledged',
          },
          { status: 200, headers: baseHeaders(correlationId) },
        );
      }
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
