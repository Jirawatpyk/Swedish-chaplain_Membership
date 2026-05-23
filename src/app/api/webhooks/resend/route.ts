/**
 * POST /api/webhooks/resend (T162, contracts/auth-api.md § 12).
 *
 * Receives delivery-event webhooks from Resend. Writes one row per
 * event to `email_delivery_events` (UNIQUE constraint on `svix-id`
 * provides DB-level idempotency — duplicate deliveries are silently
 * discarded via ON CONFLICT). On `bounced`/`complained` events, emits
 * a pino warning for operational follow-up.
 *
 * **Signature verification**: implements the Svix webhook signature
 * algorithm manually (no `svix` npm dep for F1):
 *
 *   signed_payload = `${svix_id}.${svix_timestamp}.${body}`
 *   expected = `v1,${base64(HMAC_SHA256(secret, signed_payload))}`
 *
 * We strip the `whsec_` prefix from the secret (Resend sends it with
 * the prefix but the HMAC is over the raw bytes after the prefix).
 * The `svix-signature` header may contain multiple space-separated
 * signatures (e.g. during rotation) — we accept any match.
 *
 * Timing: constant-time comparison via `crypto.timingSafeEqual` on
 * equal-length buffers.
 *
 * Audit: F1 webhook ingest itself emits NO audit event — delivery
 * events live in the separate `email_delivery_events` table (spec
 * FR-012 U4). The F8 bounce-threshold sub-flow (gated by
 * `FEATURE_F8_RENEWALS`) MAY emit
 * `member_email_unverified_threshold_crossed` and
 * `escalation_task_created` audits when a bounce trips a threshold —
 * triggered via the synchronous `detectBounceThreshold` call below.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { db } from '@/lib/db';
// Resend webhook receiver writes delivery-event rows directly. The
// schema table is used by NO Application use case — webhooks are a
// pure ingest path; wrapping in a passthrough use case would add no
// behaviour. Documented escape hatch for webhook ingest handlers.
 
import {
  emailDeliveryEvents,
  type EmailDeliveryEventInsert,
} from '@/modules/auth/infrastructure/db/schema';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { renewalsMetrics } from '@/lib/metrics';
import { requestIdFromHeaders } from '@/lib/request-id';
import {
  detectBounceThreshold,
  makeRenewalsDeps,
  lookupMemberByEmail,
} from '@/modules/renewals';
import { handleInvitationBounce } from '@/modules/members';

// Subset of the Resend webhook event type enum — only the ones our
// `email_delivery_events` enum column supports. Unknown event types
// are logged and silently accepted (200 with no row inserted).
const RESEND_EVENT_TYPE_MAP: Record<
  string,
  'sent' | 'delivered' | 'delivery_delayed' | 'bounced' | 'complained' | 'opened' | 'clicked'
> = {
  'email.sent': 'sent',
  'email.delivered': 'delivered',
  'email.delivery_delayed': 'delivery_delayed',
  'email.bounced': 'bounced',
  'email.complained': 'complained',
  'email.opened': 'opened',
  'email.clicked': 'clicked',
};

const webhookBodySchema = z.object({
  type: z.string(),
  created_at: z.string().optional(),
  data: z
    .object({
      email_id: z.string().optional(),
      to: z.array(z.string()).optional(),
      subject: z.string().optional(),
      // F8 Phase 4 Wave I4 / T101 — Resend's bounce metadata.
      // `type` is `'permanent' | 'transient'`; `subType` is a free-text
      // classifier (mailbox-not-found, dns-failure, etc.). We persist
      // only `type` since FR-012a thresholds discriminate on
      // permanent vs transient only.
      bounce: z
        .object({
          type: z.string().optional(),
          subType: z.string().optional(),
        })
        .optional(),
    })
    .passthrough(),
});

/**
 * Verify the Svix signature header. Returns true on any match.
 *
 * The header format is:
 *   `v1,base64signature1 v1,base64signature2 ...`
 *
 * We compute the expected signature once and compare it against
 * each provided signature in constant time.
 */
