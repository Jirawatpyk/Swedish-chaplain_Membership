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
 *      (defence against memory-exhaustion DoS).
 *   2. Read svix-signature / svix-id / svix-timestamp headers. Missing
 *      any → 401 + audit `broadcast_webhook_signature_rejected`. Body
 *      is NOT read (verify-before-parse invariant).
 *   3. Read raw body via `request.text()`.
 *   4. `webhookVerifier.constructEvent(...)` — Svix HMAC-SHA256.
 *      Throws `WebhookSignatureError{kind}` on any failure → 401 +
 *      audit with the kind as reason.
 *   5. Resolve tenant via `resend_broadcast_id` lookup (BYPASS RLS;
 *      schema owner). Unknown id → 200 OK + log + no audit (do NOT
 *      teach attackers which broadcast ids exist via timing).
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
import { requestIdFromHeaders } from '@/lib/request-id';
import {
  asBroadcastId,
  makeProcessWebhookEventDeps,
  processWebhookEvent,
  resendBroadcastsWebhookVerifier,
  resolveTenantByResendBroadcastId,
  WebhookSignatureError,
} from '@/modules/broadcasts';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';

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
 * Insert a `broadcast_webhook_signature_rejected` audit row directly
 * via the audit_log table. Tenant is unknown at sig-reject time so we
 * use a `system:webhook` actor and a NULL tenant. Best-effort: a
 * Postgres failure is logged and swallowed so the webhook still returns
 * 401 (signed-payload tampering MUST always fail closed).
 */
async function auditSignatureReject(
  reason: string,
  requestId: string,
  correlationId: string,
): Promise<void> {
  try {
    await db.execute(sql`
      INSERT INTO audit_log
        (event_type, actor_user_id, summary, request_id, payload, tenant_id, retention_years)
      VALUES
        ('broadcast_webhook_signature_rejected'::audit_event_type,
         'system:webhook',
         ${`Resend Broadcasts webhook rejected: ${reason}`},
         ${requestId},
         ${JSON.stringify({ reason, correlationId })}::jsonb,
         NULL,
         5)
    `);
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
    await db.execute(sql`
      INSERT INTO audit_log
        (event_type, actor_user_id, summary, request_id, payload, tenant_id, retention_years)
      VALUES
        ('broadcast_webhook_signature_rejected'::audit_event_type,
         'system:webhook',
         ${`Resend Broadcasts webhook for unknown broadcast id (${resendBroadcastId})`},
         ${requestId},
         ${JSON.stringify({
           reason: 'unknown_resend_broadcast_id',
           resendBroadcastId,
           eventType,
           correlationId,
         })}::jsonb,
         NULL,
         5)
    `);
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

  if (!env.features.f7Broadcasts) {
    // ERR-M3 (review): emit audit so the kill-switch flip is observable
    // and ops can tell "real Resend traffic was rejected" from
    // "no traffic arrived." Tenant unknown at this stage → NULL tenant
    // sig-reject row (same shape as missing-header).
    await auditSignatureReject('feature_disabled', requestId, correlationId);
    return jsonFeatureDisabled(correlationId);
  }

  // Step 2 FIRST — read headers before reading body.
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
    return jsonUnauthorized('missing_header', correlationId);
  }

  // Step 1 — content-length guard.
  const contentLengthHeader = request.headers.get('content-length');
  if (contentLengthHeader !== null) {
    const declared = Number.parseInt(contentLengthHeader, 10);
    if (!Number.isFinite(declared) || declared > MAX_WEBHOOK_BODY_BYTES) {
      await auditSignatureReject('body_too_large', requestId, correlationId);
      return jsonUnauthorized('body_too_large', correlationId);
    }
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
    await auditSignatureReject('body_too_large', requestId, correlationId);
    return jsonUnauthorized('bad_signature', correlationId);
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
    await auditSignatureReject(kind, requestId, correlationId);
    return jsonUnauthorized('bad_signature', correlationId);
  }

  // Step 5 — tenant resolve via resend_broadcast_id (BYPASS RLS).
  let tenantId: string;
  let broadcastId: string;
  try {
    const lookup = await resolveTenantByResendBroadcastId(
      verified.data.broadcastId,
    );
    if (lookup === null) {
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
    tenantId = lookup.tenantId;
    broadcastId = lookup.broadcastId;
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

  // Step 6 — build per-tenant deps + dispatch.
  try {
    const deps = makeProcessWebhookEventDeps(tenantId);
    const result = await processWebhookEvent(deps, {
      broadcastId: asBroadcastId(broadcastId),
      event: verified,
      requestId,
    });

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
