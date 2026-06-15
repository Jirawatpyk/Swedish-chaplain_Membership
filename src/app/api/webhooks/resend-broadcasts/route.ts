/**
 * T160 — POST /api/webhooks/resend-broadcasts (F7 US5).
 *
 * Resend Broadcasts delivery-event webhook ingest. Distinct surface
 * from the F1 transactional Resend webhook (`/api/webhooks/resend`):
 * separate Resend product, separate signing secret, separate
 * suppression list. NEVER cross the streams (FR-019).
 *
 * Pipeline (mirrors F5 stripe webhook with Svix HMAC instead of
 * Stripe-Signature):
 *
 *   1. Pre-guard: reject `Content-Length > 64 KiB` BEFORE buffering
 *      (defence against memory-exhaustion DoS) → 413 `body_too_large`.
 *   2. Read svix-signature / svix-id / svix-timestamp headers. Missing
 *      any → 401 + audit `broadcast_webhook_signature_rejected`. Body
 *      is NOT read (verify-before-parse invariant).
 *   3. Read raw body via `request.text()`. Realised-size > 64 KiB →
 *      413 `body_too_large` + audit (covers chunked / no-Content-Length).
 *   4. `webhookVerifier.constructEvent(...)` — Svix HMAC-SHA256.
 *      Throws `WebhookSignatureError{kind}` on any failure → 401 +
 *      audit with the kind as reason.
 *   5. Resolve tenant via `resend_broadcast_id` lookup (BYPASS RLS;
 *      schema owner). Unknown id → 200 OK + log + NULL-tenant audit
 *      `broadcast_webhook_signature_rejected` with
 *      `reason: 'unknown_resend_broadcast_id'` (review ERR-C1: forensic
 *      trail per FR-024). Both known + unknown paths return 200 with
 *      similar latency so the audit does not leak existence via timing.
 *   6. Build per-tenant deps + dispatch to `processWebhookEvent`.
 *   7. Result.ok → 200 `{received:true}`; Result.err → 500 (Resend
 *      retries with exponential backoff via Svix).
 *
 * Audit emission for signature rejects uses the F1 audit-repo (since
 * tenant is unknown at that stage); post-tenant audits land via the
 * F7 audit adapter inside the use-case tx.
 *
 * Runtime: **Node.js** (NOT Edge — HMAC needs raw body + full Node
 * crypto). Body parser OFF via `request.text()`.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { randomUUID } from 'node:crypto';

import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { broadcastsMetrics } from '@/lib/metrics';
import { broadcastsTracer } from '@/lib/otel-tracer';
import { SpanStatusCode } from '@opentelemetry/api';
import { requestIdFromHeaders } from '@/lib/request-id';
import {
  asBroadcastId,
  f7AuditAdapter,
  makeProcessWebhookEventDeps,
  processWebhookEvent,
  resendBroadcastsWebhookVerifier,
  resolveTenantByResendBroadcastId,
  WebhookSignatureError,
  // F7.1a Phase 3 T057 — per-batch counter routing
  applyBatchWebhookEvent,
  makeApplyBatchWebhookEventDeps,
  resolveTenantByBatchProviderBroadcastId,
  type BatchWebhookEventType,
} from '@/modules/broadcasts';
import { createHash } from 'node:crypto';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_WEBHOOK_BODY_BYTES = 64 * 1024;

interface BaseHeaders {
  readonly [k: string]: string;
}

function baseHeaders(correlationId: string): BaseHeaders {
  return {
    'X-Correlation-Id': correlationId,
    'Cache-Control': 'no-store, private',
  };
}

function jsonOk(correlationId: string): NextResponse {
  return NextResponse.json(
    { received: true },
    { status: 200, headers: baseHeaders(correlationId) },
  );
}

function jsonUnauthorized(
  code: 'missing_header' | 'bad_signature' | 'body_too_large',
  correlationId: string,
): NextResponse {
  // 413 Payload Too Large for the size guard so Resend / proxies
  // surface the real failure mode; signature/format failures stay 401.
  const status = code === 'body_too_large' ? 413 : 401;
  return NextResponse.json(
    { error: { code } },
    { status, headers: baseHeaders(correlationId) },
  );
}

function jsonFeatureDisabled(correlationId: string): NextResponse {
  // 410 Gone (NOT 503) so Svix backoff treats it as terminal and
  // stops the 3-day retry storm. Audit row makes the rejection
  // observable to ops when the kill-switch flips.
  return NextResponse.json(
    { error: { code: 'feature_disabled' } },
    { status: 410, headers: baseHeaders(correlationId) },
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

/**
 * Emit a `broadcast_webhook_signature_rejected` audit row via the typed
 * F7 adapter. Tenant is unknown at sig-reject time so we pass `tx=null`
 * (system path, auto-commit) + `tenantId=null`. Best-effort: a Postgres
 * failure is logged and swallowed so the webhook still returns 401
 * (signed-payload tampering MUST always fail closed). Routing through
 * the typed adapter (matches PR #20 typed-emit pattern) makes
 * `event_type` + retention compile-time-checked rather than a free-form
 * SQL literal.
 */
