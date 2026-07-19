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
import { parseRefundId } from '../../domain/refund';
import { getStripeClient } from './stripe-client';
import { WebhookSignatureError } from './errors';

const CLOCK_SKEW_TOLERANCE_SECONDS = 300; // ±5 min (Stripe SDK default)

/**
 * Extract an id from a Stripe field that may arrive either as a bare id
 * string OR as an EXPANDED object (`{ id, … }`). Returns null when the
 * field is absent or neither shape.
 *
 * The expanded case is not hypothetical: it is exactly how `latest_charge`
 * lost its id before the 2026-04-25 finding #13 fix, and how a Dispute's
 * `charge` fell back to the dispute id before PCI-2. A bare
 * `typeof === 'string'` narrowing silently yields nothing on an expanded
 * object — which, for Task 9's `payment_intent`, would make the anti-forgery
 * cross-check unsatisfiable and the whole marker path dead. Same failure
 * shape as validating an `rfnd_…` id with a uuid regex, one layer down.
 *
 * PCI SAQ-A: pulls ONLY `.id`. Never copy the expanded object — a Charge
 * carries `payment_method_details.card.last4/brand`.
 */
function extractExpandableId(
  raw: Record<string, unknown>,
  key: string,
): string | null {
  const value = raw[key];
  if (typeof value === 'string') return value;
  if (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as Record<string, unknown>)['id'] === 'string'
  ) {
    return (value as Record<string, unknown>)['id'] as string;
  }
  return null;
}

/**
 * Money-remediation Task 9 (F-9) — read + validate the app-initiated
 * refund marker `metadata.refundId` off a Stripe Refund node.
 *
 * Validation uses the Domain's `parseRefundId` (`RE_ULID_LIKE`), NOT a
 * uuid matcher: `generateRefundId()` emits `rfnd_<32 hex>` (37 chars) and
 * migration `0243` records the same fact — "F5 refund ids are
 * `rfnd_<ulid>`, NOT uuid". A uuid regex here would reject EVERY real
 * refund id, leaving the fallback permanently inert while the
 * over-correction guard stayed green: a mitigation that fails in the
 * direction that looks like success.
 *
 * `RE_ULID_LIKE` gives the same trust-perimeter protection a uuid matcher
 * would — bounded Crockford-base32 charset, bounded 20–40 length — against
 * a value that is fully attacker-controlled. It also matters at the DB
 * seam: `refunds.id` is `text`, not `uuid` (`0034_create_refunds.sql:15`),
 * so nothing downstream would reject a forged marker on a cast; this is
 * the only gate.
 *
 * Returns null for absent / non-string / malformed markers. A PRESENT but
 * malformed marker is logged at warn — absence is the normal shape of a
 * genuine Dashboard refund and must stay silent, but a marker that is
 * there and wrong is either SDK drift or a forgery attempt.
 */
function extractAppRefundId(
  node: { readonly metadata?: unknown },
  eventId: string,
): string | null {
  const metadata = node.metadata;
  if (metadata === null || typeof metadata !== 'object') return null;
  const rawMarker = (metadata as Record<string, unknown>)['refundId'];
  if (typeof rawMarker !== 'string' || rawMarker.length === 0) return null;
  const parsed = parseRefundId(rawMarker);
  if (!parsed.ok) {
    // PCI SAQ-A: log the LENGTH, never the value — `metadata` is
    // caller-controlled free text and a forged marker may embed anything.
    logger.warn(
      { eventId, markerLength: rawMarker.length },
      'stripe-webhook-verifier.app_refund_marker_malformed',
    );
    return null;
  }
  return parsed.value;
}

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
  // Task 9 (F-9) — app-initiated refund markers + the PI they must agree
  // with. Both stay `undefined` on arms that cannot carry them, so the
  // envelope shape is unchanged for every non-refund event.
  let appRefundIds: Record<string, string> | undefined;
  let paymentIntentId: string | null | undefined;
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
      | { data?: Array<{ id?: string; metadata?: unknown }> }
      | null
      | undefined;
    if (refunds?.data) {
      refundIds = refunds.data
        .map((r) => (typeof r.id === 'string' ? r.id : null))
        .filter((v): v is string => v !== null);
      // Task 9 (F-9) — collect the app-initiated marker for each refund
      // node that carries one. A charge can carry SEVERAL refunds (partial
      // refunds accumulate), and they are independently app- or
      // Dashboard-initiated, so this is a per-refund map rather than a
      // single event-level field. Refunds without a valid marker are
      // simply absent → the OOB forensic still fires for them.
      const markers: Record<string, string> = {};
      for (const node of refunds.data) {
        if (typeof node.id !== 'string') continue;
        const marker = extractAppRefundId(node, event.id);
        if (marker !== null) markers[node.id] = marker;
      }
      if (Object.keys(markers).length > 0) appRefundIds = markers;
    }
    // Anti-forgery cross-check input — see the port docstring.
    paymentIntentId = extractExpandableId(raw, 'payment_intent');
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
    // Task A.10 (PCI-1, 2026-07-11) — refund-lifecycle envelope. This arm is
    // keyed on `data.object.object === 'refund'`, NOT on the event `type`, so
    // it projects EVERY refund-carrying event with ONE shared projection:
    // the deprecated `charge.refund.updated` AND the forward-path
    // `refund.updated` (PR-A follow-up, 2026-07-12) — both deliver a
    // `Stripe.Refund` as `data.object`. Positive allow-list ONLY:
    // `refundStatus` (from the Refund's
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
    // Task 9 (F-9) — the Refund object carries its OWN marker + PI. Keyed
    // by the Refund's own id so BOTH handlers read one uniformly-shaped
    // envelope field (`processRefundUpdated` looks up `appRefundIds[id]`).
    const marker = extractAppRefundId(
      raw as { readonly metadata?: unknown },
      event.id,
    );
    if (marker !== null) appRefundIds = { [rawId]: marker };
    paymentIntentId = extractExpandableId(raw, 'payment_intent');
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
      ...(appRefundIds !== undefined ? { appRefundIds } : {}),
      ...(paymentIntentId !== undefined ? { paymentIntentId } : {}),
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
