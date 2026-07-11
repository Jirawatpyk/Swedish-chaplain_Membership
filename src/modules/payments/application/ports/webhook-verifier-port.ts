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
