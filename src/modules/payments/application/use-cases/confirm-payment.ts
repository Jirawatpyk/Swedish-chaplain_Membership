/**
 * confirmPayment use-case (F5 / stripe-webhook.md § 4.1).
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
import type { Payment } from '../../domain/payment';
import { canTransition } from '../../domain/policies/payment-status-transitions';
import { enforceOneSucceededPerInvoice } from '../../domain/invariants/one-succeeded-payment-per-invoice';
import { SYSTEM_ACTOR_STRIPE_WEBHOOK } from '../../domain/system-actors';
import { retentionFor } from '../ports/audit-port';
import { markProcessedIfPresent, emitTerminalStateAck } from './_shared';
import { bangkokLocalDate } from '@/lib/fiscal-year';
import { paymentsMetrics } from '@/lib/metrics';
import { paymentsTracer } from '@/lib/otel-tracer';
import { SpanStatusCode } from '@opentelemetry/api';

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
   * inside the same dispatch tx — eliminates the split-tx window.
   * Required from production dispatch path; optional only for unit
   * tests that exercise the use-case in isolation.
   */
  readonly processorEventId?: string;
}

/**
 * R5 canonical fix (2026-04-25): expose `invoiceId` on outcome kinds
 * derived from a known payment row so the webhook route can fire
 * surgical `revalidatePath('/portal/invoices/<id>')` instead of the
 * broad `[invoiceId]` pattern. `unknown_intent` does not carry the id
 * (no payment row found for this PI), so it stays out of the union
 * variant.
 */
export type ConfirmPaymentOutcome =
  | { readonly kind: 'processed'; readonly invoiceId: string }
  | { readonly kind: 'already_succeeded'; readonly invoiceId: string }
  | { readonly kind: 'unknown_intent' }
  /**
   * F5R1-E9 — Stripe-side auto-refund call failed AND the Stripe
   * webhook event has aged past the give-up threshold. Phase A
   * already committed the payment row + emitted Phase A audit; we
   * acknowledge the webhook to break Stripe's 72h retry storm,
   * emitting an `out_of_band_refund_detected` forensic audit with
   * `cause = auto_refund_giving_up` so the runbook picks up manual
   * reconciliation. Customer's payment remains `succeeded` with no
   * refund — operator must reconcile via Stripe Dashboard.
   */
  | {
      readonly kind: 'auto_refund_given_up';
      readonly paymentId: string;
      readonly invoiceId: string;
    }
  | {
      readonly kind: 'auto_refunded_stale_invoice';
      readonly invoiceId: string;
    }
  | { readonly kind: 'invoice_not_found'; readonly invoiceId: string };

// review-20260428-102639.md S7 closure — `invoice_not_found` removed
// from this union: code path emits `ok({kind:'invoice_not_found'})`,
// not `err`. The dead variant misled exhaustive-switch tests.
export type ConfirmPaymentError =
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
   * + markProcessed commit atomically.
   */
  readonly processorEventsRepo?: ProcessorEventsRepo;
  /**
   * Optional structured logger. When wired, Phase B catch on the
   * stale-refund path emits a `confirm_payment.stale_refund_phase_b_mark_failed`
   * warn so ops has a forensic trail before Stripe retries.
   * review-20260428-102639.md H2 closure.
   */
  /**
   * F8 cross-module on-paid hooks. Composition root injects
   * `f8OnPaidCallbacks(tenantId)` when `FEATURE_F8_RENEWALS=true` so
   * the F8 renewal-cycle transition lands inside the same atomic tx
   * as the F4 invoice `issued → paid` flip.
   */
  readonly onPaidCallbacks?: ReadonlyArray<
    (
      evt: import('@/modules/invoicing').F4InvoicePaidEvent,
      tx?: unknown,
    ) => Promise<void>
  >;
  readonly logger?: {
    warn: (msg: string, ctx: Record<string, unknown>) => void;
  };
}

