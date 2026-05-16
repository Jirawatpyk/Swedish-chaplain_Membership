/**
 * initiatePayment use-case (F5 / payments-api.md § 1).
 *
 * Member-initiated payment-intent creation. See `payments-api.md § 1` for
 * the full error table. Returns `Result<InitiatePaymentSuccess,
 * InitiatePaymentError>` — boundary NEVER throws (Principle VIII).
 *
 * Pipeline:
 *   Pre-tx (steps 1–4): tenant settings load + completeness gate +
 *   method-enabled gate + F4 invoice payability bridge. These run
 *   OUTSIDE `withTx` because `getByTenantId` does not accept a `tx`
 *   parameter (its Drizzle adapter wraps an `unstable_cache` fetcher
 *   on its own connection) and the F4 bridge owns its own tx for
 *   the cross-tenant-probe audit. M-2 (review 2026-04-27): clarified
 *   from the prior misleading "all in one transaction" claim — only
 *   steps 5–6 are inside `paymentsRepo.withTx`.
 *
 *   1. Load tenant settings (cached). `null` → tenant_settings_incomplete.
 *   2. assertSettingsComplete → map any `reason` to a typed error.
 *   3. isMethodEnabled(method) → method_not_enabled.
 *   4. F4 bridge getInvoiceForPayment → map `not_found` / `forbidden` /
 *      `not_payable` to typed errors. For forbidden (cross-tenant) the F4
 *      bridge already emits `invoice_cross_tenant_probe`; we ALSO emit
 *      `payment_cross_tenant_probe` for F5-side forensic visibility.
 *   5. withTx → nextAttemptSeq → findPendingByInvoiceAndActor.
 *      - Resume hit: return the existing payment WITHOUT re-auditing (the
 *        first `payment_initiated` row already exists). Stripe SDK
 *        `retrievePaymentIntent` fetches the live clientSecret.
 *      - No resume: generate new payment id, INSERT pending row,
 *        createPaymentIntent (idempotencyKey = `inv-<id>-attempt-<seq>`),
 *        emit `payment_initiated` audit.
 *   6. Return `{ payment, clientSecret, publishableKey, paymentIntentId,
 *      promptpayQrSvgUrl }`.
 *
 * RBAC: caller (route handler) already gates `role='member'` via F1
 * `requireMemberContext` + F5 `isAllowed('member','payments','initiate')`.
 *
 * Security-critical → 100% branch coverage (Principle II).
 */
import { err, ok, type Result } from '@/lib/result';
import type {
  AuditPort,
  ClockPort,
  InvoicingBridgePort,
  PaymentsRepo,
  ProcessorGatewayError,
  ProcessorGatewayPort,
  TenantPaymentSettingsRepo,
} from '../ports';
import { retentionFor } from '../ports/audit-port';
import type { Payment, PaymentId } from '../../domain/payment';
import type { PaymentMethod } from '../../domain/value-objects/payment-method';
import {
  assertSettingsComplete,
  isMethodEnabled,
  type SettingsIncompleteReason,
} from '../../domain/tenant-payment-settings';
import { paymentsMetrics } from '@/lib/metrics';
import { paymentsTracer } from '@/lib/otel-tracer';
import { SpanStatusCode } from '@opentelemetry/api';

export interface InitiatePaymentInput {
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly actorMemberId: string;
  /**
   * Member's account email — required for Stripe PromptPay PIs.
   * Stripe's `payment_method_data.billing_details.email` is mandatory
   * when we server-confirm a PromptPay PaymentMethod (Card flow uses
   * Stripe Elements which collects billing details client-side).
   * Always populated from `requireMemberContext().current.user.email`.
   */
  readonly actorEmail: string;
  readonly invoiceId: string;
  readonly method: PaymentMethod;
  readonly correlationId: string;
  readonly requestId: string | null;
}

export interface InitiatePaymentSuccess {
  readonly payment: Payment;
  readonly clientSecret: string;
  readonly publishableKey: string;
  readonly paymentIntentId: string;
  readonly promptpayQrSvgUrl: string | null;
  /**
   * Tenant-configured PromptPay QR expiry window in seconds (sourced
   * from `tenant_payment_settings.promptpay_qr_expiry_seconds`). Always
   * populated — defaults from the DB column (typically 900s = 15 min)
   * apply at insert time. Frontend uses this to drive the countdown
   * timer in <PromptPayPanel> rather than hardcoding a default.
   */
  readonly promptpayQrExpirySeconds: number;
  /** True when this is a resume (pre-existing pending row) — caller skips audit. */
  readonly resumed: boolean;
}

