/**
 * T064 — Stripe gateway adapter (F5 Infrastructure).
 *
 * Implements `ProcessorGatewayPort`. Wraps the shared `Stripe` client
 * singleton from `./stripe-client.ts` (already carries bounded retries
 * + 10s timeout). Every public method:
 *   1. Calls the Stripe SDK with an explicit `stripeAccount` Connect
 *      scoping + (where applicable) `Idempotency-Key` via the 2nd
 *      options parameter.
 *   2. Narrows the SDK response to the port's value-object shape —
 *      `Stripe.*` types never cross the Infrastructure boundary.
 *   3. Catches `Stripe.errors.*` and maps to the port's
 *      `ProcessorGatewayError` union (`retryable` /
 *      `idempotency_conflict` / `permanent`).
 *
 * PCI SAQ-A: structured logs carry ONLY an allow-listed subset —
 * `{stripeAccount, paymentIntentId, status, idempotencyKey}`.
 * The raw SDK response object, `event.data.object`, and any card
 * field beyond `last4/brand/expMonth/expYear` are NEVER logged.
 */
import type Stripe from 'stripe';
import { err, ok, type Result } from '@/lib/result';
import { logger } from '@/lib/logger';
import type {
  ProcessorGatewayPort,
  ProcessorGatewayError,
  CreatedPaymentIntent,
  RetrievedPaymentIntent,
  CreatedRefund,
} from '../../application/ports/processor-gateway-port';
import { getStripeClient } from './stripe-client';

/**
 * Map a Stripe SDK error to the port's `ProcessorGatewayError` union.
 *
 * Stripe exposes `error.type` (SDK-level) + `error.code` (API-level)
 * + `error.statusCode` (HTTP). We classify by `type`:
 *   - `StripeConnectionError` / `StripeAPIError` → retryable
 *   - `StripeIdempotencyError` → idempotency_conflict
 *   - everything else (invalid_request, authentication, card, rate_limit,
 *     permission) → permanent
 *
 * `rate_limit` is classified `permanent` at this layer because the SDK
 * already retries 3x under the hood (see stripe-client.ts config) —
 * if it still bubbles up, the caller should surface it to the user
 * rather than loop again.
 */
function mapStripeError(
  e: unknown,
  context: { stripeAccount: string; paymentIntentId?: string | undefined },
): ProcessorGatewayError {
  const err_ = e as {
    readonly type?: string;
    readonly code?: string;
    readonly message?: string;
    readonly statusCode?: number;
  };

  const type = err_.type ?? 'unknown';
  const code = err_.code ?? type;
  const reason = err_.message ?? `Stripe ${type}`;

  // Safe structured log — only allow-list fields.
  logger.warn(
    {
      stripeAccount: context.stripeAccount,
      paymentIntentId: context.paymentIntentId,
      stripeErrorType: type,
      stripeErrorCode: err_.code,
      stripeErrorStatus: err_.statusCode,
    },
    'stripe-gateway: SDK error',
  );

  switch (type) {
    case 'StripeConnectionError':
    case 'StripeAPIError':
      return { kind: 'retryable', reason };
    case 'StripeIdempotencyError':
      return { kind: 'idempotency_conflict', reason };
    default:
      return { kind: 'permanent', code, reason };
  }
}

/**
 * Extract card metadata from a retrieved PaymentIntent's charge.
 * Returns `null` when:
 *   - the PI has no `latest_charge` (pre-confirmation / async rails)
 *   - `payment_method_details.card` is absent (e.g. promptpay)
 *
 * PCI: we COPY only the 4 allow-listed fields; the rest of
 * `payment_method_details.card` (fingerprint, iin, country, funding,
 * network, …) is dropped before the value returns to Application.
 */
function extractCardMetadata(
  pi: Stripe.PaymentIntent,
): RetrievedPaymentIntent['card'] {
  const charge =
    typeof pi.latest_charge === 'object' && pi.latest_charge !== null
      ? (pi.latest_charge as Stripe.Charge)
      : null;
  if (charge === null) return null;
  const card = charge.payment_method_details?.card ?? null;
  if (card === null) return null;
  return {
    brand: card.brand ?? 'unknown',
    last4: card.last4 ?? '',
    expMonth: card.exp_month ?? 0,
    expYear: card.exp_year ?? 0,
  };
}

function extractPromptPayQrUrl(pi: Stripe.PaymentIntent): string | null {
  // Stripe returns the QR SVG via `next_action.promptpay_display_qr_code.image_url_svg`.
  const na = pi.next_action as unknown as {
    promptpay_display_qr_code?: { image_url_svg?: string | null };
  } | null;
  return na?.promptpay_display_qr_code?.image_url_svg ?? null;
}