async function auditSignatureReject(
  reason: string,
  requestId: string,
  correlationId: string,
): Promise<void> {
  try {
    await f7AuditAdapter.emit(null, {
      eventType: 'broadcast_webhook_signature_rejected',
      actorUserId: 'system:webhook',
      summary: `Resend Broadcasts webhook rejected: ${reason}`,
      payload: { reason, correlationId },
      tenantId: null,
      requestId,
    });
  } catch (e) {
    // Review ERR-L1: emit a dedicated log channel
    // (`broadcasts.webhook.audit_reject_db_failure`) ALONGSIDE the
    // generic `audit_reject_failed` so an alert rule can be wired
    // without code change to distinguish "audit-rail is broken"
    // (sig-reject DB write failing) from the generic catch-all. No
    // alert rule consumes this channel today — wiring it is a runbook
    // task. Both logs fire on this path so legacy dashboards keep
    // working.
    //
    // Review ERR-M1 (round 3): emit a stable `dedupeKey` on both
    // channels so the alert rule can group + rate-limit at the
    // pipeline side WITHOUT in-process state. Format: `f7-audit-reject:`
    // + reason — collapses a Postgres outage flood (e.g. 50 retries
    // × N concurrent webhooks) to one alert per (reason × outage
    // window) instead of 50× duplicates.
    const dedupeKey = `f7-audit-reject:${reason}`;
    const errShape = {
      err: e instanceof Error ? e.constructor.name : 'unknown',
      reason,
      requestId,
      correlationId,
      dedupeKey,
    };
    logger.error(errShape, 'broadcasts.webhook.audit_reject_failed');
    logger.error(errShape, 'broadcasts.webhook.audit_reject_db_failure');
  }
}

/**
 * Insert a `broadcast_webhook_signature_rejected` audit row when a
 * signature-verified webhook arrives for a `resend_broadcast_id` that
 * does NOT match any persisted broadcast (review ERR-C1). Used in lieu
 * of a dedicated audit event type to keep migrations out of the hotfix
 * — the `reason: 'unknown_resend_broadcast_id'` field is the forensic
 * marker. Same NULL-tenant + 5y-retention shape as `auditSignatureReject`.
 */
