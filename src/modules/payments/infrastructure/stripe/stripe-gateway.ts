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
import { env } from '@/lib/env';
import type {
  ProcessorGatewayPort,
  ProcessorGatewayError,
  CreatedPaymentIntent,
  RetrievedPaymentIntent,
  CreatedRefund,
} from '../../application/ports/processor-gateway-port';
import { getStripeClient } from './stripe-client';

/**
 * Build Stripe SDK request options, omitting `stripeAccount` when the
 * target account IS the platform's own account.
 *
 * Rationale (F5 MVP, 2026-04-24): F5 ships as single-tenant SweCham.
 * When the `processor_account_id` stored on `tenant_payment_settings`
 * equals the platform's own account id (i.e. the secret key's owning
 * account), passing `stripeAccount: <same-account>` triggers a Connect
 * "act on behalf of" call — which requires the platform to have Connect
 * enabled AND the target to be a Connected account. SweCham is the
 * platform itself; there is no Connect relationship, so the call 403s
 * with `platform_account_required`.
 *
 * F11 SaaS Billing re-introduces Connect for per-tenant merchant
 * accounts — at that point `processor_account_id` will differ from the
 * platform account for every non-SweCham tenant, and this helper
 * naturally emits `stripeAccount` for them.
 *
 * Tradeoff: we emit `stripeAccount` only when strictly necessary. PCI
 * log context preserves the original `stripeAccount` value regardless
 * so observability stays unambiguous.
 */
function shouldActOnBehalfOf(stripeAccount: string): boolean {
  return stripeAccount !== env.stripe.accountIdSwecham;
}

function connectOptions(stripeAccount: string): { stripeAccount?: string } {
  return shouldActOnBehalfOf(stripeAccount) ? { stripeAccount } : {};
}

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
 *
 * Exported (vs. module-private) so a unit test can throw synthetic
 * Stripe error instances directly at the mapper without going through
 * the SDK + HTTP transport. Production callers MUST go through the
 * gateway methods — no other module imports this symbol.
 */
export function mapStripeError(
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
  // Audit 2026-04-25 finding #1: do NOT fall back to `type` as `code`.
  // SDK's `error.type` is the JS class name (e.g. 'StripeCardError');
  // `error.code` is the API decline code (e.g. 'card_declined'). UI
  // consumers (CardForm decline_code switch) match against the API code
  // — falling back to the class name silently mis-routes every code-less
  // error (genuinely rare for Stripe, but downstream consumers cannot
  // distinguish "Stripe forgot to set a code" from "wrong code").
  const code = err_.code ?? 'unknown_stripe_error';
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

  // Audit 2026-04-25 finding #12 + R1 self-review M (2026-04-26):
  // classify network errors as retryable even when they don't carry a
  // Stripe `type` (e.g. raw fetch/undici errors that escape the SDK's
  // own catch). The Stripe SDK normally wraps these as
  // `StripeConnectionError`, but mid-flight aborts + DNS-level
  // failures can surface as bare Node errors. Check both `.name`
  // (fetch/undici class names) AND `.code` (Node net errno strings)
  // so we catch both the fetch-based httpClient path AND the legacy
  // Node `https` path.
  const errName = (e as { name?: string })?.name;
  const errCode = (e as { code?: string })?.code;
  const NETWORK_ERROR_NAMES = new Set([
    'AbortError',
    'FetchError',
    'TypeError', // fetch failed (undici v6+)
  ]);
  const NETWORK_ERROR_CODES = new Set([
    'ECONNRESET',
    'ECONNREFUSED',
    'ENOTFOUND',
    'ETIMEDOUT',
    'EAI_AGAIN', // transient DNS failure
    'EPIPE',
  ]);
  if (
    (errName !== undefined && NETWORK_ERROR_NAMES.has(errName)) ||
    (errCode !== undefined && NETWORK_ERROR_CODES.has(errCode))
  ) {
    return { kind: 'retryable', reason };
  }

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
  // Audit 2026-04-25 finding #11: return `null` if any of the 4 allow-
  // listed fields is missing. Previously defaulted to literal strings
  // (`'unknown'`, `''`, `0`) which would render as "card ending ****"
  // (4 stars only) in the UI confirmation panel + log "0/0" exp dates
  // into audit. Treat partial card data as no card data.
  if (
    typeof card.brand !== 'string' ||
    typeof card.last4 !== 'string' ||
    typeof card.exp_month !== 'number' ||
    typeof card.exp_year !== 'number'
  ) {
    return null;
  }
  return {
    brand: card.brand,
    last4: card.last4,
    expMonth: card.exp_month,
    expYear: card.exp_year,
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
          ...connectOptions(input.stripeAccount),
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
        connectOptions(stripeAccount),
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
      const pi = await client.paymentIntents.cancel(
        paymentIntentId,
        undefined,
        connectOptions(stripeAccount),
      );
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
      // Review CR-2: idempotency on already-canceled. Stripe returns
      // `payment_intent_unexpected_state` (HTTP 400) when the PI is
      // already in a terminal state (canceled / succeeded). For a cancel
      // call the only safe interpretation is "the desired post-state is
      // already true" — we return ok(void) so the caller can proceed
      // with the local DB write. This closes the partial-failure trap
      // where Stripe cancel succeeded on attempt N, the DB write failed,
      // and attempt N+1 would otherwise hit a hard permanent error and
      // leave the row stuck `pending`.
      const err_ = e as { code?: string };
      if (err_.code === 'payment_intent_unexpected_state') {
        logger.info(
          {
            stripeAccount,
            paymentIntentId,
            stripeErrorCode: err_.code,
          },
          'stripe-gateway: cancelPaymentIntent idempotent (already terminal)',
        );
        return ok(undefined);
      }
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
        ...connectOptions(input.stripeAccount),
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
