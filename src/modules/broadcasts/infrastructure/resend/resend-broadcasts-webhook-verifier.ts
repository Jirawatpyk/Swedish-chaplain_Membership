/**
 * T153 — Resend Broadcasts webhook signature verifier (F7 US5).
 *
 * Concrete `WebhookVerifierPort` adapter implementing the Svix HMAC-SHA256
 * scheme that Resend uses for Broadcasts webhook authentication. Mirror of
 * the F1 transactional Resend verifier (`/api/webhooks/resend/route.ts`)
 * lifted into a port-shaped Application boundary so the route handler
 * can swap stub verifiers in unit tests.
 *
 *   signed_payload = `${svix_id}.${svix_timestamp}.${body}`
 *   expected       = `v1,${base64(HMAC_SHA256(secret_bytes, signed_payload))}`
 *
 * The `whsec_` prefix on the secret is stripped before HMAC; the remaining
 * base64-encoded secret bytes are used as the HMAC key. The header may
 * contain multiple space-separated `v{N},sig` pairs (rotation window).
 *
 * Refuses BEFORE body parse — caller passes the raw body string and the
 * three Svix headers; this adapter does NOT parse JSON. Throws
 * `WebhookSignatureError{kind}` on any failure path so the route handler
 * can audit the precise reject reason.
 *
 * Timestamp tolerance: ±5 minutes (Svix default). Older/newer payloads
 * throw `kind: 'expired_timestamp'` to defeat replay attacks.
 *
 * Pure Infrastructure — only Node `crypto` imports. No framework.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { logger } from '@/lib/logger';
import {
  WebhookSignatureError,
  type VerifiedBroadcastEvent,
  type WebhookVerifierPort,
} from '../../application/ports/webhook-verifier-port';
import {
  isBroadcastDeliveryStatus,
  type BroadcastDeliveryStatus,
} from '../../domain/value-objects/delivery-status';

const TIMESTAMP_TOLERANCE_SECONDS = 5 * 60;

/**
 * Map Resend webhook event types to our 5-status enum.
 * `email.delivery_delayed` → `soft_bounced` (Resend retries internally;
 * we record the signal for member-facing timeline + diagnostics).
 *
 * Review TYPES-#2 (round 3): declared `as const` so `ResendEventType`
 * narrows to the literal-string union of keys instead of widening to
 * `string`. A future Resend event type added without a corresponding
 * map entry would silently fall through; this pattern surfaces it as
 * a TS compile error wherever the lookup result is destructured.
 */
const EVENT_TYPE_TO_DELIVERY_STATUS = {
  'email.sent': 'sent',
  'email.delivered': 'delivered',
  'email.bounced': 'bounced',
  'email.delivery_delayed': 'soft_bounced',
  'email.complained': 'complained',
} as const satisfies Record<string, BroadcastDeliveryStatus>;

type ResendEventType = keyof typeof EVENT_TYPE_TO_DELIVERY_STATUS;

function isKnownResendEventType(t: string): t is ResendEventType {
  return Object.hasOwn(EVENT_TYPE_TO_DELIVERY_STATUS, t);
}

interface ResendWebhookEnvelope {
  readonly type: string;
  readonly created_at?: string;
  readonly data: {
    readonly broadcast_id?: string;
    readonly broadcastId?: string;
    readonly email_id?: string;
    readonly emailId?: string;
    readonly to?: ReadonlyArray<string> | string;
    readonly bounce?: { readonly type?: 'hard' | 'soft' } | undefined;
    readonly bounce_type?: 'hard' | 'soft';
    readonly error?: { readonly message?: string } | string | undefined;
  };
}

function decodeBase64Loose(raw: string): Buffer {
  // Svix secrets ship as base64; if a tenant rotated to a non-base64
  // shared secret, fall back to UTF-8 bytes so the HMAC still works.
  // Both forms are constant-time-compared downstream.
  //
  // Review ERR-M3 (round 2): `Buffer.from(raw, 'base64')` does NOT
  // throw on malformed base64 — it silently returns a partially-decoded
  // buffer. Probe via round-trip equality so a paste error during
  // secret rotation surfaces as a fall-back-to-UTF-8 with a logger
  // signal, instead of producing a wrong-length buffer that yields
  // `bad_signature` audits with no actionable diagnostic.
  const decoded = Buffer.from(raw, 'base64');
  if (decoded.length > 0) {
    const reEncoded = decoded.toString('base64').replace(/=+$/, '');
    const normalised = raw.replace(/=+$/, '');
    if (reEncoded === normalised) {
      return decoded;
    }
    // Round-trip mismatch → not valid base64 (paste error during
    // secret rotation, or operator pasted an already-utf8 value).
    logger.warn(
      { secretLen: raw.length },
      'broadcasts.webhook.secret_base64_round_trip_mismatch_falling_back_utf8',
    );
  }
  return Buffer.from(raw, 'utf8');
}

