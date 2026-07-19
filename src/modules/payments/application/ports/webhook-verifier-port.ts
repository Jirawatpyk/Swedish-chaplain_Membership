/**
 * T054 — WebhookVerifierPort (F5 Application).
 *
 * Adapter wraps `stripe.webhooks.constructEvent` (HMAC-SHA256 timestamped
 * verification per stripe-webhook.md § 3 step 3). Application code
 * receives ONLY the verified event metadata — it never sees the raw
 * Stripe SDK `Event` type.
 *
 * The adapter may return a structurally narrowed event envelope. For PCI
 * SAQ-A (PCI-guardian Group B F1/F2), downstream dispatch passes an
 * allow-list of fields (`id`, `type`, `api_version`, `livemode`,
 * `account`) to sub-use-cases — NEVER the full `data.object`. Full
 * charge/card-metadata fields are re-fetched via `retrievePaymentIntent`
 * inside the use-case so card last4/brand enter the trust boundary only
 * at a single auditable point.
 */

export class WebhookSignatureError extends Error {
  readonly kind:
    | 'missing_header'
    | 'malformed'
    | 'bad_signature'
    | 'tampered_body'
    /**
     * F5R1-TY8 — Stripe webhook ≥5-min clock-skew rejection
     * (data-model.md § 5.3). The Infrastructure class
     * (`infrastructure/stripe/errors.ts`) has carried this variant
     * for a while; aligning the Application port closes the declared-
     * vs-thrown drift the F5R1 review flagged.
     */
    | 'clock_skew';
  constructor(kind: WebhookSignatureError['kind'], message: string) {
    super(message);
    this.name = 'WebhookSignatureError';
    this.kind = kind;
  }
}

/**
 * F5R3 H-6 (2026-05-16) — single source of truth for the Stripe
 * event types F5's dispatcher handles. Pre-fix the dispatcher
 * `switch (event.type) { case 'payment_intent.succeeded': … }` and
 * the webhook route's revalidatePath allow-list each carried their
 * own copy of the string literals — adding a new type to one but
 * forgetting the other silently skipped cache invalidation. Both
 * consumers now import this constant so drift is a compile error
 * (typed exhaustiveness on `F5HandledEventType` switch + `Set`
 * membership lookup at the route).
 */
export const F5_HANDLED_EVENT_TYPES = [
  'payment_intent.succeeded',
  'payment_intent.payment_failed',
  'payment_intent.canceled',
  'charge.refunded',
  'charge.dispute.created',
  /**
   * PR-A Task A.10 (PCI-1, 2026-07-11) — Stripe's refund-lifecycle
   * event, fired as a `Refund` object transitions between
   * `pending | succeeded | failed | canceled | requires_action`. The
   * verifier's `refund` arm (`stripe-webhook-verifier.ts`) projects
   * `refundStatus` (added to `VerifiedStripeEvent['dataObject']` in
   * A.9) from this event's `status` field. `processRefundUpdated`
   * (A.11) subscribes here to finalize a `pending` refund row.
   *
   * DEPRECATED by Stripe: "This event is only sent for refunds with a
   * corresponding charge; listen to `refund.updated` for updates on all
   * refunds instead." Kept because it STILL fires for refunds that DO
   * have a legacy charge (card refunds), and the OOB forensic redundancy
   * (KL-7) relies on it firing alongside `charge.refunded`.
   */
  'charge.refund.updated',
  /**
   * PR-A follow-up (2026-07-12) — the FORWARD-PATH refund-lifecycle event
   * on the pinned Stripe API version (`STRIPE_API_VERSION`, currently
   * `2025-09-30.clover`). `refund.updated` fires on ANY
   * `Refund` update (incl. `status → succeeded | failed | canceled`), for
   * ALL refunds — including charge-less async refunds (PromptPay / GrabPay
   * / bank transfers) that never emit the deprecated `charge.refund.updated`.
   * Its `data.object` is the SAME `Stripe.Refund` the `charge.refund.updated`
   * arm already projects, so the verifier's object-type-driven `refund` arm
   * reuses one projection for both, and the dispatcher routes both to the
   * SAME `processRefundUpdated` use-case (idempotent: markProcessed is
   * per-event-id; the finaliser guards on `expectedCurrentStatus='pending'`
   * and the F4 CN is idempotent per `(tenant, source_refund_id)`).
   *
   * `refund.failed` is deliberately NOT subscribed: `refund.updated`
   * already carries the `status → failed` transition, so a separate
   * subscription would be redundant; the stale-pending sweep (A.14)
   * backstops any single-event delivery gap.
   */
  'refund.updated',
] as const;
export type F5HandledEventType = (typeof F5_HANDLED_EVENT_TYPES)[number];

/**
 * Set form for O(1) membership checks (used by the route's
 * revalidate-path allow-list).
 */
export const F5_HANDLED_EVENT_TYPES_SET: ReadonlySet<string> = new Set(
  F5_HANDLED_EVENT_TYPES,
);

/**
 * Minimal verified envelope surfaced to Application. Mirrors the
 * structural allow-list pinned by T042 contract test (f):
 *   `{ id, type, api_version, livemode, account, created }` +
 *   narrowed data subset for dispatch branches.
 */
