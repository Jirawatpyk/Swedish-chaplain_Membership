/**
 * T054 — ProcessorGatewayPort (F5 Application).
 *
 * Abstraction over the Stripe SDK. Adapter lives in Infrastructure
 * (`infrastructure/stripe/*`); Application use-cases never import `stripe`
 * directly (Principle III + PCI SAQ-A boundary).
 *
 * All methods accept simple value objects — no Stripe type leakage. The
 * adapter maps to/from Stripe's SDK surface internally.
 */

/**
 * Gateway error variants — discriminated by `kind`.
 *
 * **PCI / log hygiene (NON-NEGOTIABLE)**: `reason` originates from the
 * Stripe SDK `error.message` field (see `mapStripeError` in
 * `infrastructure/stripe/stripe-gateway.ts`) and may embed account ids,
 * key prefixes, or other forbidden detail. **`reason` MUST NEVER**:
 *   - be written to a pino log line via `logger.*({reason: ...})`
 *   - be returned in an HTTP response body to the client
 *   - be persisted to any DB column without explicit redaction
 *
 * Use `kind` (the bounded discriminator) for log/response surfaces. The
 * gateway itself logs only allow-listed fields (`stripeAccount`,
 * `paymentIntentId`, `stripeErrorType`, `stripeErrorCode`,
 * `stripeErrorStatus`); callers MUST follow the same allow-list.
 * Contract test in `tests/contract/payments/post-payments-initiate.contract.test.ts`
 * pins the route response shape (PCI regression guard).
 */
export type ProcessorGatewayError =
  | { readonly kind: 'retryable'; readonly reason: string }
  | { readonly kind: 'idempotency_conflict'; readonly reason: string }
  | { readonly kind: 'permanent'; readonly code: string; readonly reason: string };

export interface CreatedPaymentIntent {
  readonly id: string;                   // `pi_…`
  readonly clientSecret: string;         // `pi_…_secret_…` — SAQ-A: never log
  readonly status: string;               // Stripe PI status
  readonly livemode: boolean;
  readonly promptpayQrSvgUrl: string | null;
}

export interface RetrievedPaymentIntent {
  readonly id: string;
  readonly status: string;
  /**
   * PromptPay QR SVG URL extracted from `next_action.promptpay_display_qr_code.image_url_svg`.
   * Populated only on PromptPay PIs that are still in `requires_action`
   * (the bank-app scan window). Null on terminal states (succeeded /
   * canceled / failed) and on card PIs. Surfaced through retrieve so
   * the use-case `initiatePayment` resume path can return a real QR
   * to the browser instead of a null that the panel would render as
   * a load-failure.
   */
  readonly promptpayQrSvgUrl: string | null;
  /**
   * Architect D-01 / PCI F2 (Group E1, 2026-04-24): `client_secret` is
   * exposed so the resume path of `initiatePayment` can read it from a
   * single `retrievePaymentIntent` call instead of re-invoking
   * `createPaymentIntent` (which double-hit Stripe + risked
   * idempotency collisions). Nullable because Stripe returns null for
   * intents in terminal states (succeeded / canceled) — callers MUST
   * guard with a null check before returning to the browser. Never
   * log this value: `REDACT_PATHS` in `src/lib/logger.ts` redacts
   * `clientSecret` + `client_secret`.
   */
  readonly clientSecret: string | null;
  readonly latestChargeId: string | null;
  readonly livemode: boolean;
  readonly lastPaymentErrorCode: string | null;
  readonly card: {
    readonly brand: string;
    readonly last4: string;
    readonly expMonth: number;
    readonly expYear: number;
  } | null;
}

export interface CreatedRefund {
  readonly id: string;                   // `re_…`
  readonly status: string;               // 'pending' | 'succeeded' | 'failed'
  readonly amountSatang: Satang;
}

/**
 * PR-A Task A.8 (PCI-3) — read-only projection of a Stripe Refund,
 * used by the Stripe-aware sweep (A.14) to reconcile a `refunds` row
 * against Stripe's own state.
 *
 * **PCI SAQ-A allow-list**: ONLY these 5 fields. The raw Stripe
 * `Refund` also carries `destination_details` (a card-network
 * reference blob keyed by refund method) which MUST NEVER cross this
 * boundary — see `stripe-gateway.ts` `retrieveRefund` for the
 * projection site.
 */
export interface RetrievedRefund {
  readonly id: string;                   // `re_…`
  readonly status: string;               // 'pending' | 'succeeded' | 'failed' | 'canceled' | 'requires_action'
  readonly chargeId: string | null;
  readonly paymentIntentId: string | null;
  readonly amountSatang: Satang;
}

import type { Result } from '@/lib/result';
import type { Satang } from '@/lib/money';

export interface ProcessorGatewayPort {
  createPaymentIntent(input: {
    readonly amountSatang: Satang;
    readonly currency: 'thb';
    readonly paymentMethodTypes: readonly ('card' | 'promptpay')[];
    readonly metadata: Readonly<Record<string, string>>;
    readonly idempotencyKey: string;
    readonly stripeAccount: string;      // Connect account = tenant's stripe account id
    /**
     * Member email — embedded into `payment_method_data.billing_details
     * .email` ONLY for server-confirmed PromptPay PIs (Stripe rejects
     * with `parameter_missing` otherwise). Card flows ignore it (Stripe
     * Elements collects billing details client-side).
     */
    readonly billingEmail?: string;
  }): Promise<Result<CreatedPaymentIntent, ProcessorGatewayError>>;

  retrievePaymentIntent(
    paymentIntentId: string,
    stripeAccount: string,
  ): Promise<Result<RetrievedPaymentIntent, ProcessorGatewayError>>;

  cancelPaymentIntent(
    paymentIntentId: string,
    stripeAccount: string,
  ): Promise<Result<void, ProcessorGatewayError>>;

  createRefund(input: {
    readonly paymentIntentId: string;
    readonly amountSatang?: Satang;     // omit for full refund
    readonly reason?: string;
    readonly metadata: Readonly<Record<string, string>>;
    readonly idempotencyKey: string;
    readonly stripeAccount: string;
  }): Promise<Result<CreatedRefund, ProcessorGatewayError>>;

  retrieveRefund(
    refundId: string,
    stripeAccount: string,
  ): Promise<Result<RetrievedRefund, ProcessorGatewayError>>;
}