async function auditUnknownResendBroadcast(
  resendBroadcastId: string,
  eventType: string,
  requestId: string,
  correlationId: string,
): Promise<void> {
  try {
    await f7AuditAdapter.emit(null, {
      eventType: 'broadcast_webhook_signature_rejected',
      actorUserId: 'system:webhook',
      summary: `Resend Broadcasts webhook for unknown broadcast id (${resendBroadcastId})`,
      payload: {
        reason: 'unknown_resend_broadcast_id',
        resendBroadcastId,
        eventType,
        correlationId,
      },
      tenantId: null,
      requestId,
    });
  } catch (e) {
    logger.error(
      {
        err: e instanceof Error ? e.constructor.name : 'unknown',
        resendBroadcastId,
        eventType,
        requestId,
        correlationId,
      },
      'broadcasts.webhook.audit_unknown_id_failed',
    );
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const requestId = requestIdFromHeaders(request.headers);
  const correlationId = randomUUID();
  const startedAtMs = Date.now();

  if (!env.features.f7Broadcasts) {
    // ERR-M3 (review): emit audit so the kill-switch flip is observable
    // and ops can tell "real Resend traffic was rejected" from
    // "no traffic arrived." Tenant unknown at this stage → NULL tenant
    // sig-reject row (same shape as missing-header).
    await auditSignatureReject('feature_disabled', requestId, correlationId);
    broadcastsMetrics.webhookSignatureRejected('feature_disabled');
    return jsonFeatureDisabled(correlationId);
  }

  // Step 1 — content-length pre-guard (BEFORE buffering body).
  // Defence against memory-exhaustion DoS — reject oversized payloads
  // before any allocation. Header reads below are O(1) memory.
  const contentLengthHeader = request.headers.get('content-length');
  if (contentLengthHeader !== null) {
    const declared = Number.parseInt(contentLengthHeader, 10);
    if (!Number.isFinite(declared) || declared > MAX_WEBHOOK_BODY_BYTES) {
      await auditSignatureReject('body_too_large', requestId, correlationId);
      broadcastsMetrics.webhookSignatureRejected('body_too_large');
      return jsonUnauthorized('body_too_large', correlationId);
    }
  }

  // Step 2 — read svix-* headers (verify-before-parse: reject missing
  // headers before reading body so a malformed-header attacker cannot
  // even force the body buffer allocation).
  const svixSig = request.headers.get('svix-signature');
  const svixId = request.headers.get('svix-id');
  const svixTimestamp = request.headers.get('svix-timestamp');
  if (
    svixSig === null ||
    svixSig.length === 0 ||
    svixId === null ||
    svixId.length === 0 ||
    svixTimestamp === null ||
    svixTimestamp.length === 0
  ) {
    await auditSignatureReject('missing_header', requestId, correlationId);
    broadcastsMetrics.webhookSignatureRejected('missing_header');
    return jsonUnauthorized('missing_header', correlationId);
  }

  // Step 3 — raw body (HMAC over raw bytes).
  let rawBody: string;
  try {
    rawBody = await request.text();
  } catch (e) {
    logger.error(
      {
        err: e instanceof Error ? e.constructor.name : 'unknown',
        requestId,
        correlationId,
      },
      'broadcasts.webhook.body_read_failed',
    );
    return jsonUnauthorized('bad_signature', correlationId);
  }
  if (rawBody.length > MAX_WEBHOOK_BODY_BYTES) {
    // Review PR #19 round-4: realised-body-size enforcement returns
    // 413 (NOT 401) so chunked / no-Content-Length requests get the
    // same ERR-C2 semantics as the pre-guard above.
    await auditSignatureReject('body_too_large', requestId, correlationId);
    broadcastsMetrics.webhookSignatureRejected('body_too_large');
    return jsonUnauthorized('body_too_large', correlationId);
  }

  // Step 4 — Svix HMAC verify.
  let verified;
  try {
    verified = resendBroadcastsWebhookVerifier.constructEvent(
      rawBody,
      svixSig,
      svixId,
      svixTimestamp,
      env.broadcasts.webhookSecret,
    );
  } catch (e) {
    const kind =
      e instanceof WebhookSignatureError
        ? e.kind
        : typeof (e as { kind?: unknown })?.kind === 'string'
          ? ((e as { kind: string }).kind)
          : 'bad_signature';

    // R7 staff-review LOW-G fix — `unknown_event_type` is NOT a
    // signature failure; it means Resend introduced a new event type
    // we haven't taught the verifier about yet. 200-ack so Resend
    // doesn't retry-storm and emit info-level log + bounded metric
    // so on-call learns about the new shape without paging.
    //
    // R8 staff-review R8-S1 fix — return the SAME response body as
    // the normal success path (`{received:true}`) instead of
    // `{received:true, ignored:'unknown_event_type'}`. The body diff
    // gave an attacker (who would already need the signing secret
    // to reach this code) a known/unknown-event-type oracle. Log
    // the distinguishing info (`unknown_event_type_acked`) and the
    // event type instead — observability without leaking the diff
    // back to the caller.
    if (kind === 'unknown_event_type') {
      logger.info(
        { requestId, correlationId },
        'broadcasts.webhook.unknown_event_type_acked',
      );
      return NextResponse.json({ received: true }, { status: 200 });
    }

    await auditSignatureReject(kind, requestId, correlationId);
    broadcastsMetrics.webhookSignatureRejected('bad_signature');
    return jsonUnauthorized('bad_signature', correlationId);
  }

  // Step 5 — tenant resolve via resend_broadcast_id (BYPASS RLS).
  // F7 MVP single-audience path first; on miss, fall back to F7.1a
  // per-batch lookup (T057). The two lookups are mutually exclusive
  // (a given Resend broadcast id maps to either ONE F7 MVP broadcast
  // row OR ONE F7.1a batch_manifest row, never both).
  let tenantId: string;
  let broadcastId: string;
  let batchRoutingContext: {
    readonly batchManifestId: string;
    readonly batchIndex: number;
  } | null = null;
  try {
    const lookup = await resolveTenantByResendBroadcastId(
      verified.data.broadcastId,
    );
    if (lookup !== null) {
      tenantId = lookup.tenantId;
      broadcastId = lookup.broadcastId;
    } else {
      // F7 MVP miss → try F7.1a batch lookup (T057).
      const batchLookup = await resolveTenantByBatchProviderBroadcastId(
        verified.data.broadcastId,
      );
      if (batchLookup === null) {
        // Unknown broadcast id — could be a legacy dispatch from a
        // prior tenant whose row has been archived, or a misrouted
        // event from a leaked secret. 200 OK so Resend does not
        // retry-storm, but emit a NULL-tenant audit row so the event
        // is forensically discoverable per FR-024 (review ERR-C1).
        logger.warn(
          {
            resendBroadcastId: verified.data.broadcastId,
            eventType: verified.type,
            requestId,
            correlationId,
          },
          'broadcasts.webhook.unknown_resend_broadcast_id',
        );
        await auditUnknownResendBroadcast(
          verified.data.broadcastId,
          verified.type,
          requestId,
          correlationId,
        );
        return jsonOk(correlationId);
      }
      tenantId = batchLookup.tenantId;
      broadcastId = batchLookup.broadcastId;
      batchRoutingContext = {
        batchManifestId: batchLookup.batchManifestId,
        batchIndex: batchLookup.batchIndex,
      };
    }
  } catch (e) {
    logger.error(
      {
        err: e instanceof Error ? e.constructor.name : 'unknown',
        requestId,
        correlationId,
      },
      'broadcasts.webhook.tenant_resolve_failed',
    );
    return jsonInternalError('tenant_resolve_failed', correlationId);
  }

  // F7.1a Phase 3 T057 — per-batch counter increment path.
  //
  // If the lookup resolved a batch_manifest (not a F7 MVP broadcast
  // row), increment the batch's counter via `applyBatchWebhookEvent`
  // and return early. The F7 MVP processWebhookEvent path is for
  // single-audience broadcasts; F7.1a multi-batch broadcasts have
  // their own per-batch state.
  //
  // Skip event types we don't count at batch level (e.g.
  // `email.opened` — informational only; broadcast-level metric
  // tracking happens via the F8 telemetry pipeline).
  if (batchRoutingContext !== null) {
    const batchEventType = mapToBatchEventType(verified.type);
    if (batchEventType === null) {
      // Event type not relevant to per-batch counters (e.g. opened) —
      // 200 OK so Resend stops retrying. Audit + telemetry already
      // captured via the upstream Svix idempotency layer.
      return jsonOk(correlationId);
    }
    try {
      const batchDeps = makeApplyBatchWebhookEventDeps(tenantId);
      const recipientEmailHashed = hashRecipientEmail(
        tenantId,
        verified.data.recipientEmail,
      );
      const r = await applyBatchWebhookEvent(batchDeps, {
        tenantId,
        batchManifestId: batchRoutingContext.batchManifestId,
        batchIndex: batchRoutingContext.batchIndex,
        broadcastId,
        eventType: batchEventType,
        recipientEmailHashed,
        resendEventId: verified.id,
        requestId,
      });
      if (!r.ok) {
        // speckit-review I-1 — branch on the error kind. A real
        // `storage_error` (Neon blip / serialization failure on the
        // counter UPDATE) MUST return 500 so Svix retries: the increment
        // is idempotent on `resend_event_id` (the broadcast_batch_
        // delivery_events ledger), so a retry recovers the lost counter
        // bump. Swallowing it to 200 makes Resend never retry → the batch
        // counter is permanently short → the broadcast strands in
        // `sending` until the 24h backstop rolls it to a FALSE
        // `partially_sent` + consumes the member's quota.
        if (r.error.kind === 'apply_batch_webhook.server_error') {
          logger.error(
            {
              err: r.error.kind,
              message: r.error.message,
              eventType: verified.type,
              batchManifestId: batchRoutingContext.batchManifestId,
              tenantId,
              correlationId,
              requestId,
            },
            'broadcasts.webhook.batch_counter_apply_failed',
          );
          return jsonInternalError('dispatch_failed', correlationId);
        }
        // BATCH_NOT_FOUND only — benign (the batch row was deleted by a
        // manual ops action mid-flight; the use case already emitted a
        // forensic audit row). 200 so Resend doesn't retry-storm against
        // a row that no longer exists.
        logger.warn(
          {
            err: r.error.kind,
            eventType: verified.type,
            batchManifestId: batchRoutingContext.batchManifestId,
            tenantId,
            correlationId,
            requestId,
          },
          'broadcasts.webhook.batch_counter_apply_failed',
        );
      }
      return jsonOk(correlationId);
    } catch (e) {
      logger.error(
        {
          err: e instanceof Error ? e.constructor.name : 'unknown',
          message: e instanceof Error ? e.message : 'unknown',
          batchManifestId: batchRoutingContext.batchManifestId,
          tenantId,
          correlationId,
          requestId,
        },
        'broadcasts.webhook.batch_route_threw',
      );
      // 500 → Svix retries — but this is an in-process bug
      // (DB blip, programmer error). Same escalation hook as F7 MVP.
      return jsonInternalError('dispatch_failed', correlationId);
    }
  }

  // Step 6 — build per-tenant deps + dispatch (F7 MVP single-audience).
  try {
    const deps = makeProcessWebhookEventDeps(tenantId);
    // T174 — root span `webhook_receive_resend` (docs/observability.md
    // § 22). Sub-spans for verify + DB upserts come from auto-instr.
    const result = await broadcastsTracer().startActiveSpan(
      'webhook_receive_resend',
      {
        attributes: {
          'tenant.id': tenantId,
          'broadcast.id': broadcastId,
          'webhook.event_type': verified.type,
        },
      },
      async (span) => {
        try {
          const r = await processWebhookEvent(deps, {
            broadcastId: asBroadcastId(broadcastId),
            event: verified,
            requestId,
          });
          span.setAttribute(
            'broadcasts.outcome',
            r.ok ? r.value.kind : `err:${r.error.kind}`,
          );
          return r;
        } catch (e) {
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: e instanceof Error ? e.message : 'webhook_threw',
          });
          throw e;
        } finally {
          span.end();
        }
      },
    );

    if (!result.ok) {
      logger.error(
        {
          err: result.error.kind,
          eventId: verified.id,
          tenantId,
          correlationId,
          requestId,
          ...(result.error.kind === 'process_webhook.server_error' && {
            detail: result.error.message,
          }),
          ...(result.error.kind === 'process_webhook.invalid_payload' && {
            detail: result.error.reason,
          }),
        },
        'broadcasts.webhook.dispatch_failed',
      );
      return jsonInternalError('dispatch_failed', correlationId);
    }

    logger.info(
      {
        eventId: verified.id,
        eventType: verified.type,
        outcome: result.value.kind,
        tenantId,
        correlationId,
        requestId,
      },
      'broadcasts.webhook.dispatched',
    );
    // T172 — emit-site wiring (Phase 9). Per-event ingest counter +
    // SLO-F7-005 latency histogram (target p95 < 250ms).
    {
      const subtype = verified.type.startsWith('email.')
        ? verified.type.slice('email.'.length)
        : verified.type;
      // R9 staff-review NIT — fallback label changed from `'sent'`
      // to `'unknown'` so a future Resend-side event subtype
      // addition (e.g. `email.opened`) surfaces in the metric as
      // its own bucket rather than silently inflating the `sent`
      // counter. Note: this branch is unreachable today because
      // `isKnownResendEventType` in the verifier rejects unknown
      // event types BEFORE this code runs (LOW-G fix returned
      // 200-ack with `unknown_event_type` kind earlier in the
      // route). The `'unknown'` label is defence-in-depth for the
      // hypothetical case where the verifier's enum drifts ahead
      // of this label-mapping switch.
      const eventLabel: 'delivered' | 'bounced' | 'complained' | 'sent' | 'delivery_delayed' | 'unknown' =
        subtype === 'delivered' ||
        subtype === 'bounced' ||
        subtype === 'complained' ||
        subtype === 'sent' ||
        subtype === 'delivery_delayed'
          ? subtype
          : 'unknown';
      broadcastsMetrics.webhookReceiveCount(tenantId, eventLabel);
      broadcastsMetrics.webhookDurationMs(tenantId, Date.now() - startedAtMs);
    }
    return jsonOk(correlationId);
  } catch (e) {
    logger.error(
      {
        err: e instanceof Error ? e.constructor.name : 'unknown',
        eventId: verified.id,
        tenantId,
        correlationId,
        requestId,
      },
      'broadcasts.webhook.dispatch_threw',
    );
    return jsonInternalError('dispatch_failed', correlationId);
  }
}