export interface VerifiedStripeEvent {
  readonly id: string;
  readonly type: string;
  readonly apiVersion: string;
  readonly livemode: boolean;
  readonly account: string;
  readonly createdAtUnixSeconds: number;
  /**
   * Narrowed payload carried forward for branch dispatch. NOT the raw
   * `event.data.object` — the adapter projects only the id-like fields
   * needed by each branch. Richer card/charge metadata is re-fetched
   * via `retrievePaymentIntent` at the use-case boundary (PCI guardian).
   */
  readonly dataObject: {
    readonly id: string;
    readonly type: string;               // object type hint ('payment_intent', 'charge', …)
    readonly latestChargeId?: string | null;
    readonly refundIds?: readonly string[];
    readonly lastPaymentErrorCode?: string | null;
    readonly disputeId?: string | null;
    readonly amountSatang?: import('@/lib/money').Satang;
    /**
     * F5R3v3 H-4 (2026-05-16) — `true` iff the verifier's defensive
     * amount projection (C-1) caught a brand failure (negative, NaN,
     * Infinity, fractional, missing). When true, `amountSatang` is
     * omitted AND downstream consumers MUST NOT treat
     * `amountSatang ?? 0n` as a real amount. Pre-fix the missing
     * flag let `process-charge-refunded` flag every pending refund
     * as `refund_amount_mismatch_detected` (existing > 0 vs default
     * 0) — a single fuzzed webhook caused a mismatch-audit storm.
     * Similarly `dispute_created` audit rows wrote `amount_satang:
     * '0'` (a known-wrong value retained 10 years per RD §87 / GDPR
     * Art. 6(1)(c)). With this flag, consumers route to dead-letter
     * / sentinel paths instead of substituting a misleading 0.
     */
    readonly amountProjectionFailed?: boolean;
    /**
     * PR-A Task A.9 (#1) — the Stripe Refund object's `status`
     * (`pending | succeeded | failed | canceled | requires_action`),
     * projected by the verifier's `charge.refund.updated` arm (wired in
     * A.10). `processRefundUpdated` (A.11) branches on this to finalize
     * a `pending` refund row. PCI SAQ-A: a bare status string only —
     * NEVER card metadata, `destination_details`, or the raw Refund
     * object. Copied through the route's `reprojectDataObject` here in
     * A.9 (ahead of A.10) so the single-projection superset guard
     * (`webhook-reprojection-superset.test.ts`) already covers it.
     */
    readonly refundStatus?: string | null;
    /**
     * Money-remediation Task 9 (F-9) — the APP-INITIATED refund marker,
     * keyed by Stripe refund id (`re_…` → our `refunds.id`).
     *
     * `issueRefund` stamps `metadata.refundId` on the Stripe Refund
     * BEFORE the external `createRefund` call, so this key exists even
     * when the post-call `attachProcessorRefundId` write never lands
     * (Neon blip, function timeout, client-side timeout on a request
     * Stripe actually honoured). Without it, `charge.refunded` arriving
     * ahead of the attach finds no row and fires a FALSE
     * `out_of_band_refund_detected` — a 10-year forensic that claims
     * money left by an unauthorised route, plus an on-call page.
     *
     * Populated by BOTH verifier arms:
     *   · `charge`  — one entry per `refunds.data[i]` that carries a
     *     well-formed marker (a charge can carry several refunds).
     *   · `refund`  — a single entry keyed by the Refund's own id.
     * A refund with no marker (a genuine Stripe-Dashboard refund) is
     * simply absent from the map, so the OOB forensic still fires.
     *
     * SECURITY — over-suppression is the dangerous direction. This value
     * is attacker-influenceable: anyone with Stripe Dashboard access (the
     * exact actor the OOB alert exists to catch) can set
     * `metadata.refundId` on a hand-made refund and attempt to mute their
     * own alarm. It is therefore NOT sufficient on its own. Consumers MUST
     * pair it with all three remaining mitigations:
     *   1. the `processor_refund_id IS NULL` repo predicate (structurally
     *      incapable of touching an already-matched row),
     *   2. an explicit tenant filter on the lookup, and
     *   3. the `paymentIntentId` cross-check below.
     * Validated here at the trust perimeter via the Domain's
     * `parseRefundId` — malformed markers are dropped, never forwarded.
     *
     * PCI SAQ-A: an opaque id pair only — never card metadata, never the
     * raw Stripe metadata bag (which is caller-controlled free text).
     */
    readonly appRefundIds?: Readonly<Record<string, string>>;
    /**
     * Money-remediation Task 9 (F-9) — the PaymentIntent id owning this
     * charge/refund (`ch_….payment_intent` / `re_….payment_intent`).
     *
     * Sole purpose is the anti-forgery cross-check on the marker above:
     * a matched `refunds` row's parent payment must carry the SAME
     * `processor_payment_intent_id`. That makes a forged marker useless —
     * an attacker refunding their own charge cannot make it point at
     * someone else's PaymentIntent. When the cross-check FAILS the
     * consumer must still emit the OOB forensic: a marker naming a row
     * under a different PI is corrupted or hostile, not a benign miss.
     *
     * `null` when the field is absent or unextractable; consumers treat
     * null as "cannot cross-check" and therefore DO NOT suppress.
     *
     * PCI SAQ-A: a bare `pi_…` id — Stripe can return `payment_intent`
     * EXPANDED as a full object, so the verifier extracts ONLY `.id`
     * (mirrors the `latest_charge` / dispute-`charge` discipline).
     */
    readonly paymentIntentId?: string | null;
  };
}

export interface WebhookVerifierPort {
  /**
   * Verify the HMAC signature + parse the event envelope. Throws
   * `WebhookSignatureError` on any verification failure. The raw body
   * + signature are NEVER logged (caller responsibility confirmed by
   * T041 PCI SAQ-A F6 test).
   */
  constructEvent(
    rawBody: string,
    stripeSignatureHeader: string | null,
    endpointSecret: string,
  ): VerifiedStripeEvent;
}