function verifySvixSignature(
  rawBody: string,
  svixId: string | null,
  svixTimestamp: string | null,
  svixSignature: string | null,
  secret: string,
): boolean {
  if (!svixId || !svixTimestamp || !svixSignature) return false;

  // Strip the `whsec_` prefix if present — Resend sends the secret
  // with the prefix but the HMAC is computed over the raw secret
  // bytes. (Other providers use the prefix directly; we support
  // both by stripping.)
  const rawSecret = secret.startsWith('whsec_') ? secret.slice(6) : secret;

  const signedPayload = `${svixId}.${svixTimestamp}.${rawBody}`;
  const expected = createHmac('sha256', Buffer.from(rawSecret, 'base64'))
    .update(signedPayload, 'utf8')
    .digest('base64');

  // Header may carry multiple versions separated by spaces; compare each
  const parts = svixSignature.split(' ');
  for (const part of parts) {
    const [version, sig] = part.split(',');
    if (version !== 'v1' || !sig) continue;
    // Constant-time compare — pad/truncate to equal length first to
    // avoid the timingSafeEqual throw on unequal lengths
    const expectedBuf = Buffer.from(expected, 'utf8');
    const sigBuf = Buffer.from(sig, 'utf8');
    if (expectedBuf.length !== sigBuf.length) continue;
    if (timingSafeEqual(expectedBuf, sigBuf)) return true;
  }
  return false;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const requestId = requestIdFromHeaders(request.headers);

  // Capture raw body first — the Svix signature is over the raw bytes,
  // not the parsed JSON, so any re-serialisation would break verify.
  const rawBody = await request.text();

  const svixId = request.headers.get('svix-id');
  const svixTimestamp = request.headers.get('svix-timestamp');
  const svixSignature = request.headers.get('svix-signature');

  const signatureOk = verifySvixSignature(
    rawBody,
    svixId,
    svixTimestamp,
    svixSignature,
    env.resend.webhookSigningSecret,
  );
  if (!signatureOk) {
    logger.warn(
      { requestId, svixId },
      'resend_webhook.invalid_signature',
    );
    return NextResponse.json(
      { error: 'invalid-webhook-signature' },
      { status: 401 },
    );
  }

  // Parse the JSON (now that we trust the source)
  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json(
      { error: 'invalid-input', message: 'Body must be JSON' },
      { status: 400 },
    );
  }

  const parsed = webhookBodySchema.safeParse(payload);
  if (!parsed.success) {
    // J5-H11: previously returned 400 → Resend retries with 24h
    // exponential backoff. If Resend ever evolves the payload schema
    // (e.g. their 2024 `bounce.type` addition), every webhook would
    // become a retry storm. Now we return 200 + log.error + metric so
    // the schema-drift alert pipeline triggers without breaking
    // delivery. Matches the unknown_event_type pattern below
    // (forward-compat philosophy).
    const eventType =
      typeof (payload as { type?: unknown })?.type === 'string'
        ? ((payload as { type: string }).type as string)
        : null;
    logger.error(
      {
        requestId,
        eventType,
        zodIssues: parsed.error.issues.slice(0, 5),
      },
      'resend_webhook.schema_rejected',
    );
    renewalsMetrics.webhookSchemaRejected(eventType);
    return NextResponse.json({ ok: true, schema_drift: true }, { status: 200 });
  }

  // Map Resend event type → our enum. Unknown types: log + 200
  // (Resend extends the enum over time; we don't want to 400 on a
  // new type and cause retries).
  const mapped = RESEND_EVENT_TYPE_MAP[parsed.data.type];
  if (!mapped) {
    logger.info(
      { requestId, eventType: parsed.data.type },
      'resend_webhook.unknown_event_type',
    );
    return NextResponse.json({ ok: true }, { status: 200 });
  }

  const messageId = parsed.data.data.email_id ?? 'unknown';
  const toEmail = parsed.data.data.to?.[0]?.toLowerCase() ?? 'unknown';

  // F8 Phase 4 Wave I4 / T101 — capture Resend bounce.type for
  // FR-012a threshold computation. NULL on non-bounced events.
  //
  // J6-H12: narrow at the consumer to the closed enum
  // `'permanent' | 'transient'`. The schema stays lenient
  // (`z.string().optional()`) so a future Resend addition (e.g. a
  // 'undetermined' classification) doesn't trigger schema_drift +
  // 200; instead we silently persist NULL for the unrecognised
  // value + log warn for observability. This keeps the
  // `bounce-event-query.ts` partition (which only counts permanent
  // vs transient) honest — previously a 'unknown' string would
  // silently zero-count without leaving a trace.
  let bounceType: 'permanent' | 'transient' | null = null;
  if (mapped === 'bounced') {
    const raw = parsed.data.data.bounce?.type ?? null;
    if (raw === 'permanent' || raw === 'transient') {
      bounceType = raw;
    } else if (raw !== null && raw !== undefined && raw.length > 0) {
      logger.warn(
        { requestId, bounceTypeRaw: raw, messageId: parsed.data.data.email_id ?? 'unknown' },
        'resend_webhook.bounce_type_unrecognised',
      );
    }
  }

  // svixId is guaranteed non-null past the signature check.
  const insertRow: EmailDeliveryEventInsert = {
    eventType: mapped,
    messageId,
    toEmail,
    svixId: svixId!,
    bounceType,
  };

  // Idempotent insert — the UNIQUE constraint on `svix_id` catches
  // duplicate deliveries. We suppress the conflict and log at debug
  // level so the cron doesn't page anyone for a normal retry.
  try {
    await db.insert(emailDeliveryEvents).values(insertRow).onConflictDoNothing();
  } catch (error) {
    logger.error(
      { requestId, err: error, svixId },
      'resend_webhook.insert_failed',
    );
    return NextResponse.json({ error: 'server-error' }, { status: 500 });
  }

  // Operational follow-up on bounces and complaints
  if (mapped === 'bounced' || mapped === 'complained') {
    logger.warn(
      {
        requestId,
        eventType: mapped,
        messageId,
        toEmail,
      },
      'resend_webhook.negative_signal',
    );
  }

  // F3 spec § Edge Cases — invitation-email bounce. Mark any pending member
  // invitation to this address as failed + emit `invitation_bounced` in the
  // owner tenant(s). Best-effort: wrapped so a failure NEVER 5xx's the webhook
  // (which would trigger a Resend retry storm). No-op when the bounced address
  // has no pending invitation anywhere.
  if (mapped === 'bounced' && toEmail !== 'unknown') {
    // Prefer the Resend bounce-event timestamp over server-receipt time so
    // invite_bounced_at reflects when the bounce actually occurred (webhook
    // delivery/retry can lag). Fall back to now() if absent/unparseable.
    const eventTs = parsed.data.created_at ? new Date(parsed.data.created_at) : null;
    const bouncedAt =
      eventTs && !Number.isNaN(eventTs.getTime()) ? eventTs : new Date();
    try {
      const { marked } = await handleInvitationBounce(toEmail, requestId, bouncedAt);
      if (marked > 0) {
        logger.info(
          { requestId, toEmail, marked },
          'resend_webhook.invitation_bounced_marked',
        );
      }
    } catch (e) {
      logger.error(
        {
          err: e instanceof Error ? e.message : String(e),
          requestId,
          toEmail,
        },
        'resend_webhook.invitation_bounce_handler_failed',
      );
    }
  }

  // F8 Phase 4 Wave I4 / T101 — synchronous-call hook into F8's
  // detectBounceThreshold (FR-012a). Gated by feature flag; failures
  // wrapped in try/catch + WARN log so a F8 internal error NEVER
  // propagates to a webhook 5xx (which would trigger Resend retry
  // storms with 24h exponential backoff).
  if (mapped === 'bounced' && env.features.f8Renewals && toEmail !== 'unknown') {
    // R5-C3 fix: split the previously-merged catch into two layers so
    // SRE can distinguish "DB lookup failed (no tenantId yet)" from
    // "F8 detectBounceThreshold use-case threw (tenantId KNOWN)". The
    // merged form set `metric.bounceHookFailed(null)` for both cases,
    // which made it impossible to find the tenant on a per-tenant
    // alert-pipeline dashboard. Two separate metric labels:
    //   - lookupFailed: tenant unknown — generic alert
    //   - hookFailed{tenant}: tenant known — per-tenant traceable
    let lookup: Awaited<ReturnType<typeof lookupMemberByEmail>>;
    try {
      lookup = await lookupMemberByEmail(toEmail);
    } catch (e) {
      // DB lookup failure — tenant unknown by definition.
      logger.error(
        {
          err: e instanceof Error ? e.message : String(e),
          stack: e instanceof Error ? e.stack : undefined,
          requestId,
          toEmail,
        },
        'resend_webhook.f8_bounce_hook_failed_lookup',
      );
      renewalsMetrics.bounceHookFailed(null);
      // Webhook still returns 200 (intentionally) to prevent Resend
      // retry storm — same contract as before.
      return NextResponse.json({ ok: true }, { status: 200 });
    }
    if (lookup) {
      try {
        const deps = makeRenewalsDeps(lookup.tenantId);
        await detectBounceThreshold(deps, {
          tenantId: lookup.tenantId,
          memberId: lookup.memberId,
          correlationId: requestId,
          actorRole: 'webhook',
        });
      } catch (e) {
        // F8 use-case failure — tenantId IS known; tag the metric so
        // SRE can trace per-tenant. Without this, hard-bouncing
        // member's `email_unverified` flag stays FALSE → the F8
        // dispatcher (Gate 6) keeps mailing the bouncing address →
        // Resend reputation pool degrades. FR-012a is silently broken
        // until Sender-Score telemetry catches up hours later.
        logger.error(
          {
            err: e instanceof Error ? e.message : String(e),
            stack: e instanceof Error ? e.stack : undefined,
            requestId,
            tenantId: lookup.tenantId,
            memberId: lookup.memberId,
            toEmail,
          },
          'resend_webhook.f8_bounce_hook_failed',
        );
        renewalsMetrics.bounceHookFailed(lookup.tenantId);
      }
    }
  }

  return NextResponse.json({ ok: true }, { status: 200 });
}
