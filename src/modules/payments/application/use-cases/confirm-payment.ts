/**
 * T057 — confirmPayment use-case (F5 / stripe-webhook.md § 4.1).
 *
 * Handles `payment_intent.succeeded` webhook dispatch. Security-critical:
 * 100% branch coverage (Principle II).
 *
 * Pipeline (inside withTx):
 *   1. lockForUpdate on payments row by processor_payment_intent_id.
 *      Not found → `unknown_intent` outcome (warn log; route returns 200).
 *   2. getInvoiceForPayment via F4 bridge (webhook-side, no actor).
 *      Not found → surface as error for caller logging; route returns 200.
 *   3. Stale-invoice auto-refund (FR-011b):
 *      If invoice.status ∉ { 'issued', 'overdue' } → createRefund(FULL) +
 *      audit `payment_auto_refunded_stale_invoice` + return
 *      `auto_refunded` outcome.
 *   4. canTransition(payment.status, 'succeeded'):
 *      - terminal state: this is a Stripe retry of a row we already
 *        advanced. Return `already_succeeded` (no-op, NOT an error).
 *      - illegal from pending → err (unexpected state).
 *   5. enforceOneSucceededPerInvoice(siblingStatuses) — 1-per-invoice
 *      invariant. Violation → err.
 *   6. retrievePaymentIntent via gateway to obtain card metadata.
 *   7. updateStatus → succeeded + processor_charge_id + card_* + completed_at.
 *   8. audit payment_succeeded.
 *   9. invoicingBridge.markPaidFromProcessor (F4 transitions invoice →
 *      paid atomically with our tx in the same DB connection).
 *   10. return `processed`.
 */
import { err, ok, type Result } from '@/lib/result';
import type {
  AuditPort,
  ClockPort,
  InvoicingBridgePort,
  PaymentsRepo,
  ProcessorEventsRepo,
  ProcessorGatewayPort,
  TenantPaymentSettingsRepo,
} from '../ports';
import { canTransition } from '../../domain/policies/payment-status-transitions';
import { enforceOneSucceededPerInvoice } from '../../domain/invariants/one-succeeded-payment-per-invoice';
import { SYSTEM_ACTOR_STRIPE_WEBHOOK } from '../../domain/system-actors';
import { bangkokLocalDate } from '@/lib/fiscal-year';

export interface ConfirmPaymentInput {
  readonly tenantId: string;
  readonly paymentIntentId: string;
  readonly correlationId: string;
  readonly requestId: string | null;
  /** Event creation unix-seconds — used for completed_at ordering. */
  readonly eventCreatedAtUnixSeconds: number;
  /**
   * The Stripe `event.id` (`evt_...`) being dispatched. Used to mark
   * the corresponding `processor_events` row as `processed_at = now()`
   * inside the same dispatch tx — eliminates the split-tx window
   * documented in `processWebhookEvent` (audit 2026-04-25 finding #4).
   * Optional for backward compat: when omitted, the parent
   * `processWebhookEvent` runs the markProcessed call in a separate tx.
   */
  readonly processorEventId?: string;
}

export type ConfirmPaymentOutcome =
  | { readonly kind: 'processed' }
  | { readonly kind: 'already_succeeded' }
  | { readonly kind: 'unknown_intent' }
  | { readonly kind: 'auto_refunded_stale_invoice' };

export type ConfirmPaymentError =
  | { readonly code: 'invoice_not_found' }
  | { readonly code: 'illegal_transition'; readonly from: string }
  | { readonly code: 'invariant_violation_duplicate_succeeded' }
  | { readonly code: 'processor_unavailable'; readonly reason: string }
  | { readonly code: 'bridge_error'; readonly detail: string };