export type InitiatePaymentError =
  | { readonly code: 'invoice_not_found' }
  | { readonly code: 'forbidden_invoice' }
  | { readonly code: 'invoice_not_payable'; readonly currentStatus: string }
  | { readonly code: 'online_payment_disabled' }
  | { readonly code: 'method_not_enabled'; readonly requestedMethod: PaymentMethod }
  | {
      readonly code: 'tenant_settings_incomplete';
      /**
       * The single reason completeness validation failed. Was previously
       * typed as `readonly SettingsIncompleteReason[]` but always
       * contained exactly one element — `assertSettingsComplete` returns
       * on first violation. Renamed to scalar for honesty (audit
       * 2026-04-25 finding #2).
       */
      readonly reason: SettingsIncompleteReason;
    }
  | {
      readonly code: 'processor_unavailable';
      /**
       * `kind` mirrors `ProcessorGatewayError.kind` so the route handler
       * can gate `Retry-After` on `'retryable'` only — permanent errors
       * (e.g. PromptPay-not-enabled, country-mismatch, key-mismatch)
       * never recover within 30 s and should not advertise a retry
       * window. `reason` is a CLOSED literal-union: the type system
       * prevents free-form Stripe SDK messages from being assigned
       * here, so the route handler can safely log `processorErrorReason`
       * without PCI hygiene risk. Adding a new value REQUIRES updating
       * this union — making the surface auditable at compile time.
       */
      readonly kind: ProcessorGatewayError['kind'];
      readonly reason:
        // Echo of `ProcessorGatewayError.kind` for the standard
        // create/retrieve gateway-error paths. Reusing the port's
        // own union ensures any new kind added to the gateway
        // automatically widens the use-case union — no drift.
        | ProcessorGatewayError['kind']
        // Resume-path: Stripe returned a PI in a terminal state with
        // `null` clientSecret; sweep cron normalises the row.
        | 'retrieved_client_secret_null'
        // Cross-method-skip: Stripe reports the original-method PI as
        // already succeeded (race vs webhook).
        | 'cross_method_pi_already_succeeded'
        // Cross-method-skip: Stripe cancel returned a transient error;
        // we abort without DB write to avoid the DB-canceled vs
        // Stripe-pending drift the sweep cron is not designed to detect.
        | 'cross_method_cancel_retryable';
    };

export interface InitiatePaymentDeps {
  readonly paymentsRepo: PaymentsRepo;
  readonly tenantSettingsRepo: TenantPaymentSettingsRepo;
  readonly processorGateway: ProcessorGatewayPort;
  readonly invoicingBridge: InvoicingBridgePort;
  readonly audit: AuditPort;
  readonly clock: ClockPort;
  /** Returns a fresh payment id, e.g., `pmt_<ulid>`. Injected for deterministic tests. */
  readonly generatePaymentId: () => PaymentId;
  /**
   * Strategy for the Stripe `Idempotency-Key`. Receives the canonical
   * base key (`inv-<id>-attempt-<seq>`) and returns the final key sent
   * to Stripe.
   *
   * Production composition root wires the IDENTITY function so the
   * seq-based key is the dedupe contract — two concurrent retries
   * map to the same Stripe PI.
   *
   * Dev composition root wires a `(base) => `${base}-d-${Date.now()}`
   * variant so repeat test runs never collide with Stripe's 24-hour
   * idempotency-key cache (which would otherwise reject re-use of the
   * same key with mismatched params via 400 `StripeIdempotencyError`
   * → route 502 `processor_unavailable`).
   *
   * Defaults to identity when omitted (existing tests need no change).
   */
  readonly idempotencyKeyFactory?: (baseKey: string) => string;
}