export async function confirmPayment(
  deps: ConfirmPaymentDeps,
  input: ConfirmPaymentInput,
): Promise<Result<ConfirmPaymentOutcome, ConfirmPaymentError>> {
  // T140 OTel span: webhook → f4_markpaid hop. Wraps the entire
  // confirmPayment lifecycle (incl. retrievePaymentIntent + invoicing
  // bridge call) so traces clearly show settlement-side latency.
  return await paymentsTracer().startActiveSpan(
    'payments.confirm',
    {
      attributes: {
        'payments.payment_intent_id': input.paymentIntentId,
        'payments.tenant_id': input.tenantId,
        /* v8 ignore next 3 — tracer attribute conditional spread; the
         * absent-processorEventId branch is dispatcher-only. */
        ...(input.processorEventId !== undefined
          ? { 'payments.processor_event_id': input.processorEventId }
          : {}),
      },
    },
    async (span) => {
      try {
        const result = await confirmPaymentBody(deps, input);
        if (result.ok) {
          span.setAttribute('payments.outcome', result.value.kind);
        } else {
          span.setAttribute('payments.outcome', `err:${result.error.code}`);
        }
        return result;
        /* v8 ignore start — tracer error-status path; confirmPaymentBody
         * always returns Result<...> instead of throwing. Catch is
         * defence-in-depth for unexpected runtime exceptions (OOM,
         * tracer-internal throw) that bypass the typed Result contract. */
      } catch (e) {
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: e instanceof Error ? e.message : 'confirm_threw',
        });
        throw e;
        /* v8 ignore stop */
      } finally {
        span.end();
      }
    },
  );
}

/**
 * R2 H-3 (2026-04-27): two-phase split for the stale-invoice auto-refund
 * branch. The withTx Phase A locks the payment row + reads the invoice +
 * decides whether the stale-refund path applies — but defers the Stripe
 * `createRefund` (10s SDK timeout) to OUTSIDE the lock window. Phase B
 * (a short follow-up withTx) commits markProcessed after Stripe returns.
 * Idempotency:
 *   - Stripe idempotencyKey `auto-refund-${paymentId}` returns the same
 *     refund on retry (Stripe handles replay safety internally).
 *   - `markProcessedIfPresent` is a no-op when the processor_events row
 *     is already marked, so a Stripe webhook retry that arrives mid-flight
 *     finds the event already processed and short-circuits at step 1.
 *   - The audit emit uses `null` tx (independent commit) — survives a
 *     Phase-B rollback, gives ops a forensic trail even on a partial
 *     failure.
 */
interface StalePending {
  readonly payment: Payment;
  readonly cause: 'invoice_already_paid' | 'invoice_voided' | 'invoice_credited' | 'invoice_unknown_status';
  readonly invoiceStatus: string | undefined;
}

