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
import { asSatang } from '@/lib/money';
import { logger } from '@/lib/logger';
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
  let refundStatus: string | null | undefined;
  // F5R3 H-5 (2026-05-16) — projected as branded Satang at the
  // Stripe→Application boundary; downstream code never re-validates.
  // F5R3v3 C-1 + H-3 + H-4 (2026-05-16) — defensive projection:
  //   - `asSatang(BigInt(n))` would throw on negative / fractional /
  //     non-finite values (fuzz, SDK drift, dispute reversal). A
  //     throw post-HMAC would propagate as 500 → Stripe retry storm.
  //   - Pre-fix the envelope SILENTLY omitted `amountSatang`,
  //     leaving every downstream consumer to default `?? 0n` — which
  //     caused `process-charge-refunded` to flag every pending
  //     refund as `refund_amount_mismatch_detected` on a single
  //     fuzzed event (audit storm class) and `dispute_created` to
  //     audit `amount_satang: '0'` (known-wrong value retained
  //     10 years per RD §87 / GDPR Art. 6(1)(c)).
  //   - Now: set `amountProjectionFailed: true` so consumers can
  //     branch on "projection failed, dead-letter" vs "amount is 0".
  //   - Bump log to `error` (Principle X — invariant violation,
  //     not expected anomaly) with full event triage context
  //     (eventId, account, livemode, objectType).
  let amountSatang: import('@/lib/money').Satang | undefined;
  let amountProjectionFailed = false;
  const projectAmountSafely = (kind: string, n: number): void => {
    try {
      amountSatang = asSatang(BigInt(n));
    } catch (e) {
      amountProjectionFailed = true;
      logger.error(
        {
          eventId: event.id,
          eventType: event.type,
          account: event.account ?? null,
          livemode: event.livemode,
          objectType: kind,
          rawAmount: n,
          errKind: e instanceof Error ? e.constructor.name : 'unknown',
        },
        'stripe-webhook-verifier.amount_projection_failed',
      );
      // amountSatang stays undefined → envelope sets
      // `amountProjectionFailed: true`; downstream gates on the flag
      // rather than treating `?? 0n` as a real amount.
    }
  };

  if (objectType === 'payment_intent') {
    const lc = raw['latest_charge'];
    // Audit 2026-04-25 finding #13: handle EXPANDED charge objects
    // (Stripe SDK returns `latest_charge` as either a `ch_…` string
    // OR a full Charge object when `expand: ['latest_charge']` was
    // requested). The previous triple-ternary always emitted null for
    // the object case → lost the charge id on every retrieve.
    if (typeof lc === 'string') {
      latestChargeId = lc;
    } else if (lc !== null && typeof lc === 'object' && typeof (lc as Record<string, unknown>)['id'] === 'string') {
      latestChargeId = (lc as Record<string, unknown>)['id'] as string;
    } else {
      latestChargeId = null;
    }
    const lpe = raw['last_payment_error'] as
      | { code?: string | null }
      | null
      | undefined;
    lastPaymentErrorCode =
      lpe && typeof lpe.code === 'string' ? lpe.code : null;
    if (typeof raw['amount'] === 'number') {
      projectAmountSafely('payment_intent', raw['amount'] as number);
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
      projectAmountSafely('charge', raw['amount'] as number);
    }
  } else if (objectType === 'dispute') {
    disputeId = rawId;
    // Task C.2 #6 / PCI-2 (2026-07-11) — a Dispute's `charge` field is
    // normally a `ch_…` string, but Stripe CAN return it EXPANDED (a
    // full Charge object carrying `payment_method_details.card.last4/
    // brand`) — the same shape hazard `latest_charge` above already
    // guards against. Mirror that defensive extraction: pull ONLY the
    // `id`, never copy `raw['charge']` verbatim into the envelope —
    // that would leak card data into the `dispute_created` audit row
    // (10-year retention, RD §87 / GDPR Art. 6(1)(c)). Before this fix
    // `latestChargeId` was never set on the dispute branch at all, so
    // the audit's `charge_id` fell back to the DISPUTE id (dp_…)
    // instead of the real charge id.
    const ch = raw['charge'];
    if (typeof ch === 'string') {
      latestChargeId = ch;
    } else if (
      ch !== null &&
      typeof ch === 'object' &&
      typeof (ch as Record<string, unknown>)['id'] === 'string'
    ) {
      latestChargeId = (ch as Record<string, unknown>)['id'] as string;
    } else {
      latestChargeId = null;
    }
    if (typeof raw['amount'] === 'number') {
      projectAmountSafely('dispute', raw['amount'] as number);
    }
  } else if (objectType === 'refund') {
    // Task A.10 (PCI-1, 2026-07-11) — `charge.refund.updated` envelope.
    // Positive allow-list ONLY: `refundStatus` (from the Refund's
    // `status`), `latestChargeId` (defensive expandable-id extraction —
    // mirrors the payment_intent/dispute arms above; a Refund's
    // `charge` field is normally a `ch_…` string but Stripe CAN return
    // it EXPANDED, carrying `payment_method_details.card.last4/brand`),
    // and `amountSatang`. NEVER copy `destination_details`, card
    // metadata, or the raw Refund object — `refundStatus`/`charge_id`/
    // `amount_satang` feed the `refund_succeeded`/`refund_failed` audit
    // rows (10-year retention, RD §87 / GDPR Art. 6(1)(c)).
    refundStatus =
      typeof raw['status'] === 'string' ? (raw['status'] as string) : null;
    const ch = raw['charge'];
    if (typeof ch === 'string') {
      latestChargeId = ch;
    } else if (
      ch !== null &&
      typeof ch === 'object' &&
      typeof (ch as Record<string, unknown>)['id'] === 'string'
    ) {
      latestChargeId = (ch as Record<string, unknown>)['id'] as string;
    } else {
      latestChargeId = null;
    }
    if (typeof raw['amount'] === 'number') {
      projectAmountSafely('refund', raw['amount'] as number);
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
      ...(amountProjectionFailed ? { amountProjectionFailed: true } : {}),
      ...(refundStatus !== undefined ? { refundStatus } : {}),
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
      // matching is the only option.
      //
      // Audit 2026-04-25 finding #14: this textual matching is fragile
      // against future Stripe SDK message wording changes. The
      // `getStripeClient()` is pinned to `env.stripe.apiVersion`
      // (currently `2025-09-30.clover`), and the SDK is pinned in
      // `package.json` — but a `pnpm update stripe` could change the
      // wording silently. Mitigation: the default fallback is
      // `bad_signature` (safest classification), and the route handler
      // returns the same 401 regardless of kind. Audit detail differs
      // by kind but the user-facing behaviour is identical.
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
