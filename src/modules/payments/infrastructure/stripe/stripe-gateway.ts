/**
 * Stripe gateway adapter (F5 Infrastructure).
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
import { asSatang, satangToProcessorAmount, type Satang } from '@/lib/money';
import { paymentsMetrics } from '@/lib/metrics';
import type {
  ProcessorGatewayPort,
  ProcessorGatewayError,
  CreatedPaymentIntent,
  RetrievedPaymentIntent,
  CreatedRefund,
} from '../../application/ports/processor-gateway-port';
import { getStripeClient } from './stripe-client';

// hoisted to module scope so we don't allocate two `Set`s on every
// `mapStripeError` call (this runs in the SDK error hot path during
// retries).
const NETWORK_ERROR_NAMES: ReadonlySet<string> = new Set([
  'AbortError',
  'FetchError',
  'TypeError', // fetch failed (undici v6+)
]);
const NETWORK_ERROR_CODES: ReadonlySet<string> = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ENOTFOUND',
  'ETIMEDOUT',
  'EAI_AGAIN', // transient DNS failure
  'EPIPE',
]);

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

// ---------------------------------------------------------------------------
// Webhook-read-lag retry on `retrievePaymentIntent` (fix/068, 2026-06-12).
//
// When the `payment_intent.succeeded` webhook fires, `confirmPayment`
// step 6 re-fetches the PI for card metadata (brand/last4). Stripe's
// webhook read-consistency means the object is INTERMITTENTLY not yet
// retrievable right when the event fires — the retrieve throws a
// `StripeInvalidRequestError` with `code: 'resource_missing'` / HTTP 404.
// `mapStripeError` classifies that via its default arm as `permanent`,
// so it was NOT retried → the payment row landed `method='other'` with
// no card brand/last4 (UI shows "Other"). Impact is COSMETIC (method
// label + brand/last4); the payment outcome / mark-paid / receipt are
// all correct either way.
//
// The retrieve is IDEMPOTENT, so a TIGHT bounded retry on exactly the
// webhook-read-lag shape (resource_missing / 404) self-heals the
// metadata loss within the same handler. We deliberately do NOT retry
// other `permanent` errors (card_declined, invalid params, auth) — that
// would add ~1s of pointless latency to every genuine failure. Network /
// rate-limit errors are already retried by the SDK
// (`maxNetworkRetries: 3` in stripe-client.ts) and map to `retryable`,
// so this layer must not double-handle them either.
//
// Bounds: up to 3 total attempts (1 initial + 2 retries) with ~250ms
// then ~600ms backoff → worst-case ~850ms of added handler latency
// before falling back to the unchanged exhaustion path. confirmPayment
// runs step 6 inside a tx that holds the payment row's `FOR UPDATE`
// lock, so this cap keeps lock-hold time sub-second.
const MAX_RETRIEVE_ATTEMPTS = 3;
// Backoff before attempt N (index = attempt number after the first). Two
// entries cover the two retries; the array length is the source of truth
// for "how many retries", paired with MAX_RETRIEVE_ATTEMPTS above.
const RETRIEVE_RETRY_BACKOFF_MS: readonly number[] = [250, 600];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Detect the webhook-read-lag shape: the PI referenced by a just-
 * delivered event isn't readable yet. Stripe surfaces this as a
 * `StripeInvalidRequestError` with `code === 'resource_missing'`
 * (API-level) and/or HTTP 404 (`statusCode`). We retry ONLY this shape
 * because the retrieve is idempotent and this is the documented
 * eventual-consistency window — never a genuine permanent error.
 */