/**
 * F7.1a Phase 3 T057 — map verified Resend webhook event type to the
 * F71A batch-counter event type, or `null` when the event isn't
 * relevant to per-batch counters (`email.opened`, `email.clicked`,
 * etc.). Mutually exclusive — one counter increments per event.
 */
function mapToBatchEventType(
  verifiedType: string,
): BatchWebhookEventType | null {
  switch (verifiedType) {
    case 'email.delivered':
      return 'delivered';
    case 'email.bounced':
      return 'bounced';
    case 'email.complained':
      return 'complained';
    case 'email.unsubscribed':
      return 'unsubscribed';
    default:
      return null;
  }
}

/**
 * Per-tenant hashed recipient email — matches F7 MVP audit payload
 * convention (`broadcast_delivery_recorded` payload includes
 * `recipientEmailHashed`, not raw). Same SHA-256 with tenant-prefix
 * pattern as F7 MVP `hashRecipient(tenantId, lower)` helper.
 *
 * Inline implementation rather than import — the F7 MVP helper is
 * file-private to `process-webhook-event.ts`. Phase 3D consolidation
 * candidate.
 */
function hashRecipientEmail(tenantId: string, recipientEmail: string): string {
  return createHash('sha256')
    .update(`${tenantId}:${recipientEmail.toLowerCase().trim()}`)
    .digest('hex')
    .slice(0, 32);
}