export async function initiatePayment(
  deps: InitiatePaymentDeps,
  input: InitiatePaymentInput,
): Promise<Result<InitiatePaymentSuccess, InitiatePaymentError>> {
  // T140 OTel span: hop 2 of `portal_click → api_payments_initiate →
  // stripe_create_intent → ...` (plan.md § VII). Auto-instrumentation
  // already wraps the route handler (hop 1) + Stripe SDK fetch (hop 3);
  // this span captures the use-case boundary so traces show where
  // tenant settings load + invoice payability + tx work happens.
  // Capture start time at function entry so all exit paths —
  // including pre-Stripe early errors (settings_row_missing,
  // method_not_enabled, invoice bridge failures) — contribute to
  // the latency histogram. `try/finally` guarantees the metric
  // fires on every code path (success + every typed error
  // variant), regardless of where the body returns from.
  const initiateStartMs = deps.clock.nowMs();
  return await paymentsTracer().startActiveSpan(
    'payments.initiate',
    {
      attributes: {
        'payments.method': input.method,
        'payments.invoice_id': input.invoiceId,
        'payments.tenant_id': input.tenantId,
      },
    },
    async (span) => {
      try {
        const result = await initiatePaymentBody(deps, input);
        if (!result.ok) {
          span.setAttribute('payments.outcome', result.error.code);
        } else {
          span.setAttribute('payments.outcome', 'ok');
          span.setAttribute('payments.resumed', result.value.resumed);
        }
        return result;
        /* v8 ignore start — tracer error-status path; initiatePaymentBody
         * always returns Result<...> instead of throwing. The catch is
         * defence-in-depth for unexpected runtime exceptions (e.g. OOM,
         * tracer-internal throw) that bypass the typed Result contract. */
      } catch (e) {
        span.setStatus({
          code: SpanStatusCode.ERROR,
          // F5R3 LOW (2026-05-16) — H-4 hygiene; see confirm-payment.ts.
          message: e instanceof Error ? e.constructor.name : 'initiate_threw',
        });
        throw e;
        /* v8 ignore stop */
      } finally {
        paymentsMetrics.initiateDurationMs(
          input.method,
          deps.clock.nowMs() - initiateStartMs,
          input.tenantId,
        );
        span.end();
      }
    },
  );
}