function isWebhookReadLagError(e: unknown): boolean {
  const err_ = e as { code?: string; statusCode?: number };
  return err_.code === 'resource_missing' || err_.statusCode === 404;
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
    readonly param?: string;
    readonly raw?: { readonly param?: string };
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

  // Safe structured log — only allow-list fields. `param` is an
  // enum-shaped pointer to the offending API parameter
  // ("payment_method_data[billing_details][email]", etc.) — never
  // contains the value, safe to log.
  //
  // We INTENTIONALLY do not log `err_.message` because some Stripe
  // validation messages embed user-submitted values verbatim (e.g.
  // "Invalid email address: foo@bar.com"). The redact pipeline
  // matches by KEY name, not by value pattern, so an embedded email
  // would slip through. `code` + `param` give ops enough to triage
  // without exposing PII.
  const stripeErrorParam = err_.param ?? err_.raw?.param;
  logger.warn(
    {
      stripeAccount: context.stripeAccount,
      paymentIntentId: context.paymentIntentId,
      stripeErrorType: type,
      stripeErrorCode: err_.code,
      stripeErrorStatus: err_.statusCode,
      ...(stripeErrorParam ? { stripeErrorParam } : {}),
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
  if (
    (errName !== undefined && NETWORK_ERROR_NAMES.has(errName)) ||
    (errCode !== undefined && NETWORK_ERROR_CODES.has(errCode))
  ) {
    return { kind: 'retryable', reason };
  }

  switch (type) {
    case 'StripeConnectionError':
    case 'StripeAPIError':
    // SDK v10+ surfaces rate limits as a distinct
    // `StripeRateLimitError` type. The SDK already retries 3x under
    // the hood (see stripe-client.ts), so if it bubbles up here, the
    // burst is real — but classifying as `permanent` would force the
    // caller to fail the user's payment instead of letting the next
    // webhook delivery / next user retry succeed naturally. Treat as
    // retryable; the dispatch tx rolls back, processor_events row stays
    // pending, and Stripe re-delivers the webhook on its own schedule.
    case 'StripeRateLimitError':
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
    // PromptPay requires server-confirm to surface the QR in
    // `next_action`. A multi-method PI (e.g. ['promptpay','card'])
    // would skip server-confirm → return a PI with no QR → silent
    // UI failure. Reject before the SDK call so a future caller
    // can't introduce that mode without an explicit redesign.
    // Returned as a typed permanent error (not `throw`) so the
    // gateway boundary preserves the Result<T,E> contract — caller
    // uses the same `kind === 'permanent'` discriminator path as
    // for any other unrecoverable Stripe error.
    const isPromptPayOnly =
      input.paymentMethodTypes.length === 1 &&
      input.paymentMethodTypes[0] === 'promptpay';
    if (
      input.paymentMethodTypes.includes('promptpay') &&
      !isPromptPayOnly
    ) {
      return err({
        kind: 'permanent',
        code: 'promptpay_mixed_methods',
        reason:
          'PromptPay must be the only payment_method_type — server-confirm requires a single method to populate next_action.promptpay_display_qr_code. ' +
          `Received: [${input.paymentMethodTypes.join(', ')}]`,
      });
    }

    // F5R1-IMP6 — guard against bigint→number precision loss at the
    // Stripe SDK boundary. Number.MAX_SAFE_INTEGER ≈ 9e15 satang
    // (≈฿90T) — well above any realistic THB invoice. The guard is
    // belt-and-suspenders for F11 multi-currency (e.g. IDR sub-unit
    // pricing can push enterprise invoices past MAX_SAFE_INTEGER).
    // Failing-closed here means the use-case sees a typed
    // `permanent` error and audit-logs it instead of silently truncating.
    if (input.amountSatang > BigInt(Number.MAX_SAFE_INTEGER)) {
      return err({
        kind: 'permanent',
        code: 'amount_exceeds_safe_integer',
        reason: `amountSatang ${input.amountSatang} exceeds Number.MAX_SAFE_INTEGER — cannot serialise to Stripe API without precision loss`,
      });
    }

    const client = getStripeClient();
    try {
      // When the only enabled method is PromptPay, request
      // server-side confirmation in the same call so Stripe returns
      // `next_action.promptpay_display_qr_code.image_url_svg` in
      // the createPaymentIntent response. Card flows use
      // client-side confirmation via Stripe Elements.
      const createParams: Stripe.PaymentIntentCreateParams = {
        // F5R3 H-5 (2026-05-16) — single auditable boundary cast via
        // `satangToProcessorAmount`. The MAX_SAFE_INTEGER guard above
        // still applies (returns typed permanent error before reaching
        // this point); the helper revalidates as belt-and-suspenders.
        amount: satangToProcessorAmount(input.amountSatang),
        currency: input.currency,
        payment_method_types: [...input.paymentMethodTypes],
        metadata: { ...input.metadata },
      };
      if (isPromptPayOnly) {
        createParams.confirm = true;
        // Stripe rejects server-confirmed PromptPay PIs with
        // `parameter_missing: billing_details[email]` if email is
        // absent. Card flows do NOT need this — Stripe Elements
        // collects billing details client-side. Throw a typed error
        // here rather than at the SDK boundary so the failure mode
        // is obvious during composition rather than as a 502 from
        // Stripe at runtime.
        if (!input.billingEmail) {
          return err({
            kind: 'permanent',
            code: 'promptpay_billing_email_missing',
            reason:
              'PromptPay PI requires billingEmail (Stripe ' +
              '`payment_method_data.billing_details.email`). Composition ' +
              'root must plumb member email through `initiatePayment` input.',
          });
        }
        createParams.payment_method_data = {
          type: 'promptpay',
          billing_details: { email: input.billingEmail },
        };
      }
      const pi = await client.paymentIntents.create(createParams, {
        idempotencyKey: input.idempotencyKey,
        ...connectOptions(input.stripeAccount),
      });

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
    // Bounded webhook-read-lag retry (fix/068 — see MAX_RETRIEVE_ATTEMPTS
    // block above). The retrieve is idempotent; we retry ONLY the
    // resource_missing / 404 shape. Any other failure (genuine permanent,
    // idempotency, network/rate-limit) returns immediately on attempt 1.
    let lastError: unknown;
    for (let attempt = 1; attempt <= MAX_RETRIEVE_ATTEMPTS; attempt++) {
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
            ...(attempt > 1 ? { retrieveAttempt: attempt } : {}),
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
          // Surface PromptPay QR URL on retrieve so the resume path
          // of initiatePayment can re-render the QR for a member who
          // closed/reopened the drawer mid-scan. `next_action` is
          // already in the response — no extra Stripe call.
          promptpayQrSvgUrl: extractPromptPayQrUrl(pi),
        });
      } catch (e) {
        lastError = e;
        const backoffMs = RETRIEVE_RETRY_BACKOFF_MS[attempt - 1];
        // Retry ONLY the webhook-read-lag shape, and only while attempts
        // + a configured backoff remain. Everything else falls through
        // to the unchanged `mapStripeError` exhaustion path below.
        if (
          attempt < MAX_RETRIEVE_ATTEMPTS &&
          backoffMs !== undefined &&
          isWebhookReadLagError(e)
        ) {
          await sleep(backoffMs);
          continue;
        }
        break;
      }
    }
    // Exhaustion / non-retryable: return the SAME mapped error as before
    // this retry existed, so confirmPayment's existing audit
    // (`payment_processor_retrieve_failed`) + `processor_unavailable`
    // path — and Stripe's own webhook redelivery — are unchanged. Emit a
    // single summary line when retries were actually attempted (the
    // per-attempt SDK warn already fires inside `mapStripeError`; we
    // avoid log spam by summarising once here rather than per attempt).
    if (isWebhookReadLagError(lastError)) {
      logger.info(
        {
          stripeAccount,
          paymentIntentId,
          retrieveAttempts: MAX_RETRIEVE_ATTEMPTS,
        },
        'stripe-gateway: retrievePaymentIntent webhook-read-lag retries exhausted',
      );
    }
    return err(mapStripeError(lastError, { stripeAccount, paymentIntentId }));
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
      // Idempotency on already-terminal PI. Stripe returns
      // `payment_intent_unexpected_state` (HTTP 400) when the PI is
      // already in a terminal state — but that includes both `canceled`
      // (the safe-to-treat-as-success case) AND `succeeded` (where
      // returning ok would leave our DB drifted: status='canceled' while
      // Stripe says the customer was charged).
      //
      // distinguish via retrieve. Only swallow when the actual
      // Stripe status is canceled. If `succeeded`, surface a permanent
      // error so the caller (use-case) does NOT write `canceled` over a
      // valid succeeded payment.
      const err_ = e as { code?: string };
      if (err_.code === 'payment_intent_unexpected_state') {
        try {
          const client2 = getStripeClient();
          const pi = await client2.paymentIntents.retrieve(
            paymentIntentId,
            undefined,
            connectOptions(stripeAccount),
          );
          if (pi.status === 'canceled') {
            logger.info(
              { stripeAccount, paymentIntentId, stripeStatus: pi.status },
              'stripe-gateway: cancelPaymentIntent idempotent (already canceled)',
            );
            return ok(undefined);
          }
          if (pi.status === 'succeeded') {
            logger.warn(
              { stripeAccount, paymentIntentId, stripeStatus: pi.status },
              'stripe-gateway: cancelPaymentIntent rejected — PI already succeeded',
            );
            return err({
              kind: 'permanent',
              code: 'payment_intent_already_succeeded',
              reason: 'PI is succeeded; cannot be canceled',
            });
          }
          // Other terminal states (requires_capture, etc.) — fall through.
        } catch (retrieveErr) {
          // F5R1-E6 — retrieve disambiguation failed. Pre-fix this was
          // a bare `catch {}` with no log, falling through to
          // mapStripeError(original error). On a Stripe partial outage
          // where the original `payment_intent_unexpected_state` came
          // from a SUCCEEDED PI but the retrieve ALSO fails, the caller
          // mapped the original error as a permanent cancel rejection
          // and the DB then wrote `canceled` over a succeeded payment
          // (financial-integrity divergence). Log + classify retrieve
          // failure as retryable so the caller does NOT mark canceled
          // over a possibly-succeeded PI.
          logger.warn(
            {
              stripeAccount,
              paymentIntentId,
              originalErrCode: err_.code,
              retrieveErr:
                retrieveErr instanceof Error
                  ? retrieveErr.constructor.name
                  : 'unknown',
            },
            'stripe-gateway: cancelPaymentIntent disambiguation retrieve failed — caller must retry',
          );
          return err({
            kind: 'retryable',
            code: 'unexpected_state_disambiguation_failed',
            reason:
              'PI state ambiguous (cancel failed with unexpected_state + retrieve also failed); retry after Stripe recovers',
          });
        }
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
        // F5R1-IMP6 — same SafeInteger guard as createPaymentIntent.
        if (input.amountSatang > BigInt(Number.MAX_SAFE_INTEGER)) {
          return err({
            kind: 'permanent',
            code: 'amount_exceeds_safe_integer',
            reason: `refund amountSatang ${input.amountSatang} exceeds Number.MAX_SAFE_INTEGER — cannot serialise to Stripe API without precision loss`,
          });
        }
        // F5R3 H-5 (2026-05-16) — single auditable boundary cast.
        params.amount = satangToProcessorAmount(input.amountSatang);
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

      // F5R3v3 H-2 + H-3 + H-5 (2026-05-16) — defensive amount
      // projection at the Stripe→Domain boundary. Pre-fix (Batch 1)
      // we silently fell back to `input.amountSatang ?? asSatang(0n)`
      // on response-shape drift — but that means a full-refund call
      // (`input.amountSatang === undefined`) + malformed Stripe
      // response = `amountSatang: 0n` returned upward. The refund row
      // would persist with `amount_satang = 0` against a Stripe
      // refund that actually moved customer money → breaks the
      // `succeededSumSatang` invariant; next refund attempt sees full
      // remaining capacity → over-refund. Now:
      //   1. If response shape is valid: brand + return ok normally.
      //   2. If shape invalid + input.amountSatang IS provided:
      //      use the input (we know what we sent + Stripe accepted)
      //      + emit metric + structured ERROR log for SRE alerting.
      //   3. If shape invalid + input.amountSatang is undefined
      //      (full refund): return a TYPED permanent err so the
      //      caller (issueRefund) marks the refund failed and the
      //      12h out-of-band sweep cron reconciles via Stripe.
      //      Never persist a known-wrong amount.
      const isValidStripeAmount =
        Number.isFinite(refund.amount) && refund.amount >= 0;
      let refundAmount: Satang;
      if (isValidStripeAmount) {
        try {
          refundAmount = asSatang(BigInt(refund.amount));
        } catch (brandErr) {
          // Defensive — should be unreachable given isValidStripeAmount
          // gate above (Number.isFinite + >= 0 implies BigInt-safe).
          paymentsMetrics.gatewayBoundaryAmountBrandFailed('refund_create');
          logger.error(
            {
              stripeAccount: input.stripeAccount,
              paymentIntentId: input.paymentIntentId,
              refundId: refund.id,
              rawAmount: refund.amount,
              inputAmountSatang: input.amountSatang?.toString() ?? null,
              reason: 'asSatang_threw',
              errKind:
                brandErr instanceof Error
                  ? brandErr.constructor.name
                  : 'unknown',
            },
            'stripe-gateway.refund_amount_brand_failed',
          );
          if (input.amountSatang === undefined) {
            return err({
              kind: 'permanent',
              code: 'processor_response_amount_invalid',
              reason: `Stripe refund ${refund.id} response amount brand_failed; no input fallback available`,
            });
          }
          refundAmount = input.amountSatang;
        }
      } else {
        paymentsMetrics.gatewayBoundaryAmountBrandFailed('refund_create');
        logger.error(
          {
            stripeAccount: input.stripeAccount,
            paymentIntentId: input.paymentIntentId,
            refundId: refund.id,
            rawAmount: refund.amount,
            inputAmountSatang: input.amountSatang?.toString() ?? null,
            reason: 'guard_failed_non_finite_or_negative',
          },
          'stripe-gateway.refund_amount_brand_failed',
        );
        if (input.amountSatang === undefined) {
          return err({
            kind: 'permanent',
            code: 'processor_response_amount_invalid',
            reason: `Stripe refund ${refund.id} returned non-finite-or-negative amount (${refund.amount}); no input fallback available`,
          });
        }
        refundAmount = input.amountSatang;
      }
      return ok({
        id: refund.id,
        status: refund.status ?? 'pending',
        amountSatang: refundAmount,
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
