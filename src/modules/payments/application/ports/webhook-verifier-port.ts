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
    readonly amountSatang?: bigint;
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