async function confirmPaymentBody(
  deps: ConfirmPaymentDeps,
  input: ConfirmPaymentInput,
): Promise<Result<ConfirmPaymentOutcome, ConfirmPaymentError>> {
  const settings = await deps.tenantSettingsRepo.getByTenantId(input.tenantId);
  if (!settings) {
    // Pre-resolution tenant miss is handled at the route; if we're here
    // without settings, log via caller's warn path.
    return err({ code: 'bridge_error', detail: 'tenant_settings_missing' });
  }

  // R2 H-3 — captured by closure inside withTx; if Phase A determines
  // the stale-refund path applies, set this ref + return ok-stale-pending
  // sentinel so the surrounding code runs Stripe + Phase B OUTSIDE the
  // tx.
  let stalePending: StalePending | null = null;

  const phaseA = await deps.paymentsRepo.withTx(async (tx) => {
    // R4 polish (M1): the `markProcessedIfPresent(deps, input, tx)` triple
    // appears 6× below. Local closure removes the repetition without
    // hiding the contract — `_shared.markProcessedIfPresent` is still
    // the canonical no-op-when-absent helper.
    const markProcessed = () => markProcessedIfPresent(deps, input, tx);

    const payment = await deps.paymentsRepo.lockForUpdateByPaymentIntentId(
      tx,
      input.paymentIntentId,
      input.tenantId,
    );
    if (!payment) {
      // Audit 2026-04-26 round-2 #5b: atomic markProcessed even for
      // unknown_intent so the dispatch tail short-circuits.
      await markProcessed();
      return ok<ConfirmPaymentOutcome>({ kind: 'unknown_intent' });
    }

    // Step 2 — invoice payability
    const invoiceResult = await deps.invoicingBridge.getInvoiceForPayment({
      tenantId: input.tenantId,
      invoiceId: payment.invoiceId,
    });
    if (!invoiceResult.ok) {
      if (invoiceResult.error.code === 'not_found') {
        // Atomic markProcessed so the processor_events row does not get
        // stuck pending across Stripe retries. Mirrors the
        // `unknown_intent` short-circuit at line 109. Returning ok(...)
        // (not err) prevents the route from 5xx-ing and triggering a
        // retry storm on a permanently-unrecoverable mismatch.
        await markProcessed();
        // S5 (migration 0048): forensic audit row so ops see Stripe
        // webhooks arriving for invoices the local DB does not have.
        // Atomic with markProcessed inside this withTx — if the audit
        // emit throws, both roll back together and Stripe retries.
        await deps.audit.emit(tx, {
          tenantId: input.tenantId,
          requestId: input.requestId,
          eventType: 'payment_invoice_not_found',
          actorUserId: SYSTEM_ACTOR_STRIPE_WEBHOOK,
          summary: `Webhook arrived for unknown invoice ${payment.invoiceId} (PI ${input.paymentIntentId})`,
          payload: {
            payment_intent_id: input.paymentIntentId,
            payment_id: payment.id,
            invoice_id: payment.invoiceId,
          },
          retentionYears: retentionFor('payment_invoice_not_found'),
        });
        return ok<ConfirmPaymentOutcome>({
          kind: 'invoice_not_found',
          invoiceId: payment.invoiceId,
        });
      }
      // F5R1-E3 — explicit `forbidden` early-return.
      // Pre-fix the comment said "forbidden won't happen webhook-side"
      // and control fell through to the stale-refund branch where
      // `invoiceStatus` resolved to `undefined` → auto-refund fired
      // on a payment whose invoice we should not even know about.
      // If F4 ever surfaces `forbidden` to a webhook-side caller (e.g.
      // future F11 SaaS multi-tenant Connect events resolving an actor
      // role into bridge calls), the fall-through would trigger an
      // unrequested customer refund. Belt-and-suspenders: ack the
      // webhook + log forensic, never auto-refund on a forbidden read.
      if (invoiceResult.error.code === 'forbidden') {
        await deps.audit.emit(null, {
          tenantId: input.tenantId,
          requestId: input.requestId,
          eventType: 'payment_invoice_not_found',
          actorUserId: SYSTEM_ACTOR_STRIPE_WEBHOOK,
          summary: `Webhook arrived for invoice ${payment.invoiceId} that F4 refused (forbidden) — unexpected on webhook side; PI ${input.paymentIntentId}`,
          payload: {
            payment_intent_id: input.paymentIntentId,
            payment_id: payment.id,
            invoice_id: payment.invoiceId,
          },
          retentionYears: retentionFor('payment_invoice_not_found'),
        });
        return ok<ConfirmPaymentOutcome>({
          kind: 'invoice_not_found',
          invoiceId: payment.invoiceId,
        });
      }
      // not_payable → handled by stale-invoice branch below (we
      // re-derive via status).
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
    // Defensive resolver — `forbidden` and `not_found` were already
    // short-circuited at step 2, so the only remaining error variant
    // here is `not_payable` (carries `status`). The `=== 'not_payable'`
    // false branch and the trailing `: undefined` arm are unreachable
    // through normal webhook input → both are v8-ignored.
    const invoiceStatus = invoiceResult.ok
      ? invoiceResult.value.status
      /* v8 ignore next 3 -- defensive ternary: forbidden/not_found returned at step 2; only not_payable carries `status` */
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
      //. The InvoiceStatus enum uses
      // `'void'` (not `'voided'`); the `invoice_credited` bucket
      // covers both `'credited'` and `'partially_credited'` since
      // both terminate the payable window.
      const cause: 'invoice_already_paid' | 'invoice_voided' | 'invoice_credited' | 'invoice_unknown_status' = (() => {
        // `invoiceStatus === undefined` only when the bridge returned
        // a forbidden/not_found path that already short-circuited
        // step 2 — defensive only (paired with the v8-ignored
        // `: undefined` ternary arm above).
        /* v8 ignore next -- defensive: paired with the unreachable `: undefined` arm at line ~164 */
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
          /* v8 ignore start -- defensive: drafts never carry an active PaymentIntent (F4 invariant) */
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
          /* v8 ignore stop */
        }
      })();

      // R2 H-3 (2026-04-27): defer Stripe createRefund to OUTSIDE the
      // withTx. Capture the decision in `stalePending` and return a
      // sentinel ok-result; the surrounding code reads `stalePending`,
      // calls Stripe (idempotency-key safe; no lock held), emits audit
      // (null tx — independent commit), and runs Phase B for
      // markProcessed. This keeps the row-FOR UPDATE lock window to
      // local DB roundtrips only, eliminating the up-to-10s contention
      // window against concurrent cancelPayment / 2nd webhook delivery.
      stalePending = { payment, cause, invoiceStatus };
      // Sentinel return — the kind matches what we'll ultimately
      // return after Phase B; downstream branches at `if (phaseA.ok)`
      // ignore this when stalePending is non-null.
      return ok<ConfirmPaymentOutcome>({
        kind: 'auto_refunded_stale_invoice',
        invoiceId: payment.invoiceId,
      });
    }

    // Step 4 — transition check.
    const transition = canTransition(payment.status, 'succeeded');
    if (!transition.ok) {
      // Terminal state = Stripe retry of an already-advanced row. Return
      // no-op ok (reliability F-01 — DO NOT return err or route 5xx-s
      // back at Stripe triggering a retry storm).
      if (transition.error.kind === 'terminal_state') {
        // Atomic markProcessed (audit 2026-04-26 round-2 #5b).
        await markProcessed();
        return ok<ConfirmPaymentOutcome>({
          kind: 'already_succeeded',
          invoiceId: payment.invoiceId,
        });
      }
      // illegal_transition (e.g. partially_refunded → succeeded). R4 I-3:
      // webhook-side this is a PERMANENT mismatch — returning err would
      // bubble to a 500 → Stripe retries 24h → row stays stuck for the
      // entire retry window. Acknowledge atomically: markProcessed +
      // emit forensic audit (H-11 dedicated event type) + return
      // `already_succeeded` no-op so Stripe sees 200 and stops retrying.
      await markProcessed();
      await emitTerminalStateAck(deps.audit, {
        tenantId: input.tenantId,
        requestId: input.requestId,
        useCaseLabel: 'confirmPayment',
        paymentIntentId: input.paymentIntentId,
        paymentId: payment.id,
        fromStatus: payment.status,
        toStatus: 'succeeded',
        mismatchKind: 'illegal_transition',
      });
      return ok<ConfirmPaymentOutcome>({
        kind: 'already_succeeded',
        invoiceId: payment.invoiceId,
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
      // H-3 (review 2026-04-27): mirror the illegal_transition ack
      // pattern above — invariant violation is a PERMANENT state
      // (duplicate succeeded row already exists). Returning err would
      // 5xx the webhook → Stripe retries for 72h with no recovery
      // path. Acknowledge atomically + forensic audit (H-11 dedicated
      // event type) + return already_succeeded so Stripe sees 200.
      await markProcessed();
      await emitTerminalStateAck(deps.audit, {
        tenantId: input.tenantId,
        requestId: input.requestId,
        useCaseLabel: 'confirmPayment',
        paymentIntentId: input.paymentIntentId,
        paymentId: payment.id,
        fromStatus: payment.status,
        toStatus: 'succeeded',
        mismatchKind: 'invariant_violation_duplicate_succeeded',
        extraPayload: { invoice_id: payment.invoiceId },
      });
      return ok<ConfirmPaymentOutcome>({
        kind: 'already_succeeded',
        invoiceId: payment.invoiceId,
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
      // Audit row for mid-webhook Stripe outages on retrievePaymentIntent
      // (migration 0047). Emitted on `null` (best-effort, separate tx)
      // because the function is about to `return err(...)` and the outer
      // `withTx` will roll back — emitting through `tx` would discard the
      // forensic row we want ops to see. Stripe retries the webhook on
      // its own schedule; the gateway adapter also pino-warns via
      // `mapStripeError` at the boundary.
      await deps.audit.emit(null, {
        tenantId: input.tenantId,
        requestId: input.requestId,
        eventType: 'payment_processor_retrieve_failed',
        actorUserId: SYSTEM_ACTOR_STRIPE_WEBHOOK,
        summary: `retrievePaymentIntent failed during confirm of ${input.paymentIntentId}`,
        payload: {
          payment_intent_id: input.paymentIntentId,
          payment_id: payment.id,
          processor_error_kind: retrieved.error.kind,
        },
        retentionYears: retentionFor('payment_processor_retrieve_failed'),
      });
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
      retentionYears: retentionFor('payment_succeeded'),
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
    //. InvoicingBridgePort.markPaidFrom
    // Processor.settlementDate is contractually `YYYY-MM-DD Asia/Bangkok`.
    const settlementDate = bangkokLocalDate(completedAt.toISOString());
    // Staff-review R2 R010 (2026-04-28): emit the trace's terminal
    // `receipt_email_enqueued` hop as a named child span. F4's
    // `markPaidFromProcessor` is the call that transitively enqueues the
    // outbox row — wrapping it gives ops a measurable timing for the
    // final hop of `portal_click → ... → f4_markpaid → receipt_email_enqueued`.
    const bridgeResult = await paymentsTracer().startActiveSpan(
      'receipt_email_enqueued',
      {
        attributes: {
          'payments.tenant_id': input.tenantId,
          'payments.payment_intent_id': input.paymentIntentId,
          'payments.suppress_receipt_email': !settings.autoEmailOnPayment,
        },
      },
      async (childSpan) => {
        try {
          return await deps.invoicingBridge.markPaidFromProcessor(
            {
              tenantId: input.tenantId,
              invoiceId: payment.invoiceId,
              requestId: input.requestId,
              actorUserId: SYSTEM_ACTOR_STRIPE_WEBHOOK,
              method: payment.method === 'card' ? 'stripe_card' : 'stripe_promptpay',
              paymentIntentId: input.paymentIntentId,
              chargeId: intent.latestChargeId,
              settlementDate,
              // T128a: tenant override of receipt-on-payment auto-email.
              // Default-on (column DEFAULT true). When the admin disables
              // it, F4 still flips the invoice + writes audit + renders
              // PDF — only the dispatcher enqueue is skipped. See spec.md
              // § US3 auto-email toggle + FR-015 ("MAY suppress").
              // M-3 (review 2026-04-27): replaced hardcoded line number
              // with section reference so the comment doesn't rot when the
              // spec is reformatted.
              suppressReceiptEmail: !settings.autoEmailOnPayment,
              // F8: forward cross-module on-paid callbacks (renewal-cycle
              // transition) into F4's atomic tx. `undefined` when the
              // feature flag is off → behaviour unchanged for non-F8 tenants.
              /* v8 ignore next 3 — F8 callback conditional spread; the
               * absent-callbacks branch is exercised by F4-only tests. */
              ...(deps.onPaidCallbacks !== undefined
                ? { onPaidCallbacks: deps.onPaidCallbacks }
                : {}),
            },
            tx,
          );
        } finally {
          childSpan.end();
        }
      },
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
    await markProcessed();

    // T141 metric: settlement throughput (RED — Rate / Errors / Duration).
    // Powers SLO-F5-005 success-rate denominator + dashboard top-row gauge.
    paymentsMetrics.succeededCount(input.tenantId, payment.method);

    return ok<ConfirmPaymentOutcome>({
      kind: 'processed',
      invoiceId: payment.invoiceId,
    });
  });

  // R2 H-3 — Phase B: stale-invoice auto-refund. Runs OUTSIDE the
  // Phase-A withTx so the Stripe call (10s SDK timeout) does not hold
  // the payment-row FOR UPDATE lock. Idempotency: Stripe's
  // `auto-refund-${paymentId}` key returns the same refund on retry;
  // `markProcessedIfPresent` is idempotent (no-op when row already
  // processed); audit emit on `null` tx commits independently so a
  // Phase-B rollback still leaves a forensic trail.
  // TS narrows the captured-let to `never` after the closure (it cannot
  // prove the assignment ran), so re-bind through an unknown cast.
  const stalePendingFinal = stalePending as StalePending | null;
  if (stalePendingFinal !== null) {
    const { payment, cause, invoiceStatus } = stalePendingFinal;
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
      // F5R1-E9 — bound the Stripe-retry storm. The default 500
      // (processor_unavailable) tells Stripe to retry; Stripe retries
      // for up to 72h. If the event itself is already aged past 48h,
      // we are in an extended outage / permanent failure window —
      // continuing to retry pollutes audit-log + SRE alerts.
      // Emit a give-up audit + 200-ack so Stripe drains the queue.
      // Customer's payment row stays succeeded (Phase A took the
      // lock and decided stale); operator must reconcile via Stripe
      // Dashboard per docs/runbooks/out-of-band-refund.md.
      const nowSeconds = Math.floor(deps.clock.nowMs() / 1000);
      const eventAgeSeconds = nowSeconds - input.eventCreatedAtUnixSeconds;
      const STALE_REFUND_GIVE_UP_SECONDS = 48 * 60 * 60;
      if (eventAgeSeconds > STALE_REFUND_GIVE_UP_SECONDS) {
        await deps.audit.emit(null, {
          tenantId: input.tenantId,
          requestId: input.requestId,
          eventType: 'out_of_band_refund_detected',
          actorUserId: SYSTEM_ACTOR_STRIPE_WEBHOOK,
          summary: `Auto-refund giving up after ${Math.floor(eventAgeSeconds / 3600)}h — Stripe refund call still failing on event ${input.processorEventId ?? 'unknown'} for payment ${payment.id}; admin must reconcile via Stripe Dashboard`,
          payload: {
            // Use the Stripe event id as the refund-side identifier
            // (no refund was actually created — Stripe call failed —
            // so there is no processor_refund_id; use the event id
            // for forensic correlation).
            processor_refund_id: input.processorEventId ?? `event-${payment.id}`,
            processor_charge_id: payment.processorPaymentIntentId,
            amount_satang: payment.amountSatang.toString(),
            runbook_url: 'docs/runbooks/out-of-band-refund.md',
          },
          retentionYears: retentionFor('out_of_band_refund_detected'),
        });
        // Audit row carries the forensic trail; processor_env not
        // available at this Application-layer boundary (would require
        // threading livemode through ConfirmPaymentInput). The grep-
        // able summary "Auto-refund giving up after Xh" suffices for
        // SRE alert rules pivoting on `eventType =
        // out_of_band_refund_detected AND summary LIKE 'Auto-refund
        // giving up%'`.
        // Phase B markProcessedIfPresent — best-effort, drains the
        // processor_events row so Stripe stops retrying.
        //
        // F5R2-SF-3 — bump a dedicated metric on Phase B failure so
        // SRE can alert on the stuck-row class (audit row commits
        // but processor_events.processed_at left NULL → Stripe sees
        // 200 (stops retrying) but DB says "never processed" → sweep
        // cron does NOT catch it). Pre-fix only the optional-
        // chained logger.warn fired; if deps.logger is undefined
        // (test path), the failure was completely silent.
        try {
          await deps.paymentsRepo.withTx(async (tx) => {
            await markProcessedIfPresent(deps, input, tx);
          });
        } catch (phaseBErr) {
          paymentsMetrics.confirmPaymentGiveUpPhaseBMarkProcessedFailed();
          deps.logger?.warn(
            'confirmPayment.give_up_phase_b_markProcessed_failed',
            {
              paymentId: payment.id,
              errKind:
                phaseBErr instanceof Error
                  ? phaseBErr.constructor.name
                  : 'unknown',
            },
          );
        }
        return ok<ConfirmPaymentOutcome>({
          kind: 'auto_refund_given_up',
          paymentId: payment.id,
          invoiceId: payment.invoiceId,
        });
      }
      return err<ConfirmPaymentError>({
        code: 'processor_unavailable',
        reason: refund.error.kind,
      });
    }

    // Audit on `null` tx — independent commit (R3 I-6 design).
    //
    // R3 H3-1 known operational artifact (2026-04-28): if the process
    // crashes BETWEEN this audit emit committing and Phase B's
    // markProcessed committing, the next Stripe webhook retry will
    // re-enter Phase A → find invoice still stale → call Stripe with
    // same idempotency key (`auto-refund-${payment.id}` — returns SAME
    // refund) → re-emit this audit. Result: TWO audit rows for one
    // logical refund, both with identical `processor_refund_id`.
    // Operational dedup: queries that aggregate refund forensics MUST
    // group by `payload->>'processor_refund_id'` (canonical dedup key).
    // The trade-off accepts duplicate audit rows in exchange for
    // forensic survival across Phase B rollback — no financial loss
    // because Stripe idempotency-key prevents double refund.
    //
    // R3 CRIT-A (2026-04-28): when cause is `invoice_already_paid`
    // (admin marked the invoice paid manually while a member's online
    // payment was in-flight), emit the dedicated
    // `payment_auto_refunded_concurrent_manual_mark` event type per
    // spec.md edge case. Other causes (void, credited, unknown) keep
    // the generic `payment_auto_refunded_stale_invoice` label so
    // audit-log queries can pivot on the specific scenario.
    const auditEventType =
      cause === 'invoice_already_paid'
        ? ('payment_auto_refunded_concurrent_manual_mark' as const)
        : ('payment_auto_refunded_stale_invoice' as const);
    await deps.audit.emit(null, {
      tenantId: input.tenantId,
      requestId: input.requestId,
      eventType: auditEventType,
      actorUserId: SYSTEM_ACTOR_STRIPE_WEBHOOK,
      /* v8 ignore next -- defensive nullish coalesce; invoiceStatus always defined on this path */
      summary: `Auto-refunded payment ${payment.id} — invoice not payable (${invoiceStatus ?? 'unknown'})`,
      payload: {
        payment_id: payment.id,
        invoice_id: payment.invoiceId,
        refunded_amount_satang: payment.amountSatang.toString(),
        cause,
        processor_refund_id: refund.value.id,
      },
      retentionYears: retentionFor(auditEventType),
    });

    // R3 H3-2 (2026-04-28): Phase B markProcessedIfPresent inside
    // try/catch — if it throws (DB outage), the next Stripe webhook
    // retry re-runs Phase A → finds invoice still stale → calls
    // Stripe with same idempotency key → returns the same refund →
    // audit emits a SECOND time → double-emission. We ALSO defensively
    // log the error so ops have a forensic trail; the sweep cron is
    // the recovery path.
    // F5R1-E15 — metric INSIDE the try block so a Phase B failure
    // does NOT bump it (and the Stripe retry that recovers Phase B
    // WILL bump it cleanly on the next attempt). Pre-fix the metric
    // was outside, so chronic mid-flight crashes over-counted the
    // auto-refund rate and triggered false-alert fatigue. Trade-off
    // accepted: under-count by 1 on Phase B failure (recovered next
    // retry) vs. over-count on every retry (false alarm).
    try {
      await deps.paymentsRepo.withTx(async (tx) => {
        await markProcessedIfPresent(deps, input, tx);
      });
      paymentsMetrics.autoRefundedStaleCount(input.tenantId);
      /* v8 ignore start — best-effort Phase B catch; rare DB-outage
       * race window. Recovery is automatic via Stripe retry idempotency
       * key. */
    } catch (phaseBErr) {
      // Best-effort log — known race window. Recovery is automatic
      // via Stripe retry idempotency. Structured-log so ops has a
      // forensic trail before the retry rather than silence.
      deps.logger?.warn('confirm_payment.stale_refund_phase_b_mark_failed', {
        tenantId: input.tenantId,
        paymentId: payment.id,
        errKind: phaseBErr instanceof Error ? phaseBErr.constructor.name : 'unknown',
        recovery: 'awaiting_stripe_retry_idempotency',
      });
      void phaseBErr;
    }
    /* v8 ignore stop */

    return ok<ConfirmPaymentOutcome>({
      kind: 'auto_refunded_stale_invoice',
      invoiceId: payment.invoiceId,
    });
  }

  return phaseA;
}
