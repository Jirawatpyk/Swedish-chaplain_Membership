/**
 * T065 — Stripe webhook verifier adapter (F5 Infrastructure).
 *
 * Implements `WebhookVerifierPort`. Wraps
 * `stripe.webhooks.constructEvent` (HMAC-SHA256 timestamped
 * verification) and projects the verified Stripe `Event` onto the
 * narrow `VerifiedStripeEvent` surface the Application layer sees.
 *
 * Pre-SDK clock-skew check: we parse the `t=` component from the
 * Stripe-Signature header and reject anything beyond ±5 min tolerance
 * BEFORE handing to the SDK. This:
 *   1. Lets us emit a specific `clock_skew` discriminator (the SDK's
 *      own check uses the same tolerance but throws the same error
 *      class as signature failures, making triage harder).
 *   2. Narrows the attack surface — a tampered body with a fresh
 *      timestamp still fails the SDK's HMAC compare, but the clock-
 *      skew reject is cheaper than HMAC when the sender is obviously
 *      misconfigured.
 *
 * PCI: neither the raw body nor the signature header is ever logged.
 * Error messages contain ONLY the kind + a short reason. The
 * Application port's `VerifiedStripeEvent.dataObject` exposes a
 * narrow subset (id + type + optional ids) — the raw
 * `event.data.object` stays behind the Infrastructure boundary.
 */
import type Stripe from 'stripe';
import type {
  WebhookVerifierPort,
  VerifiedStripeEvent,
} from '../../application/ports/webhook-verifier-port';
import { getStripeClient } from './stripe-client';
import { WebhookSignatureError } from './errors';

const CLOCK_SKEW_TOLERANCE_SECONDS = 300; // ±5 min (Stripe SDK default)

/**
 * Parse `t=<unix-seconds>` from a Stripe-Signature header of the form
 *   `t=1699999999,v1=<hex>,v0=<hex>`.
 * Returns null when the header is missing the `t=` segment or the
 * value is not a positive integer.
 */
function parseTimestampFromSignatureHeader(
  header: string,
): number | null {
  const parts = header.split(',');
  for (const part of parts) {
    const [key, value] = part.split('=', 2);
    if (key === 't' && value !== undefined) {
      const n = Number(value);
      if (Number.isFinite(n) && n > 0) return Math.floor(n);
      return null;
    }
  }
  return null;
}

/**
 * Project a verified Stripe `Event` onto the narrow Application
 * envelope. We carry the `dataObject.id` + type hint + a few
 * optional cross-reference ids — the ones used by the dispatcher to
 * pick a branch. Richer fields (card, charge, amount) are re-fetched
 * via `retrievePaymentIntent` at the use-case boundary so card
 * metadata enters the trust perimeter at exactly one auditable point.
 */
function project(event: Stripe.Event): VerifiedStripeEvent {
  const raw = event.data.object as unknown as Record<string, unknown>;
  const objectType =
    typeof raw['object'] === 'string' ? (raw['object'] as string) : 'unknown';
  const rawId = typeof raw['id'] === 'string' ? (raw['id'] as string) : '';

  // Narrow cross-reference ids — pulled only when present on the
  // specific object type to avoid leaking unrelated fields.
  let latestChargeId: string | null | undefined;
  let refundIds: readonly string[] | undefined;
  let lastPaymentErrorCode: string | null | undefined;
  let disputeId: string | null | undefined;
  let amountSatang: bigint | undefined;

  if (objectType === 'payment_intent') {
    const lc = raw['latest_charge'];
    latestChargeId =
      typeof lc === 'string' ? lc : lc === null || lc === undefined ? null : null;
    const lpe = raw['last_payment_error'] as
      | { code?: string | null }
      | null
      | undefined;
    lastPaymentErrorCode =
      lpe && typeof lpe.code === 'string' ? lpe.code : null;
    if (typeof raw['amount'] === 'number') {
      amountSatang = BigInt(raw['amount'] as number);
    }
  } else if (objectType === 'charge') {
    const refunds = raw['refunds'] as
      | { data?: Array<{ id?: string }> }
      | null
      | undefined;
    if (refunds?.data) {
      refundIds = refunds.data
        .map((r) => (typeof r.id === 'string' ? r.id : null))
        .filter((v): v is string => v !== null);
    }
    if (typeof raw['amount'] === 'number') {
      amountSatang = BigInt(raw['amount'] as number);
    }
  } else if (objectType === 'dispute') {
    disputeId = rawId;
    if (typeof raw['amount'] === 'number') {
      amountSatang = BigInt(raw['amount'] as number);
    }
  }

  const envelope: VerifiedStripeEvent = {
    id: event.id,
    type: event.type,
    apiVersion: event.api_version ?? 'unknown',
    livemode: event.livemode,
    account: event.account ?? '',
    createdAtUnixSeconds: event.created,
    dataObject: {
      id: rawId,
      type: objectType,
      ...(latestChargeId !== undefined ? { latestChargeId } : {}),
      ...(refundIds !== undefined ? { refundIds } : {}),
      ...(lastPaymentErrorCode !== undefined ? { lastPaymentErrorCode } : {}),
      ...(disputeId !== undefined ? { disputeId } : {}),
      ...(amountSatang !== undefined ? { amountSatang } : {}),
    },
  };

  return envelope;
}

export const stripeWebhookVerifier: WebhookVerifierPort = {
  constructEvent(rawBody, stripeSignatureHeader, endpointSecret) {
    if (stripeSignatureHeader === null || stripeSignatureHeader.length === 0) {
      throw new WebhookSignatureError(
        'missing_header',
        'Stripe-Signature header missing',
      );
    }

    // Pre-check clock skew before HMAC to surface a specific reason.
    const t = parseTimestampFromSignatureHeader(stripeSignatureHeader);
    if (t === null) {
      throw new WebhookSignatureError(
        'malformed',
        'Stripe-Signature header missing t= component',
      );
    }
    const nowSec = Math.floor(Date.now() / 1000);
    const skew = Math.abs(nowSec - t);
    // Reject >5min past OR >60s future (futures suggest clock drift or
    // attacker fast-forwarding; Stripe itself won't emit future-dated
    // timestamps in normal operation).
    if (skew > CLOCK_SKEW_TOLERANCE_SECONDS || nowSec + 60 < t) {
      throw new WebhookSignatureError(
        'clock_skew',
        `Stripe-Signature timestamp ${skew}s off from server clock`,
      );
    }

    try {
      const event = getStripeClient().webhooks.constructEvent(
        rawBody,
        stripeSignatureHeader,
        endpointSecret,
        CLOCK_SKEW_TOLERANCE_SECONDS,
      );
      return project(event);
    } catch (e) {
      const message =
        e instanceof Error ? e.message : 'unknown verification error';
      // Map the SDK's message text to our typed reason. The SDK does
      // not expose structured reason codes on this class, so textual
      // matching is the only option; we err on the side of returning
      // `bad_signature` for anything we can't positively identify.
      let kind: WebhookSignatureError['kind'] = 'bad_signature';
      if (message.includes('timestamp')) {
        kind = 'clock_skew';
      } else if (message.includes('payload') || message.includes('parse')) {
        kind = 'tampered_body';
      } else if (message.includes('signatures') || message.includes('signature')) {
        kind = 'bad_signature';
      }
      throw new WebhookSignatureError(kind, `Stripe signature verification failed: ${kind}`);
    }
  },
};