async function initiatePaymentBody(
  deps: InitiatePaymentDeps,
  input: InitiatePaymentInput,
): Promise<Result<InitiatePaymentSuccess, InitiatePaymentError>> {
  // Step 1: tenant settings — distinct error code for "no row exists"
  // vs "row exists with missing fields".
  const settings = await deps.tenantSettingsRepo.getByTenantId(input.tenantId);
  if (!settings) {
    return err({
      code: 'tenant_settings_incomplete',
      reason: 'settings_row_missing',
    });
  }

  // Step 2: completeness check
  const completeness = assertSettingsComplete(settings);
  if (!completeness.ok) {
    if (completeness.reason === 'online_payment_disabled') {
      return err({ code: 'online_payment_disabled' });
    }
    return err({
      code: 'tenant_settings_incomplete',
      reason: completeness.reason,
    });
  }

  // Step 3: method gating
  if (!isMethodEnabled(settings, input.method)) {
    return err({ code: 'method_not_enabled', requestedMethod: input.method });
  }

  // Step 4: invoice payability (F4 bridge). `actor` present so the
  // bridge emits `invoice_cross_tenant_probe` on forbidden paths.
  const invoiceResult = await deps.invoicingBridge.getInvoiceForPayment({
    tenantId: input.tenantId,
    invoiceId: input.invoiceId,
    actor: {
      userId: input.actorUserId,
      role: 'member',
      requestId: input.requestId,
      memberId: input.actorMemberId,
    },
  });
  if (!invoiceResult.ok) {
    const e = invoiceResult.error;
    if (e.code === 'not_found' || e.code === 'forbidden') {
      // CR-5 fix (R2 audit 2026-04-27): emit F5-side probe audit on
      // BOTH `not_found` and `forbidden` outcomes. F4's RLS layer
      // returns `not_found` for cross-tenant invoices (Principle I
      // sub-clause: ambiguous-by-design), so the `forbidden` branch
      // alone never fires in a real 2-tenant scenario. The audit row
      // is best-effort (`null` tx) and uses `acting_tenant_id` to
      // align with cancel-payment's payload key (audit 2026-04-25
      // finding #12 — naming consistency).
      await deps.audit.emit(null, {
        tenantId: input.tenantId,
        requestId: input.requestId,
        eventType: 'payment_cross_tenant_probe',
        actorUserId: input.actorUserId,
        summary: `Cross-tenant probe on invoice ${input.invoiceId} during payment initiation`,
        payload: {
          acting_tenant_id: input.tenantId,
          probing_actor_id: input.actorUserId,
          target_entity: 'invoice',
          target_id: input.invoiceId,
          bridge_outcome: e.code,
        },
        retentionYears: retentionFor('payment_cross_tenant_probe'),
      });
      return err({
        code: e.code === 'not_found' ? 'invoice_not_found' : 'forbidden_invoice',
      });
    }
    // not_payable
    return err({ code: 'invoice_not_payable', currentStatus: e.status });
  }
  const invoice = invoiceResult.value;

  // Audit 2026-04-25 follow-up: F4's `getInvoiceForPayment` returns
  // `ok({status: 'paid'})` for already-settled invoices (it only
  // hard-rejects on `null`/zero `total`). If we don't gate here, the
  // use-case happily creates a NEW Stripe PI for a paid invoice —
  // CardForm then mounts with a clientSecret pointing at a PI that
  // Stripe will refuse to confirm (or worse, double-charges if the
  // member follows through). Reject explicitly so the route returns
  // a typed error and the UI can route to "already paid" UX instead
  // of trying to render a card form against a settled invoice.
  if (invoice.status === 'paid') {
    return err({ code: 'invoice_not_payable', currentStatus: invoice.status });
  }

  // Step 5 + 6: withTx → resume or insert+createIntent+audit.
  return await deps.paymentsRepo.withTx(async (tx) => {
    // advisory lock on (tenantId, invoiceId) so
    // two concurrent initiate calls for the same invoice are serialised
    // at the DB layer. Without it, the findPending TOCTOU window lets
    // two callers both miss the pending row and both reach Stripe
    // createPaymentIntent — wasting one Stripe call (idempotency-key
    // dedupes the PI itself, but we'd emit duplicate audit + metric).
    // The lock auto-releases at tx end.
    await deps.paymentsRepo.acquireInitiateLock(tx, input.tenantId, input.invoiceId);
    // Resume check FIRST — if a pending attempt by this actor exists,
    // return it verbatim (same clientSecret path). Reliability F-01
    // idempotency: member clicks "Pay" twice → one intent.
    //
    // Reliability D-01 (Group E1, 2026-04-24): pass `tx` so the lookup
    // runs inside the same serializable snapshot as the subsequent
    // INSERT — prevents TOCTOU where two concurrent calls both miss
    // the pending row and both attempt to insert.
    const pending = await deps.paymentsRepo.findPendingByInvoiceAndActor(
      input.tenantId,
      input.invoiceId,
      input.actorUserId,
      tx,
    );
    // Resume only when the pending attempt matches the requested
    // method. Otherwise (user opened card tab, switched to PromptPay)
    // a card `clientSecret` would be returned for a PromptPay request
    // with `promptpayQrSvgUrl=null` → silent UI failure.
    //
    // Cross-method skip path: cancel the mismatched-method PI on
    // Stripe + mark its DB row `canceled` BEFORE falling through.
    // Lock-hold tradeoff: `cancelPaymentIntent` is a network call
    // (≤10 s timeout, see stripe-client.ts) that runs inside the
    // tx, so the row-lock is held until Stripe responds. This is
    // acceptable because (a) cross-method switch is a rare user
    // action, (b) the alternative (cancel outside tx) would
    // sacrifice atomicity — a partial completion could leave a
    // canceled Stripe PI with a still-`pending` DB row that the
    // next request would pick up again.
    if (pending && pending.method !== input.method) {
      const cancelStartMs = deps.clock.nowMs();
      const cancelResult = await deps.processorGateway.cancelPaymentIntent(
        pending.processorPaymentIntentId,
        settings.processorAccountId,
      );
      // Cross-method-cancel latency — scope is Stripe SDK roundtrip
      // only (excludes the surrounding tx + findPending lookup).
      paymentsMetrics.crossMethodCancelDurationMs(
        cancelResult.ok ? 'ok' : cancelResult.error.kind,
        deps.clock.nowMs() - cancelStartMs,
      );
      // Financial-integrity guard: Stripe reports `succeeded` when
      // the customer paid via the original method (e.g. card 3DS
      // just resolved) but our webhook hasn't arrived yet. Marking
      // the row `canceled` here would create a DB-says-canceled vs
      // Stripe-says-paid drift while the customer was actually
      // charged. Surface as `processor_unavailable` so the new-
      // method initiate aborts; the inbound webhook reconciles
      // shortly.
      if (
        !cancelResult.ok &&
        cancelResult.error.kind === 'permanent' &&
        cancelResult.error.code === 'payment_intent_already_succeeded'
      ) {
        return err<InitiatePaymentError>({
          code: 'processor_unavailable',
          kind: 'permanent',
          reason: 'cross_method_pi_already_succeeded',
        });
      }
      // Retryable-cancel guard: when Stripe returns a transient
      // error (network timeout, rate-limit), the PI may STILL be
      // `pending` upstream.
      // Marking our DB row `canceled` would create the opposite
      // drift (DB-canceled / Stripe-pending) which the stale-
      // pending sweep cron is NOT designed to detect (it scans
      // for `status='pending'`). The customer's old PI could later
      // auto-confirm without our row being there to reconcile —
      // financial-integrity class bug. Bail without writing the
      // DB; client UX surfaces "try again".
      if (!cancelResult.ok && cancelResult.error.kind === 'retryable') {
        return err<InitiatePaymentError>({
          code: 'processor_unavailable',
          kind: 'retryable',
          reason: 'cross_method_cancel_retryable',
        });
      }
      // Cancel outcome is now safe to mark on the DB row. Either
      // (a) Stripe confirmed the cancel, or (b) Stripe returned a
      // permanent non-succeeded error (already-canceled / not-found
      // / etc.) — both leave Stripe in a terminal-non-succeeded
      // state from our perspective, so the local row CAN be
      // marked canceled. The audit `cancel_outcome` discriminator
      // distinguishes the two paths for forensics.
      const cancelOutcome: 'stripe_confirmed' | 'stripe_error_bypassed' =
        cancelResult.ok ? 'stripe_confirmed' : 'stripe_error_bypassed';

      await deps.paymentsRepo.updateStatus(tx, {
        paymentId: pending.id,
        tenantId: pending.tenantId,
        nextStatus: 'canceled',
        completedAt: new Date(deps.clock.nowIso()),
      });
      // Distinct event type from `payment_canceled` (which
      // semantically means user-abandon / sweep-cron / explicit
      // cancel). Method-switch is a different forensic class:
      // the user did NOT abandon — they continued to a different
      // rail. Distinguishing makes audit-log queries unambiguous
      // (Constitution Principle I sub-clause #4).
      await deps.audit.emit(tx, {
        tenantId: input.tenantId,
        requestId: input.requestId,
        eventType: 'payment_method_switched',
        actorUserId: input.actorUserId,
        summary: `Payment ${pending.id} method switched from ${pending.method} to ${input.method}`,
        payload: {
          payment_id: pending.id,
          previous_method: pending.method,
          new_method: input.method,
          processor_payment_intent_id: pending.processorPaymentIntentId,
          attempt_seq: pending.attemptSeq,
          cancel_outcome: cancelOutcome,
        },
        retentionYears: retentionFor('payment_method_switched'),
      });
      // Fall through to first-attempt flow below.
    }
    if (pending && pending.method === input.method) {
      // Architect D-01 (Group E1, 2026-04-24): resume path reads the
      // live `clientSecret` from `retrievePaymentIntent` directly. The
      // previous workaround re-invoked `createPaymentIntent` with the
      // same idempotency key to recover the secret — correct but
      // double-billed Stripe API calls + risked subtle idempotency
      // divergence when the stored metadata shifted shape between
      // attempts. The gateway port now exposes `clientSecret` on the
      // retrieve-shape (PCI SAQ-A: never logged, never persisted at
      // rest, only passed through to the browser in the response body).
      const retrieved = await deps.processorGateway.retrievePaymentIntent(
        pending.processorPaymentIntentId,
        settings.processorAccountId,
      );
      if (!retrieved.ok) {
        return err<InitiatePaymentError>({
          code: 'processor_unavailable',
          kind: retrieved.error.kind,
          reason: retrieved.error.kind,
        });
      }
      if (retrieved.value.clientSecret === null) {
        // Stripe returns null clientSecret for intents in terminal
        // states (succeeded / canceled). A pending row pointing at a
        // terminal PI is a state-drift bug upstream — classify as
        // permanent (the cron normalises the row; the user retrying
        // 30s later won't help).
        return err<InitiatePaymentError>({
          code: 'processor_unavailable',
          kind: 'permanent',
          reason: 'retrieved_client_secret_null',
        });
      }
      // T141 metric: count successful initiates (resume hit) so the
      // RED-rate gauge captures both first-attempt + resume paths.
      paymentsMetrics.initiateCount(input.tenantId, input.method);
      return ok<InitiatePaymentSuccess>({
        payment: pending,
        clientSecret: retrieved.value.clientSecret,
        publishableKey: settings.processorPublishableKey,
        paymentIntentId: retrieved.value.id,
        // retrievePaymentIntent expands `next_action` and returns
        // `promptpayQrSvgUrl` for any PromptPay PI still in the scan
        // window, so the resumed attempt re-renders the same QR
        // without a "load failed" failure-state flash.
        promptpayQrSvgUrl: retrieved.value.promptpayQrSvgUrl,
        promptpayQrExpirySeconds: settings.promptpayQrExpirySeconds,
        resumed: true,
      });
    }

    // First-attempt flow.
    const attemptSeq = await deps.paymentsRepo.nextAttemptSeq(
      tx,
      input.tenantId,
      input.invoiceId,
    );
    const paymentId = deps.generatePaymentId();
    // Idempotency-Key strategy is injected by the composition root —
    // see `InitiatePaymentDeps.idempotencyKeyFactory` JSDoc. Default
    // is identity, so omitting the dep yields the canonical base key
    // (production semantics + existing test fixtures unchanged).
    const baseKey = `inv-${input.invoiceId}-attempt-${attemptSeq}`;
    const idempotencyKey = deps.idempotencyKeyFactory
      ? deps.idempotencyKeyFactory(baseKey)
      : baseKey;

    // Create intent BEFORE DB insert — failure here means no wasted
    // sequence + no orphan row (we haven't written anything yet).
    const created = await deps.processorGateway.createPaymentIntent({
      amountSatang: invoice.totalSatang,
      currency: 'thb',
      paymentMethodTypes: [input.method],
      metadata: {
        invoiceId: input.invoiceId,
        tenantId: input.tenantId,
        paymentId,
      },
      idempotencyKey,
      stripeAccount: settings.processorAccountId,
      // Required by Stripe for server-confirmed PromptPay PIs (the
      // gateway only embeds it when method='promptpay').
      billingEmail: input.actorEmail,
    });
    if (!created.ok) {
      return err<InitiatePaymentError>({
        code: 'processor_unavailable',
        kind: created.error.kind,
        reason: created.error.kind,
      });
    }

    const nowIso = deps.clock.nowIso();
    const initiatedAt = new Date(nowIso);

    const payment = await deps.paymentsRepo.insert(tx, {
      id: paymentId,
      tenantId: input.tenantId,
      invoiceId: input.invoiceId,
      memberId: invoice.memberId,
      method: input.method,
      amountSatang: invoice.totalSatang,
      processorPaymentIntentId: created.value.id,
      processorEnvironment: settings.processorEnvironment,
      attemptSeq,
      initiatedAt,
      actorUserId: input.actorUserId,
      correlationId: input.correlationId,
    });

    await deps.audit.emit(tx, {
      tenantId: input.tenantId,
      requestId: input.requestId,
      eventType: 'payment_initiated',
      actorUserId: input.actorUserId,
      summary: `Payment initiated for invoice ${input.invoiceId} via ${input.method}`,
      payload: {
        payment_id: paymentId,
        invoice_id: input.invoiceId,
        method: input.method,
        amount_satang: invoice.totalSatang.toString(),
        processor_payment_intent_id: created.value.id,
        attempt_seq: attemptSeq,
      },
      retentionYears: retentionFor('payment_initiated'),
    });

    // T141 metric: count successful first-attempt initiates by method.
    paymentsMetrics.initiateCount(input.tenantId, input.method);

    return ok<InitiatePaymentSuccess>({
      payment,
      clientSecret: created.value.clientSecret,
      publishableKey: settings.processorPublishableKey,
      paymentIntentId: created.value.id,
      promptpayQrSvgUrl: created.value.promptpayQrSvgUrl,
      promptpayQrExpirySeconds: settings.promptpayQrExpirySeconds,
      resumed: false,
    });
  });
}