export interface ConfirmPaymentDeps {
  readonly paymentsRepo: PaymentsRepo;
  readonly tenantSettingsRepo: TenantPaymentSettingsRepo;
  readonly processorGateway: ProcessorGatewayPort;
  readonly invoicingBridge: InvoicingBridgePort;
  readonly audit: AuditPort;
  readonly clock: ClockPort;
  /**
   * Optional — when supplied alongside `input.processorEventId`,
   * `markProcessed` runs inside this use-case's withTx so the dispatch
   * + markProcessed commit atomically (audit 2026-04-25 finding #4).
   */
  readonly processorEventsRepo?: ProcessorEventsRepo;
}

export async function confirmPayment(
  deps: ConfirmPaymentDeps,
  input: ConfirmPaymentInput,
): Promise<Result<ConfirmPaymentOutcome, ConfirmPaymentError>> {
  const settings = await deps.tenantSettingsRepo.getByTenantId(input.tenantId);
  if (!settings) {
    // Pre-resolution tenant miss is handled at the route; if we're here
    // without settings, log via caller's warn path.
    return err({ code: 'bridge_error', detail: 'tenant_settings_missing' });
  }

  return await deps.paymentsRepo.withTx(async (tx) => {
    const payment = await deps.paymentsRepo.lockForUpdateByPaymentIntentId(
      tx,
      input.paymentIntentId,
    );
    if (!payment) {
      // Audit 2026-04-26 round-2 #5b: atomic markProcessed even for
      // unknown_intent so the dispatch tail short-circuits.
      if (deps.processorEventsRepo && input.processorEventId) {
        await deps.processorEventsRepo.markProcessed(tx, input.processorEventId);
      }
      return ok<ConfirmPaymentOutcome>({ kind: 'unknown_intent' });
    }

    // Step 2 — invoice payability
    const invoiceResult = await deps.invoicingBridge.getInvoiceForPayment({
      tenantId: input.tenantId,
      invoiceId: payment.invoiceId,
    });
    if (!invoiceResult.ok) {
      if (invoiceResult.error.code === 'not_found') {
        return err<ConfirmPaymentError>({ code: 'invoice_not_found' });
      }
      // forbidden won't happen webhook-side (no actor); not_payable →
      // handled by stale-invoice branch below (we re-derive via status).
    }

    // Step 3 — stale invoice auto-refund.
    // `not_payable` from the bridge OR a status outside {issued, overdue}
    // lands in this branch. For `not_payable`, we still need the status
    // to record cause; for the happy path we continue to step 4.
    // Architect D-04 (Group D review, 2026-04-24): narrow via the
    // discriminated union instead of an unsafe `as { status?: string }`
    // cast. `not_payable` is the only error variant that carries a
    // status; forbidden/not_found don't, and we never enter step 3 via
    // those paths (step 2 returns early).
    const invoiceStatus = invoiceResult.ok
      ? invoiceResult.value.status
      : invoiceResult.error.code === 'not_payable'
        ? invoiceResult.error.status
        : undefined;
    // F4 models "overdue" as a derived state (issue_date + due_date
    // computation, see src/modules/invoicing/application/use-cases/
    // derive-overdue.ts) — not a distinct InvoiceStatus enum value.
    // An overdue invoice carries `status='issued'`, so this single
    // check covers both {issued, overdue} from contracts/payments-api.md.
    const inPayableStatus = invoiceStatus === 'issued';

    if (!inPayableStatus) {
      // Exhaustive switch with `never` arm so a future addition to
      // InvoiceStatus (F4) fails the build here instead of silently
      // routing through the `invoice_credited` catch-all bucket
      // (audit 2026-04-25 finding #6). The InvoiceStatus enum uses
      // `'void'` (not `'voided'`); the `invoice_credited` bucket
      // covers both `'credited'` and `'partially_credited'` since
      // both terminate the payable window.
      const cause: 'invoice_already_paid' | 'invoice_voided' | 'invoice_credited' | 'invoice_unknown_status' = (() => {
        // `invoiceStatus === undefined` only when the bridge returned
        // a forbidden/not_found path that already short-circuited
        // step 2 — defensive only.
        if (invoiceStatus === undefined) return 'invoice_unknown_status';
        // `'issued'` is excluded by the `inPayableStatus` gate above
        // → TS narrows `invoiceStatus` to the remaining InvoiceStatus
        // values (`'draft' | 'paid' | 'void' | 'credited' | 'partially_credited'`).
        switch (invoiceStatus) {
          case 'paid':
            return 'invoice_already_paid';
          case 'void':
            return 'invoice_voided';
          case 'credited':
          case 'partially_credited':
            return 'invoice_credited';
          case 'draft':
            // `'draft'` should never reach here — drafts never carry an
            // active PaymentIntent — but defensive in case the bridge
            // shape evolves.
            return 'invoice_unknown_status';
          default: {
            // Compile-time exhaustiveness trap. If F4 adds a new
            // InvoiceStatus value, this arm fails to compile and forces
            // the new branch to be added explicitly above (audit
            // 2026-04-25 finding #6).
            const _exhaustive: never = invoiceStatus;
            void _exhaustive;
            return 'invoice_unknown_status';
          }
        }
      })();

      const refund = await deps.processorGateway.createRefund({
        paymentIntentId: input.paymentIntentId,
        metadata: {
          invoiceId: payment.invoiceId,
          tenantId: input.tenantId,
          paymentId: payment.id,
          cause,
        },
        idempotencyKey: `auto-refund-${payment.id}`,
        stripeAccount: settings.processorAccountId,
      });
      if (!refund.ok) {
        return err<ConfirmPaymentError>({
          code: 'processor_unavailable',
          reason: refund.error.kind,
        });
      }

      await deps.audit.emit(tx, {
        tenantId: input.tenantId,
        requestId: input.requestId,
        eventType: 'payment_auto_refunded_stale_invoice',
        actorUserId: SYSTEM_ACTOR_STRIPE_WEBHOOK,
        summary: `Auto-refunded payment ${payment.id} — invoice not payable (${invoiceStatus ?? 'unknown'})`,
        payload: {
          payment_id: payment.id,
          invoice_id: payment.invoiceId,
          refunded_amount_satang: payment.amountSatang.toString(),
          cause,
          // Include processor refund id so ops can correlate this
          // audit row with the Stripe dashboard refund record
          // (audit 2026-04-25 finding #7).
          processor_refund_id: refund.value.id,
        },
        retentionYears: 10,
      });
      // Audit 2026-04-26 round-2 #5b: atomic markProcessed.
      if (deps.processorEventsRepo && input.processorEventId) {
        await deps.processorEventsRepo.markProcessed(tx, input.processorEventId);
      }
      return ok<ConfirmPaymentOutcome>({ kind: 'auto_refunded_stale_invoice' });
    }

    // Step 4 — transition check.
    const transition = canTransition(payment.status, 'succeeded');
    if (!transition.ok) {
      // Terminal state = Stripe retry of an already-advanced row. Return
      // no-op ok (reliability F-01 — DO NOT return err or route 5xx-s
      // back at Stripe triggering a retry storm).
      if (transition.error.kind === 'terminal_state') {
        // Atomic markProcessed (audit 2026-04-26 round-2 #5b).
        if (deps.processorEventsRepo && input.processorEventId) {
          await deps.processorEventsRepo.markProcessed(
            tx,
            input.processorEventId,
          );
        }
        return ok<ConfirmPaymentOutcome>({ kind: 'already_succeeded' });
      }
      // illegal_transition (e.g. pending → succeeded mismatch is
      // impossible; but partially_refunded → succeeded is illegal).
      return err<ConfirmPaymentError>({
        code: 'illegal_transition',
        from: payment.status,
      });
    }

    // Step 5 — 1-succeeded-per-invoice invariant.
    const siblings = await deps.paymentsRepo.listSiblingStatusesForInvariant(
      tx,
      input.tenantId,
      payment.invoiceId,
      payment.id,
    );
    const invariant = enforceOneSucceededPerInvoice(siblings);
    if (!invariant.ok) {
      return err<ConfirmPaymentError>({
        code: 'invariant_violation_duplicate_succeeded',
      });
    }

    // Step 6 — re-fetch PI for card metadata (PCI SAQ-A: card last4/brand
    // enters the trust boundary through this single call; never read
    // from webhook event payload per stripe-webhook.md).
    const retrieved = await deps.processorGateway.retrievePaymentIntent(
      input.paymentIntentId,
      settings.processorAccountId,
    );
    if (!retrieved.ok) {
      return err<ConfirmPaymentError>({
        code: 'processor_unavailable',
        reason: retrieved.error.kind,
      });
    }
    const intent = retrieved.value;

    const completedAt = new Date(input.eventCreatedAtUnixSeconds * 1000);

    // Step 7 — persist.
    await deps.paymentsRepo.updateStatus(tx, {
      paymentId: payment.id,
      tenantId: input.tenantId,
      nextStatus: 'succeeded',
      processorChargeId: intent.latestChargeId,
      card: intent.card,
      completedAt,
    });

    // Step 8 — audit.
    await deps.audit.emit(tx, {
      tenantId: input.tenantId,
      requestId: input.requestId,
      eventType: 'payment_succeeded',
      actorUserId: SYSTEM_ACTOR_STRIPE_WEBHOOK,
      summary: `Payment ${payment.id} succeeded via ${payment.method}`,
      payload: {
        payment_id: payment.id,
        invoice_id: payment.invoiceId,
        method: payment.method,
        amount_satang: payment.amountSatang.toString(),
        processor_charge_id: intent.latestChargeId,
        completed_at: completedAt.toISOString(),
        ...(intent.card
          ? { card_brand: intent.card.brand, card_last4: intent.card.last4 }
          : {}),
      },
      retentionYears: 5,
    });

    // Step 9 — F4 bridge: invoice → paid.
    //
    // Reliability D-03 (Group E1, 2026-04-24): pass the current tx so
    // F4's `markPaidFromProcessor` runs inside the SAME Postgres
    // transaction as the payment-row status flip. If F4 rolls back,
    // the payments row rolls back with it — SC-013 invariant holds
    // (no succeeded-payment-without-paid-invoice). The E2 adapter
    // uses this tx to share the Drizzle connection with F4.
    // Settlement date in Asia/Bangkok wall-clock — NOT UTC. The previous
    // UTC slice was off-by-one for payments confirmed 17:00–24:00 UTC
    // (= 00:00–07:00 next-day Bangkok), which would group those rows
    // into the wrong daily settlement bucket on tax-receipt reports
    // (audit 2026-04-25 finding #8). InvoicingBridgePort.markPaidFrom
    // Processor.settlementDate is contractually `YYYY-MM-DD Asia/Bangkok`.
    const settlementDate = bangkokLocalDate(completedAt.toISOString());
    const bridgeResult = await deps.invoicingBridge.markPaidFromProcessor(
      {
        tenantId: input.tenantId,
        invoiceId: payment.invoiceId,
        requestId: input.requestId,
        actorUserId: SYSTEM_ACTOR_STRIPE_WEBHOOK,
        method: payment.method === 'card' ? 'stripe_card' : 'stripe_promptpay',
        paymentIntentId: input.paymentIntentId,
        chargeId: intent.latestChargeId,
        settlementDate,
      },
      tx,
    );
    if (!bridgeResult.ok) {
      return err<ConfirmPaymentError>({
        code: 'bridge_error',
        detail: bridgeResult.error.code,
      });
    }

    // Audit 2026-04-25 finding #4: fold markProcessed into THIS dispatch
    // tx so the processor_events row's `processed_at` flip commits
    // atomically with the payment + invoice + audit writes. Eliminates
    // the prior split-tx window where markProcessed could fail in a
    // separate tx and leave the row with `outcome='processed'` but
    // `processed_at=NULL`. Only runs when the parent (processWebhook
    // Event) supplied both deps + input.
    if (deps.processorEventsRepo && input.processorEventId) {
      await deps.processorEventsRepo.markProcessed(tx, input.processorEventId);
    }

    return ok<ConfirmPaymentOutcome>({ kind: 'processed' });
  });
}
