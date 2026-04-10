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
 * Audit: NO audit event emitted — webhook events are operational
 * signals, not auth events. They live in the separate
 * `email_delivery_events` table (spec FR-012 U4).
 */
import { NextResponse, type NextRequest } from 'next/server';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { db } from '@/lib/db';
import {
  emailDeliveryEvents,
  type EmailDeliveryEventInsert,
} from '@/modules/auth/infrastructure/db/schema';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { requestIdFromHeaders } from '@/lib/request-id';

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
    return NextResponse.json(
      { error: 'invalid-input', message: 'Invalid webhook body' },
      { status: 400 },
    );
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

  // svixId is guaranteed non-null past the signature check.
  const insertRow: EmailDeliveryEventInsert = {
    eventType: mapped,
    messageId,
    toEmail,
    svixId: svixId!,
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

  return NextResponse.json({ ok: true }, { status: 200 });
}
