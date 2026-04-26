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
  readonly amountSatang: bigint;
}

import type { Result } from '@/lib/result';

export interface ProcessorGatewayPort {
  createPaymentIntent(input: {
    readonly amountSatang: bigint;
    readonly currency: 'thb';
    readonly paymentMethodTypes: readonly ('card' | 'promptpay')[];
    readonly metadata: Readonly<Record<string, string>>;
    readonly idempotencyKey: string;
    readonly stripeAccount: string;      // Connect account = tenant's stripe account id
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
    readonly amountSatang?: bigint;     // omit for full refund
    readonly reason?: string;
    readonly metadata: Readonly<Record<string, string>>;
    readonly idempotencyKey: string;
    readonly stripeAccount: string;
  }): Promise<Result<CreatedRefund, ProcessorGatewayError>>;
}
