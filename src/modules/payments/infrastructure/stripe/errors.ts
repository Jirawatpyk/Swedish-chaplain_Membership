/**
 * T064/T065 — Typed error classes for F5 Stripe infrastructure.
 *
 * Thrown by the webhook verifier adapter and used internally by the
 * Stripe gateway adapter's error mapper. Kept in a sibling module so
 * both adapters can import without a circular dependency.
 *
 * Infrastructure layer only — Application code receives the narrowed
 * `WebhookSignatureError` re-exported from its Application port;
 * `ProcessorGatewayError` from the port is returned via `Result`
 * instead of being thrown.
 *
 * PCI note: `detail` strings MUST NOT carry raw Stripe response
 * payloads, card fields, or client secrets. The adapter's error
 * mapper only copies Stripe SDK `error.type` / `error.code` /
 * `error.message` (the message is a stable short description such as
 * "No such payment_intent: pi_…" and is safe to log).
 */

/**
 * Re-exported shape of the Application port's `WebhookSignatureError`
 * with an extra `'clock_skew'` discriminator (data-model.md § 5.3 —
 * ≥5-minute skew is rejected before HMAC verification to prevent
 * replay of an old captured payload with a fresh signature).
 *
 * The Application port's `WebhookSignatureError` union today lists
 * `'missing_header' | 'malformed' | 'bad_signature' | 'tampered_body'`.
 * This Infrastructure class WIDENS the union with `'clock_skew'`. The
 * route handler narrows back down before calling Application code
 * (emits the `webhook_signature_rejected` audit with `clock_skew`
 * detail but still raises an HTTP 400 like the other kinds).
 */
export class WebhookSignatureError extends Error {
  readonly kind:
    | 'missing_header'
    | 'malformed'
    | 'bad_signature'
    | 'tampered_body'
    | 'clock_skew';
  constructor(
    kind: WebhookSignatureError['kind'],
    message: string,
  ) {
    super(message);
    this.name = 'WebhookSignatureError';
    this.kind = kind;
  }
}

/**
 * Thrown inside the Stripe gateway adapter to carry structured detail
 * across the error-mapping boundary. The adapter catches this inside
 * each public method and converts it to the Application port's
 * `Result<T, ProcessorGatewayError>` discriminated union.
 *
 * Not exposed across the module boundary.
 */
export class StripeAdapterError extends Error {
  readonly kind: 'retryable' | 'idempotency_conflict' | 'permanent';
  readonly code: string;
  constructor(
    kind: StripeAdapterError['kind'],
    code: string,
    message: string,
  ) {
    super(message);
    this.name = 'StripeAdapterError';
    this.kind = kind;
    this.code = code;
  }
}