export const resendBroadcastsWebhookVerifier: WebhookVerifierPort = {
  constructEvent(
    rawBody: string,
    svixSignatureHeader: string | null,
    svixIdHeader: string | null,
    svixTimestampHeader: string | null,
    secret: string,
  ): VerifiedBroadcastEvent {
    if (
      svixSignatureHeader === null ||
      svixSignatureHeader.length === 0 ||
      svixIdHeader === null ||
      svixIdHeader.length === 0 ||
      svixTimestampHeader === null ||
      svixTimestampHeader.length === 0
    ) {
      throw new WebhookSignatureError(
        'missing_header',
        'Missing one of svix-signature / svix-id / svix-timestamp headers',
      );
    }

    const ts = Number.parseInt(svixTimestampHeader, 10);
    if (!Number.isFinite(ts)) {
      throw new WebhookSignatureError(
        'malformed',
        'svix-timestamp header is not a valid unix-second integer',
      );
    }
    const nowSeconds = Math.floor(Date.now() / 1000);
    if (Math.abs(nowSeconds - ts) > TIMESTAMP_TOLERANCE_SECONDS) {
      throw new WebhookSignatureError(
        'expired_timestamp',
        `Webhook timestamp ${ts} outside ±${TIMESTAMP_TOLERANCE_SECONDS}s tolerance`,
      );
    }

    const rawSecret = secret.startsWith('whsec_') ? secret.slice(6) : secret;
    // Review ERR-M-R3-1 (round 3): defence-in-depth guard. `env.ts`
    // zod schema requires `RESEND_BROADCASTS_WEBHOOK_SECRET` to be
    // ≥32 bytes, so empty secret is impossible at boot. But if a
    // future config-loader regression bypasses the zod check, an
    // empty `rawSecret` would HMAC-over-empty-key all webhooks and
    // surface as generic `bad_signature` audits with no hint that
    // the secret is misconfigured. Throw `malformed` with an
    // explicit reason so operators see the real cause.
    if (rawSecret.length === 0) {
      throw new WebhookSignatureError(
        'malformed',
        'webhook secret is empty after stripping whsec_ prefix — operator misconfiguration',
      );
    }
    const signedPayload = `${svixIdHeader}.${svixTimestampHeader}.${rawBody}`;
    const expected = createHmac('sha256', decodeBase64Loose(rawSecret))
      .update(signedPayload, 'utf8')
      .digest('base64');

    const expectedBuf = Buffer.from(expected, 'utf8');
    let matched = false;
    for (const part of svixSignatureHeader.split(' ')) {
      const [version, sig] = part.split(',');
      if (version !== 'v1' || !sig) continue;
      const sigBuf = Buffer.from(sig, 'utf8');
      if (sigBuf.length !== expectedBuf.length) continue;
      if (timingSafeEqual(sigBuf, expectedBuf)) {
        matched = true;
        break;
      }
    }
    if (!matched) {
      throw new WebhookSignatureError(
        'bad_signature',
        'No v1 signature in svix-signature header matched the computed HMAC',
      );
    }

    let parsed: ResendWebhookEnvelope;
    try {
      parsed = JSON.parse(rawBody) as ResendWebhookEnvelope;
    } catch {
      throw new WebhookSignatureError(
        'tampered_body',
        'Body passed signature check but is not valid JSON',
      );
    }

    // Type guard narrows `parsed.type` to the literal union of known
    // event types; the `Object.hasOwn` check inside the predicate
    // also defends against payloads with `type: '__proto__'` /
    // `'constructor'` (review ERR-L2 + TYPES-#2 round 3).
    if (!isKnownResendEventType(parsed.type)) {
      throw new WebhookSignatureError(
        'malformed',
        `Unhandled Resend webhook event type: ${parsed.type}`,
      );
    }
    const status: BroadcastDeliveryStatus =
      EVENT_TYPE_TO_DELIVERY_STATUS[parsed.type];
    if (!isBroadcastDeliveryStatus(status)) {
      throw new WebhookSignatureError(
        'malformed',
        `Unhandled Resend webhook event type: ${parsed.type}`,
      );
    }

    const broadcastId = parsed.data.broadcast_id ?? parsed.data.broadcastId;
    const resendMessageId = parsed.data.email_id ?? parsed.data.emailId;
    if (
      typeof broadcastId !== 'string' ||
      broadcastId.length === 0 ||
      typeof resendMessageId !== 'string' ||
      resendMessageId.length === 0
    ) {
      throw new WebhookSignatureError(
        'malformed',
        'Webhook payload missing broadcast_id or email_id',
      );
    }

    const recipientEmail = Array.isArray(parsed.data.to)
      ? parsed.data.to[0]
      : typeof parsed.data.to === 'string'
        ? parsed.data.to
        : undefined;
    if (typeof recipientEmail !== 'string' || recipientEmail.length === 0) {
      throw new WebhookSignatureError(
        'malformed',
        'Webhook payload missing recipient email (data.to)',
      );
    }

    const errorMessageRaw =
      typeof parsed.data.error === 'string'
        ? parsed.data.error
        : parsed.data.error?.message;
    const bounceType =
      parsed.data.bounce?.type ?? parsed.data.bounce_type ?? undefined;

    const createdAtUnixSeconds = parsed.created_at
      ? Math.floor(new Date(parsed.created_at).getTime() / 1000)
      : ts;

    return {
      id: svixIdHeader,
      type: parsed.type,
      createdAtUnixSeconds: Number.isFinite(createdAtUnixSeconds)
        ? createdAtUnixSeconds
        : ts,
      data: {
        broadcastId,
        recipientEmail,
        resendMessageId,
        status,
        ...(typeof errorMessageRaw === 'string' && {
          errorMessage: errorMessageRaw,
        }),
        ...(bounceType !== undefined && { bounceType }),
      },
    };
  },
};