export const stripeGateway: ProcessorGatewayPort = {
  async createPaymentIntent(input): Promise<
    Result<CreatedPaymentIntent, ProcessorGatewayError>
  > {
    const client = getStripeClient();
    try {
      const pi = await client.paymentIntents.create(
        {
          amount: Number(input.amountSatang),
          currency: input.currency,
          payment_method_types: [...input.paymentMethodTypes],
          metadata: { ...input.metadata },
        },
        {
          idempotencyKey: input.idempotencyKey,
          stripeAccount: input.stripeAccount,
        },
      );

      logger.info(
        {
          stripeAccount: input.stripeAccount,
          paymentIntentId: pi.id,
          status: pi.status,
          idempotencyKey: input.idempotencyKey,
        },
        'stripe-gateway: createPaymentIntent ok',
      );

      if (pi.client_secret === null) {
        return err({
          kind: 'permanent',
          code: 'null_client_secret',
          reason: 'Stripe returned PaymentIntent without client_secret',
        });
      }

      return ok({
        id: pi.id,
        clientSecret: pi.client_secret,
        status: pi.status,
        livemode: pi.livemode,
        promptpayQrSvgUrl: extractPromptPayQrUrl(pi),
      });
    } catch (e) {
      return err(mapStripeError(e, { stripeAccount: input.stripeAccount }));
    }
  },

  async retrievePaymentIntent(
    paymentIntentId,
    stripeAccount,
  ): Promise<Result<RetrievedPaymentIntent, ProcessorGatewayError>> {
    const client = getStripeClient();
    try {
      const pi = await client.paymentIntents.retrieve(
        paymentIntentId,
        { expand: ['latest_charge.payment_method_details.card'] },
        { stripeAccount },
      );

      logger.info(
        {
          stripeAccount,
          paymentIntentId: pi.id,
          status: pi.status,
        },
        'stripe-gateway: retrievePaymentIntent ok',
      );

      const latestChargeId =
        typeof pi.latest_charge === 'string'
          ? pi.latest_charge
          : pi.latest_charge?.id ?? null;

      return ok({
        id: pi.id,
        status: pi.status,
        clientSecret: pi.client_secret,
        latestChargeId,
        livemode: pi.livemode,
        lastPaymentErrorCode: pi.last_payment_error?.code ?? null,
        card: extractCardMetadata(pi),
      });
    } catch (e) {
      return err(mapStripeError(e, { stripeAccount, paymentIntentId }));
    }
  },

  async cancelPaymentIntent(
    paymentIntentId,
    stripeAccount,
  ): Promise<Result<void, ProcessorGatewayError>> {
    const client = getStripeClient();
    try {
      const pi = await client.paymentIntents.cancel(paymentIntentId, {
        stripeAccount,
      } as unknown as Stripe.PaymentIntentCancelParams);
      logger.info(
        {
          stripeAccount,
          paymentIntentId: pi.id,
          status: pi.status,
        },
        'stripe-gateway: cancelPaymentIntent ok',
      );
      return ok(undefined);
    } catch (e) {
      return err(mapStripeError(e, { stripeAccount, paymentIntentId }));
    }
  },

  async createRefund(input): Promise<Result<CreatedRefund, ProcessorGatewayError>> {
    const client = getStripeClient();
    try {
      const params: Stripe.RefundCreateParams = {
        payment_intent: input.paymentIntentId,
        metadata: { ...input.metadata },
      };
      if (input.amountSatang !== undefined) {
        params.amount = Number(input.amountSatang);
      }
      if (input.reason !== undefined) {
        params.reason = input.reason as Stripe.RefundCreateParams.Reason;
      }

      const refund = await client.refunds.create(params, {
        idempotencyKey: input.idempotencyKey,
        stripeAccount: input.stripeAccount,
      });

      logger.info(
        {
          stripeAccount: input.stripeAccount,
          paymentIntentId: input.paymentIntentId,
          refundId: refund.id,
          status: refund.status,
          idempotencyKey: input.idempotencyKey,
        },
        'stripe-gateway: createRefund ok',
      );

      return ok({
        id: refund.id,
        status: refund.status ?? 'pending',
        amountSatang: BigInt(refund.amount),
      });
    } catch (e) {
      return err(
        mapStripeError(e, {
          stripeAccount: input.stripeAccount,
          paymentIntentId: input.paymentIntentId,
        }),
      );
    }
  },
};
