/**
 * T055 — initiatePayment use-case (F5 / payments-api.md § 1).
 *
 * Member-initiated payment-intent creation. See `payments-api.md § 1` for
 * the full error table. Returns `Result<InitiatePaymentSuccess,
 * InitiatePaymentError>` — boundary NEVER throws (Principle VIII).
 *
 * Pipeline (all in one transaction when row-insert is needed):
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

export interface InitiatePaymentInput {
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly actorMemberId: string;
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
   * Verify-fix C1 (2026-04-26).
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
  | { readonly code: 'processor_unavailable'; readonly reason: string };

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
  // Step 1: tenant settings — distinct error code for "no row exists"
  // vs "row exists with missing fields" (audit 2026-04-25 finding #1).
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
    if (e.code === 'not_found') {
      return err({ code: 'invoice_not_found' });
    }
    if (e.code === 'forbidden') {
      // F5-side probe audit (best-effort; tx=null).
      await deps.audit.emit(null, {
        tenantId: input.tenantId,
        requestId: input.requestId,
        eventType: 'payment_cross_tenant_probe',
        actorUserId: input.actorUserId,
        summary: `Cross-tenant probe on invoice ${input.invoiceId} during payment initiation`,
        payload: {
          subject_tenant_id: input.tenantId,
          probing_actor_id: input.actorUserId,
          target_entity: 'invoice',
          target_id: input.invoiceId,
        },
        retentionYears: retentionFor('payment_cross_tenant_probe'),
      });
      return err({ code: 'forbidden_invoice' });
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
    // Phase 4 fix (2026-04-25): only resume when the pending attempt
    // matches the requested method. Otherwise (e.g. user opened the
    // card tab, then switched to PromptPay) we'd hand back the existing
    // card PI's clientSecret with a null `promptpayQrSvgUrl`, which the
    // PromptPay UI renders as a load-failure. Fall through to the
    // first-attempt branch and let nextAttemptSeq + Stripe SDK create
    // a fresh PaymentIntent for the new method. The stale pending row
    // gets reaped by the stale-pending sweep cron (Phase 9 T101).
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
          reason: retrieved.error.kind,
        });
      }
      if (retrieved.value.clientSecret === null) {
        // Stripe returns null clientSecret for intents in terminal
        // states (succeeded / canceled). A pending row pointing at a
        // terminal PI is a state-drift bug upstream — surface as
        // processor_unavailable so the caller can retry after the
        // reconciliation cron normalises the payment row.
        return err<InitiatePaymentError>({
          code: 'processor_unavailable',
          reason: 'retrieved_client_secret_null',
        });
      }
      return ok<InitiatePaymentSuccess>({
        payment: pending,
        clientSecret: retrieved.value.clientSecret,
        publishableKey: settings.processorPublishableKey,
        paymentIntentId: retrieved.value.id,
        // retrievePaymentIntent does not expose the PromptPay QR SVG
        // URL (that field only comes back from createPaymentIntent's
        // next_action object). For a resumed PromptPay attempt the
        // browser re-fetches the QR via the PI's `next_action` on
        // its own using the clientSecret.
        promptpayQrSvgUrl: null,
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
    });
    if (!created.ok) {
      return err<InitiatePaymentError>({
        code: 'processor_unavailable',
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
