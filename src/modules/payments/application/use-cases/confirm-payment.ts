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
 *        advanced. Return `already_succeeded` (no-op, NOT an error) —
 *        EXCEPT terminal `failed` + a genuine late-captured charge (A.15 /
 *        bug #8 resume-race): reconcile in Phase B — auto-refund the
 *        captured funds + forensic audit, leaving the row `failed` (F-9).
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
  GetInvoiceForPaymentBridgeError,
  InvoicingBridgePort,
  PaymentsRepo,
  ProcessorEventsRepo,
  ProcessorGatewayPort,
  TenantPaymentSettingsRepo,
} from '../ports';
import type { Payment } from '../../domain/payment';
import { canTransition } from '../../domain/policies/payment-status-transitions';
import type { TaxAtPaymentFlag } from '@/modules/invoicing';
import { enforceOneSucceededPerInvoice } from '../../domain/invariants/one-succeeded-payment-per-invoice';
import { SYSTEM_ACTOR_STRIPE_WEBHOOK } from '../../domain/system-actors';
import { retentionFor } from '../ports/audit-port';
import { markProcessedIfPresent, emitTerminalStateAck } from './_shared';
// money-remediation Task 2 primitives (Task 4 adopts them here). `withTx`
// commits whenever the callback returns, so `return err(...)` out of a
// settlement tx persists the writes it is refusing — finding F-1. These make
// the choice explicit: `commitTx` type-bans `Err`, so every exit below had to
// be decided rather than defaulted.
import {
  commitTx,
  commitTxWithRefusal,
  rollbackTx,
  runTxDecided,
} from '../settlement/tx-decision';
import { bangkokLocalDate } from '@/lib/fiscal-year';
// REMOVE-WITH-064-REMEDIATION — used ONLY by the legacy no-TIN money-
// captured ops log below (precedent: F4's record-payment.ts also imports
// the structured logger at the Application layer).
import { logger } from '@/lib/logger';
import { errKind } from '@/lib/log-id';
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
  | { readonly kind: 'invoice_not_found'; readonly invoiceId: string }
  /**
   * F5R3v3 H-1 (2026-05-16) — F4 bridge surfaced a malformed invoice
   * (currently: negative `totalSatang`). The webhook is acknowledged
   * to prevent Stripe retry storm; the customer's payment row stays
   * `succeeded` with the invoice still corrupt. Forensic audit fires
   * with the offending invoiceId so admin runbook can reconcile out
   * of band. Mirrors the `invoice_not_found` semantics — Stripe has
   * already charged the customer; our DB state is the broken side.
   */
  | { readonly kind: 'invoice_data_corrupt'; readonly invoiceId: string };

// review-20260428-102639.md S7 closure — `invoice_not_found` removed
// from this union: code path emits `ok({kind:'invoice_not_found'})`,
// not `err`. The dead variant misled exhaustive-switch tests.
//
// F5R3 H-7 (2026-05-16) — `illegal_transition` and
// `invariant_violation_duplicate_succeeded` ALSO removed for the same
// reason. R4 H-3 / R4 I-3 made both into ack paths returning
// `ok({kind:'already_succeeded'})` with the original literal preserved
// only on the `_shared.emitTerminalStateAck` audit payload's
// `mismatch_kind` field (string-literal union, unrelated to this Result
// error union). No `err({code:'illegal_transition'})` or
// `err({code:'invariant_violation_duplicate_succeeded'})` site exists
// anywhere in the codebase — keeping these variants here let future
// maintainers writing exhaustive-switch consumers add unreachable
// branches that look load-bearing.
export type ConfirmPaymentError =
  | { readonly code: 'processor_unavailable'; readonly reason: string }
  | { readonly code: 'bridge_error'; readonly detail: string }
  /**
   * I4 (Task 7 remediation) — the F4 payability READ threw (Neon down, tx
   * aborted, tenant-mismatch guard). TRANSIENT by construction.
   *
   * A DISTINCT code, not `bridge_error`, and the distinction is
   * money-critical: `'bridge_error'` is in `PERMANENT_SUB_USE_CASE_DETAILS`
   * and permanence is keyed on the sub-use-case CODE, so reusing it would 200
   * the webhook and stop Stripe retrying — leaving the invoice `issued`
   * forever with the customer's money captured. Keep this code OUT of that
   * set so it classifies transient → 500 → Stripe retries → recovery when the
   * read recovers.
   */
  | { readonly code: 'invoice_read_failed'; readonly detail: string };

export interface ConfirmPaymentDeps {
  readonly paymentsRepo: PaymentsRepo;
  readonly tenantSettingsRepo: TenantPaymentSettingsRepo;
  readonly processorGateway: ProcessorGatewayPort;
  readonly invoicingBridge: InvoicingBridgePort;
  readonly audit: AuditPort;
  readonly clock: ClockPort;
  /**
   * 088 SEC-MED — FEATURE_088_TAX_AT_PAYMENT (2-state flow flag), threaded so the
   * webhook payability read forwards the HONEST flag (no magic value). The read
   * sets `reconciliationPath: true`, so the F4 stranded-funds guard stays dormant
   * regardless of this flag — the write-side record-payment guard is what enforces
   * a flag rollback here. Wired from `env.features.f088TaxAtPayment` at
   * `makeConfirmPaymentDeps` / `makeProcessWebhookEventDeps`.
   */
  readonly taxAtPayment: TaxAtPaymentFlag;
  /**
   * money-remediation Task 4 / finding F-1 — `FEATURE_F5_SETTLEMENT_ABORT`.
   *
   * When `true`, a refusal from the F4 invoicing bridge ROLLS BACK the
   * Phase-A settlement transaction. When `false` (the default, and the
   * pre-remediation behaviour) the transaction COMMITS and the refusal is
   * returned alongside the writes it was refusing — the payment row left
   * `succeeded`, F4's `members.registration_fee_paid` flip, and any §87
   * receipt sequence number `allocateNext` consumed before the failure.
   *
   * Flagged because this is the settlement path for every card and PromptPay
   * payment in production; the prod cut-over is a Vercel env flip, not a
   * redeploy. Wired from `env.features.f5SettlementAbort` at
   * `makeConfirmPaymentDeps` / `makeProcessWebhookEventDeps`.
   */
  readonly settlementAbort: boolean;
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
          // F5R3 LOW (2026-05-16) — H-4 hygiene: span.message uses
          // class name only (never raw .message). OTel span status
          // exports to tracing dashboards that aggregate across the
          // org; `.message` can carry SQL params / Stripe endpoint URLs.
          message: e instanceof Error ? e.constructor.name : 'confirm_threw',
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
  readonly cause: StaleRefundCause;
  readonly invoiceStatus: string | undefined;
}

/**
 * A.15 (#8 resume-race) — Phase-A sentinel for the `failed → succeeded`
 * late-charge reconcile. Captured inside the withTx when the locked row is
 * terminal `failed` and a `payment_intent.succeeded` arrived; the external
 * `retrievePaymentIntent` + `createRefund` are deferred to Phase B (outside
 * the row lock), mirroring the A.13 stale-refund split. Only ONE of
 * `stalePending` / `lateChargePending` is ever non-null (the stale-invoice
 * check at Step 3 returns before the Step-4 transition check).
 */
interface LateChargePending {
  readonly payment: Payment;
}

/**
 * F5R3 SIMPLIFY-H5 (2026-05-16) — auto-refund cause derivation.
 *
 * Extracted from a 35-line inline IIFE (with v8-ignore overhead +
 * exhaustiveness trap) inside `confirmPaymentBody`. Pure function +
 * default-arm fallback gives the SAME safety with a fraction of the
 * noise: the helper covers every known F4 InvoiceStatus + the
 * undefined / 'draft' / unknown-future-status cases land in a single
 * `'invoice_unknown_status'` bucket. Future F4 additions that should
 * map to a NEW cause require updating this switch, but the silent
 * fallback prevents a runtime crash in the meantime.
 */
export type StaleRefundCause =
  | 'invoice_already_paid'
  | 'invoice_voided'
  | 'invoice_credited'
  | 'invoice_unknown_status';

/**
 * I4 (Task 7 remediation) — resolve the invoice status carried by a bridge
 * ERROR, exhaustively.
 *
 * This replaces a ternary chain that ended in `: undefined`, which was a
 * loaded gun. Step-2 above is an if-CHAIN, not a switch, so any bridge error
 * code it does not name falls through to here; `undefined` then makes
 * `inPayableStatus` false, `causeForInvoiceStatus(undefined)` hits its
 * `default:` arm, and the stale-invoice branch AUTO-REFUNDS a customer who
 * paid. Every future bridge error code inherited that behaviour silently, with
 * a green typecheck.
 *
 * The `never` arm makes the next added code a BUILD failure instead, exactly
 * as the `InvoiceStatus` switch further down already does for F4's enum.
 * Codes that legitimately resolve to `undefined` must say so HERE, by name.
 */
function invoiceStatusFromBridgeError(
  e: GetInvoiceForPaymentBridgeError,
): string | undefined {
  switch (e.code) {
    // Carries the status verbatim — the stale-invoice branch needs it to
    // record the refund cause.
    case 'not_payable':
      return e.status;
    // REMOVE-WITH-064-REMEDIATION — treated as payable so the flip proceeds
    // and the markPaid-side guard fails it loudly instead of silently
    // auto-refunding here.
    case 'legacy_no_tin_event_not_payable':
      return 'issued';
    // 088 SEC-MED — deliberately resolves to `undefined`, i.e. it DOES reach
    // the stale-invoice auto-refund. That is pre-existing behaviour and is
    // preserved byte-for-byte here rather than changed as a side effect of
    // this hardening; naming it makes the choice visible instead of implicit.
    // If it was never intended, that is a separate finding for whoever owns
    // 088 — do not "fix" it inside an unrelated change.
    case 'new_flow_bill_requires_flag_on':
      return undefined;
    // All returned early at step 2, so they are unreachable here. They must
    // still be named: `undefined` for them would mean auto-refund, and the
    // whole point of this switch is that no code reaches that outcome by
    // omission.
    case 'forbidden':
    case 'not_found':
    case 'corrupted_total':
      return undefined;
    // I4 — returned early at step 2 with a transient err. Never reaches here;
    // if it ever did, `undefined` would auto-refund on a read hiccup.
    case 'read_failed':
      return undefined;
    default: {
      const exhaustive: never = e;
      void exhaustive;
      return undefined;
    }
  }
}

export function causeForInvoiceStatus(
  invoiceStatus: string | undefined,
): StaleRefundCause {
  switch (invoiceStatus) {
    case 'paid':
      return 'invoice_already_paid';
    case 'void':
      return 'invoice_voided';
    case 'credited':
    case 'partially_credited':
      return 'invoice_credited';
    // 'draft' / undefined / any future InvoiceStatus addition →
    // unknown-status bucket. The use-case emits a forensic audit
    // either way; an unrecognised status doesn't change downstream
    // behaviour beyond the audit label.
    default:
      return 'invoice_unknown_status';
  }
}

/**
 * F-2 (money-remediation Task 3) — the money trail for an auto-refund whose
 * recording transaction died.
 *
 * ## Why this exists
 *
 * Both Phase-B blocks below run AFTER `createRefund` has moved real money.
 * The single transaction that records the movement writes the durable `re_…`
 * marker, the 10-year money-trail audit, and `markProcessed`. When that
 * transaction fails — a Neon connection drop is the realistic trigger — the
 * in-tx audit row rolls back with everything else. Before this helper the
 * catch bumped a counter and wrote a pino line, and pino rolls off in 30
 * days. So a real refund of real money existed with **no audit row at all**,
 * against a Thai RD §87/3 obligation to keep one for ten years.
 *
 * The `null` tx is what makes the record survive: `drizzle-payments-audit`
 * takes the auto-commit path for `null` and log-and-swallows its own
 * failures, so this write is not part of the transaction it is reporting on.
 *
 * The pattern is the codebase's own — `issue-refund.ts` emits exactly this
 * shape from the identical situation (its own Phase-B double-fault).
 *
 * ## Why `.catch()` is not optional
 *
 * The audit rail and the transaction that just failed are the same Neon
 * instance, so a co-occurring outage is likely rather than exotic. Letting
 * this throw would convert a swallowed 200 into a thrown 500 — a different
 * failure, not a fix. The adapter has already logged and bumped
 * `useCaseAuditEmitFailed` by the time we get here.
 *
 * ## Why `committed` is a parameter and not an assumption
 *
 * Reaching the `catch` does NOT prove the transaction failed: the metric
 * bumps sit inside the same `try` (deliberately — they must not fire on a
 * rolled-back tx). If one of those threw, the money trail is already
 * durably on disk and emitting here would write a SECOND 10-year row for
 * one refund, double-listing the task on the admin reconcile surface
 * (`findStaleInvoiceAutoRefund`) — rows that cannot simply be deleted.
 *
 * The OTel wrappers swallow internally, so this is defensive today rather
 * than load-bearing. It is keyed on the transaction outcome anyway, because
 * the alternative is being correct only by accident of what currently sits
 * inside the `try`.
 */
async function emitPhaseBSettlementForensic(
  deps: ConfirmPaymentDeps,
  args: {
    committed: boolean;
    tenantId: string;
    requestId: string | null;
    eventType:
      | 'payment_auto_refunded_stale_invoice'
      | 'payment_auto_refunded_concurrent_manual_mark';
    paymentId: string;
    invoiceId: string;
    amountSatang: bigint;
    cause: StaleRefundCause | 'payment_terminal_failed_late_charge';
    processorRefundId: string;
    refundStatus: string;
    errorKind: string;
  },
): Promise<void> {
  if (args.committed) return;
  await deps.audit
    .emit(null, {
      tenantId: args.tenantId,
      requestId: args.requestId,
      eventType: args.eventType,
      actorUserId: SYSTEM_ACTOR_STRIPE_WEBHOOK,
      summary: `Phase B failed after Stripe refunded payment ${args.paymentId} — refund ${args.processorRefundId} IS REAL and its transaction rolled back; the webhook was 200-acked so nothing retries. Manual reconciliation required.`,
      payload: {
        payment_id: args.paymentId,
        invoice_id: args.invoiceId,
        refunded_amount_satang: args.amountSatang.toString(),
        cause: args.cause,
        processor_refund_id: args.processorRefundId,
        refund_status: args.refundStatus,
        phase_b_error_kind: args.errorKind,
        recovery: 'manual_reconcile_via_runbook',
        runbook_url: 'docs/runbooks/out-of-band-refund.md',
      },
      retentionYears: retentionFor(args.eventType),
    })
    .catch(() => {
      // Triple-fault swallow — see the block comment above. The adapter's
      // `null`-tx branch already log-and-swallows and bumps its own
      // failure counter.
    });
}

/**
 * money-remediation Task 4 / finding F-1 — forensic row for a settlement
 * transaction that was UNWOUND because the F4 invoicing bridge declined.
 *
 * ## Why this cannot be emitted through `tx`
 *
 * It is describing the rollback of that very transaction. A tx-bound emit
 * would be unwound along with everything else, leaving no trace that a
 * captured payment failed to settle — the rollback would erase its own
 * evidence. `null` gets the adapter's own connection, which survives.
 *
 * That is the opposite of the reasoning at the `processor_unavailable` exit
 * above, where `null` was chosen under a mistaken belief that a returned
 * `err` rolled back. Here the rollback is real.
 *
 * ## Why the failure is swallowed
 *
 * The audit rail and the transaction that just failed are the same Neon
 * instance, so a co-occurring fault is likely rather than exotic. Letting
 * this throw would replace a clean `bridge_error` refusal with a thrown 500 —
 * a different failure, not a fix — and would ALSO lose the rollback, because
 * `runTxDecided` propagates genuine throws instead of honouring the decision.
 * The adapter has already logged and bumped `useCaseAuditEmitFailed`, and the
 * `payments.confirm.settlement_rolled_back` pino line below is the redundant
 * trail.
 *
 * ## What the payload deliberately says
 *
 * `money_captured: true`. The rollback undoes OUR writes; it does not reach
 * Stripe. An operator reading this row must not conclude the customer was
 * made whole — they were not, and reconciling that is the whole point of the
 * runbook this row points at.
 */
async function emitSettlementRollbackForensic(
  deps: ConfirmPaymentDeps,
  args: {
    tenantId: string;
    requestId: string | null;
    paymentId: string;
    invoiceId: string;
    paymentIntentId: string;
    amountSatang: bigint;
    bridgeErrorCode: string;
  },
): Promise<void> {
  await deps.audit
    .emit(null, {
      tenantId: args.tenantId,
      requestId: args.requestId,
      eventType: 'payment_settlement_rolled_back',
      actorUserId: SYSTEM_ACTOR_STRIPE_WEBHOOK,
      summary: `Settlement of payment ${args.paymentId} was ROLLED BACK — F4 declined with ${args.bridgeErrorCode}. Stripe has CAPTURED the money; the payment row is back to pending and invoice ${args.invoiceId} remains issued. Reconciliation required.`,
      payload: {
        payment_id: args.paymentId,
        invoice_id: args.invoiceId,
        payment_intent_id: args.paymentIntentId,
        amount_satang: args.amountSatang.toString(),
        bridge_error_code: args.bridgeErrorCode,
        money_captured: true,
        runbook_url:
          'docs/runbooks/event-invoice-legacy-no-tin-remediation.md',
      },
      retentionYears: retentionFor('payment_settlement_rolled_back'),
    })
    .catch(() => {
      // Triple-fault swallow — see the block comment above. The adapter's
      // `null`-tx branch already log-and-swallows and bumps its own failure
      // counter, and letting this escape would cost us the rollback itself.
    });
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

  // A.15 (#8) — captured by closure inside withTx when the locked row is
  // terminal `failed` and a genuine `payment_intent.succeeded` arrived; the
  // late-charge auto-refund (retrieve + createRefund + marker) runs in
  // Phase B OUTSIDE the tx (mirrors `stalePending`).
  let lateChargePending: LateChargePending | null = null;

  // money-remediation Task 4 — Phase A runs through `runTxDecided`, so each of
  // the twelve exits below is an explicit `commitTx` / `commitTxWithRefusal` /
  // `rollbackTx` decision rather than an ambiguous `return`. `phaseA` is a
  // `TxOutcome<Result<…>>`; its `.value` is the Result the caller sees and
  // `.committed` records what actually happened to the transaction.
  const phaseA = await runTxDecided<
    Result<ConfirmPaymentOutcome, ConfirmPaymentError>
  >(deps.paymentsRepo, async (tx) => {
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
      // Commit: `markProcessed` is the whole point of this branch — it stops
      // Stripe retrying a PI we have no row for.
      return commitTx(ok<ConfirmPaymentOutcome>({ kind: 'unknown_intent' }));
    }

    // Step 2 — invoice payability. Webhook / reconciliation read:
    // `reconciliationPath: true` keeps F4's new-flow-bill stranded-funds guard
    // DORMANT — a Stripe-captured payment is never refused at reconciliation just
    // because the flow flag rolled back (refusing would strand the funds; the
    // write-side record-payment guard is what enforces the flag). The honest flow
    // flag is still forwarded (no magic value) but the guard ignores it here.
    const invoiceResult = await deps.invoicingBridge.getInvoiceForPayment({
      tenantId: input.tenantId,
      invoiceId: payment.invoiceId,
      taxAtPayment: deps.taxAtPayment,
      reconciliationPath: true,
      // F-1 item 4 / Variant B (money-remediation Task 7) — thread THIS tx.
      // We are inside `paymentsRepo.withTx` holding `FOR UPDATE` on the
      // payment row; without this the adapter opens a SECOND `runInTenant`,
      // acquiring another pooled connection while the first is still held —
      // the self-deadlock shape that `getInvoiceCreditedTotal` (B.1 Fix#2) and
      // `getInvoiceStatus` already thread around. This was the last of the
      // three F4 reads still doing it.
      externalTx: tx,
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
        // Commit: the forensic audit row + `markProcessed` above are exactly
        // what must survive — this is a permanent, unrecoverable mismatch.
        return commitTx(
          ok<ConfirmPaymentOutcome>({
            kind: 'invoice_not_found',
            invoiceId: payment.invoiceId,
          }),
        );
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
        // F5R3 CR-4 (2026-05-16) — atomic markProcessed inside the
        // withTx (mirrors the not_found sibling at line ~262). The
        // pre-fix branch returned ok(invoice_not_found) WITHOUT
        // marking the processor_events row, leaving Stripe to retry
        // forever (recovery-replay path re-enters bridge → still
        // forbidden → still no markProcessed → 72h retry storm
        // class). Switch the audit emit to tx-bound (was null) so it
        // commits atomically with markProcessed. F4 forbidden is a
        // PERMANENT bridge state — Stripe retry has zero chance of
        // success.
        await deps.audit.emit(tx, {
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
        await markProcessed();
        // Commit: F4 `forbidden` is PERMANENT — the tx-bound forensic audit +
        // `markProcessed` must persist or Stripe retries for 72h.
        return commitTx(
          ok<ConfirmPaymentOutcome>({
            kind: 'invoice_not_found',
            invoiceId: payment.invoiceId,
          }),
        );
      }
      // F5R3v3 H-1 (2026-05-16) — bridge surfaced corrupted F4 invoice
      // money (negative totalSatang). Stripe already CHARGED the
      // customer; ack the webhook + audit forensic + markProcessed so
      // we don't retry forever. Customer's payment row stays succeeded
      // with the invoice corrupt — admin runbook reconciles out of
      // band (refund manually via Stripe Dashboard OR fix the invoice
      // row). Pre-fix (Batch 1) the bridge silently capped totalSatang
      // at 0n → control fell through to the stale-refund branch and
      // attempted an auto-refund using a fake-zero baseline; that
      // would either underrefund the customer or trip an arithmetic
      // edge in `computeRefundableAmount`.
      if (invoiceResult.error.code === 'corrupted_total') {
        await deps.audit.emit(tx, {
          tenantId: input.tenantId,
          requestId: input.requestId,
          eventType: 'payment_invoice_not_found',
          actorUserId: SYSTEM_ACTOR_STRIPE_WEBHOOK,
          summary: `Webhook arrived for invoice ${payment.invoiceId} that F4 bridge flagged as data-corrupt (negative totalSatang); PI ${input.paymentIntentId} — admin must reconcile out of band`,
          payload: {
            payment_intent_id: input.paymentIntentId,
            payment_id: payment.id,
            invoice_id: payment.invoiceId,
            bridge_outcome: 'corrupted_total',
          },
          retentionYears: retentionFor('payment_invoice_not_found'),
        });
        await markProcessed();
        // Commit: the corrupt-invoice forensic + ack must persist; the
        // customer is already charged and only an operator can fix the row.
        return commitTx(
          ok<ConfirmPaymentOutcome>({
            kind: 'invoice_data_corrupt',
            invoiceId: payment.invoiceId,
          }),
        );
      }
      // I4 (Task 7 remediation) — the F4 read THREW. MUST return early.
      //
      // NO `markProcessed()`, NO audit, NO auto-refund. Falling through would
      // be a customer-money bug, not a style issue: `read_failed` carries no
      // `status`, so the resolver below lands on its defensive arm,
      // `inPayableStatus` goes false, and the stale-invoice branch
      // AUTO-REFUNDS a customer who paid — because a database read hiccuped.
      // A test pins this (`createRefund` must not be called).
      //
      // Returning err is the whole point: the dispatcher classifies
      // `invoice_read_failed` as TRANSIENT (it is deliberately absent from
      // `PERMANENT_SUB_USE_CASE_DETAILS`), the route 500s, and Stripe retries
      // until the read recovers. Marking processed here would DROP a real
      // payment confirmation permanently, which is worse than a retry storm.
      //
      // Stack-assembly (task-4 F-1) — this exit sits INSIDE `runTxDecided`, so
      // it must be a decision, not a bare `return err(...)`. `rollbackTx` is the
      // canonical conversion (see tx-decision.ts: "return ok/err but I don't
      // want the writes kept because it's an error → rollbackTx"). Nothing was
      // written on this path anyway (no markProcessed, no audit), so the
      // rollback is a money-safe no-op that surfaces the transient err
      // unchanged. It is NOT a settlement abort — no forensic is owed here.
      if (invoiceResult.error.code === 'read_failed') {
        deps.logger?.warn('confirm_payment.invoice_read_failed', {
          tenantId: input.tenantId,
          paymentId: payment.id,
          invoiceId: payment.invoiceId,
          // Bounded discriminator only. The bridge already emitted the metric
          // and the errKind line; this records the DECISION taken here.
          bridgeOutcome: 'read_failed',
          disposition: 'transient_err_stripe_will_retry',
        });
        return rollbackTx(
          err({
            code: 'invoice_read_failed',
            detail: 'invoice_payability_read_failed',
          } as const),
        );
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
    // REMOVE-WITH-064-REMEDIATION (online-payment site — master checklist
    // at the guard in record-payment.ts) — `legacy_no_tin_event_not_payable`
    // resolves to 'issued': the F4 guard ONLY fires on issued rows, and an
    // in-flight PI (created before the initiate-side guard deployed) must
    // keep the PRE-GUARD webhook semantics — continue to step 4 (NOT the
    // stale-invoice auto-refund: the member genuinely owes the fee) and let
    // the markPaid-side `legacy_no_tin_event_needs_remediation` guard fail
    // the flip, where the dedicated ops log below makes it loud.
    // I4 (Task 7 remediation) — the `: undefined` fallback this replaces was a
    // loaded gun: any bridge error code not named resolved to `undefined` →
    // `inPayableStatus` false → the stale-invoice branch AUTO-REFUNDS the
    // customer, silently, with a green typecheck. The helper's `never` arm
    // makes the next added code a BUILD failure, exactly as the InvoiceStatus
    // switch below already does.
    const invoiceStatus = invoiceResult.ok
      ? invoiceResult.value.status
      : invoiceStatusFromBridgeError(invoiceResult.error);
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
      // F5R3 SIMPLIFY-H5 (2026-05-16) — extracted from a 35-line IIFE
      // to the module-scope `causeForInvoiceStatus` helper below. The
      // IIFE + v8-ignore + exhaustiveness-trap pattern was load-bearing
      // for narrowing safety but obscured the actual cause mapping at
      // the use-site. The helper centralises the mapping; future F4
      // InvoiceStatus additions still hit the exhaustiveness trap at
      // the helper site (single source of truth).
      const cause = causeForInvoiceStatus(invoiceStatus);

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
      // return after Phase B; the surrounding code reads `stalePending`
      // and ignores this value when it is non-null.
      // Commit: nothing money-side was written, and Phase B (the Stripe
      // refund) runs only after this tx closes — rolling back would buy
      // nothing and would discard `markProcessed` work on sibling paths.
      return commitTx(
        ok<ConfirmPaymentOutcome>({
          kind: 'auto_refunded_stale_invoice',
          invoiceId: payment.invoiceId,
        }),
      );
    }

    // Step 4 — transition check.
    const transition = canTransition(payment.status, 'succeeded');
    if (!transition.ok) {
      // Terminal state = Stripe retry of an already-advanced row. Return
      // no-op ok (reliability F-01 — DO NOT return err or route 5xx-s
      // back at Stripe triggering a retry storm).
      if (transition.error.kind === 'terminal_state') {
        // A.15 (#8 resume-race) — the ONE terminal state that must NOT be a
        // silent no-op: a payment row that committed `failed` (Stripe
        // `payment_intent.payment_failed`) then received a LATE
        // `payment_intent.succeeded`. If Stripe genuinely CAPTURED the money
        // (confirmed via `retrievePaymentIntent` in Phase B), leaving the
        // invoice unpaid while the customer was charged is the bug. Capture
        // the Phase-A sentinel + return early (NO markProcessed here — Phase
        // B folds it in after the auto-refund, mirroring `stalePending`).
        // Trigger is `failed`-ONLY: `succeeded` never reaches this branch
        // (`succeeded → succeeded` is `illegal_transition`, not
        // `terminal_state`); `canceled`/`refunded`/`auto_refunded` fall
        // through to the untouched no-op below (architect F-9 scope: #8 is
        // strictly the terminal-`failed` late-charge case).
        if (payment.status === 'failed') {
          lateChargePending = { payment };
          // Sentinel return — the surrounding code reads `lateChargePending`
          // and computes the real outcome in Phase B; this value is ignored
          // when `lateChargePending` is non-null.
          // Commit: no writes in this branch (deliberately no `markProcessed`
          // — Phase B folds it in after the auto-refund).
          return commitTx(
            ok<ConfirmPaymentOutcome>({
              kind: 'auto_refunded_stale_invoice',
              invoiceId: payment.invoiceId,
            }),
          );
        }
        // Atomic markProcessed (audit 2026-04-26 round-2 #5b).
        await markProcessed();
        // Commit: `markProcessed` is the only write and it is the point.
        return commitTx(
          ok<ConfirmPaymentOutcome>({
            kind: 'already_succeeded',
            invoiceId: payment.invoiceId,
          }),
        );
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
      // Commit: `markProcessed` + the terminal-state forensic must persist —
      // this is a permanent mismatch and a retry cannot improve it.
      return commitTx(
        ok<ConfirmPaymentOutcome>({
          kind: 'already_succeeded',
          invoiceId: payment.invoiceId,
        }),
      );
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
      // Commit: `markProcessed` + invariant-violation forensic must persist;
      // a duplicate succeeded row already exists and will not un-exist.
      return commitTx(
        ok<ConfirmPaymentOutcome>({
          kind: 'already_succeeded',
          invoiceId: payment.invoiceId,
        }),
      );
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
      // `withTx` was believed to roll back. money-remediation Task 4 —
      // that belief was FALSE and is finding F-1: `withTx` is `runInTenant`,
      // which COMMITS whenever the callback returns, so the refusal below
      // never unwound anything. The `null` tx is kept regardless, because it
      // is now load-bearing for the opposite reason: this exit is decided as
      // `commitTxWithRefusal`, and a future author who re-decides it as
      // `rollbackTx` would silently destroy a tx-bound forensic row. On a
      // `null` tx the row survives either decision. Stripe retries the
      // webhook on its own schedule; the gateway adapter also pino-warns via
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
      // `commitTxWithRefusal`, deliberately, and NOT `commitTx` — `commitTx`
      // type-bans `Err`, which is Task 2's narrowing doing its job: it forces
      // this exit to be argued rather than wrapped.
      //
      // The argument: NOTHING money-side has been written on the path to this
      // point. `lockForUpdateByPaymentIntentId` and
      // `listSiblingStatusesForInvariant` are reads, the `updateStatus` flip
      // is still below, and every tx-bound audit emit above belongs to a
      // branch that already returned. Committing an empty transaction is a
      // no-op, so this preserves pre-remediation behaviour EXACTLY on the
      // path with the highest blast radius in the codebase.
      //
      // `rollbackTx` would be equally correct today, and is the safer choice
      // the moment any write is added above this line. It is not taken now
      // only because behaviour-preservation outweighs symmetry here.
      return commitTxWithRefusal(
        err<ConfirmPaymentError>({
          code: 'processor_unavailable',
          reason: retrieved.error.kind,
        }),
      );
    }
    const intent = retrieved.value;

    const completedAt = new Date(input.eventCreatedAtUnixSeconds * 1000);

    // Step 7 — persist.
    // F5R3 CR-1 (2026-05-16) — defence-in-depth `expectedCurrentStatus`
    // mirroring R2-CRIT-1 in cancel-payment. Single-tx + FOR UPDATE
    // pattern keeps the row locked across the Stripe retrieve call so
    // a concurrent webhook cannot flip pending→succeeded mid-tx — the
    // WHERE clause is currently a build-time invariant matching the
    // canTransition gate (line ~480). The guard exists so a future
    // refactor splitting confirmPayment into Phase A/B (matching
    // cancel-payment's pattern) cannot silently regress the
    // financial-integrity invariant. canTransition narrowed
    // payment.status to 'pending' (only legal `from` for 'succeeded').
    // money-remediation Task 4 (adjacent fix) — CAPTURE the return.
    //
    // `updateStatus` returns `null` (it does NOT throw) when
    // `expectedCurrentStatus` no longer matches, and its port docstring is
    // explicit that "every caller passing `expectedCurrentStatus` MUST also
    // handle the `null` race branch". This call site discarded it, so the
    // documented defence-in-depth guard was inert: on a mismatch the UPDATE
    // matched zero rows, execution continued, and the F4 bridge below flipped
    // the invoice to `paid` against a payment row that was never advanced.
    //
    // The mismatch should be unreachable — we hold `FOR UPDATE` on this row
    // for the whole transaction, so nothing can move it underneath us. That
    // is exactly why it must roll back rather than continue: if it ever does
    // fire, the lock/CAS model is wrong and no write here can be trusted.
    const updated = await deps.paymentsRepo.updateStatus(tx, {
      paymentId: payment.id,
      tenantId: input.tenantId,
      nextStatus: 'succeeded',
      expectedCurrentStatus: payment.status,
      processorChargeId: intent.latestChargeId,
      card: intent.card,
      completedAt,
    });
    if (updated === null) {
      logger.error(
        {
          tenantId: input.tenantId,
          paymentId: payment.id,
          invoiceId: payment.invoiceId,
          paymentIntentId: input.paymentIntentId,
          expectedCurrentStatus: payment.status,
        },
        'payments.confirm.cas_mismatch_under_row_lock',
      );
      // Rollback: nothing was written (the UPDATE matched zero rows), but
      // returning `processor_unavailable` maps to a transient decline so the
      // webhook is retried rather than 200-acked into silence. Committing an
      // ack here would strand a captured payment on a `pending` row.
      return rollbackTx(
        err<ConfirmPaymentError>({
          code: 'processor_unavailable',
          reason: 'payment_row_cas_mismatch',
        }),
      );
    }

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
      // REMOVE-WITH-064-REMEDIATION (online-payment site — master
      // checklist at the guard in record-payment.ts). LOUD ops signal:
      // Stripe has CAPTURED the member's money, but F4 refused the invoice
      // flip because the row is a LEGACY issued no-TIN event invoice. The
      // dispatcher classifies `bridge_error` as PERMANENT → 200-ack, no
      // Stripe retry, NO auto-refund. Operators: refund/reconcile per
      // docs/runbooks/event-invoice-legacy-no-tin-remediation.md (the
      // initiate-side guard blocks NEW PIs; only in-flight PIs created
      // before that guard deployed can reach this branch).
      if (bridgeResult.error.code === 'legacy_no_tin_event_needs_remediation') {
        logger.error(
          {
            tenantId: input.tenantId,
            invoiceId: payment.invoiceId,
            paymentId: payment.id,
            paymentIntentId: input.paymentIntentId,
            amountSatang: payment.amountSatang.toString(),
          },
          'payments.confirm.legacy_no_tin_event_money_captured',
        );
      }

      const refusal = err<ConfirmPaymentError>({
        code: 'bridge_error',
        detail: bridgeResult.error.code,
      });

      // ─── money-remediation Task 4 — THIS IS THE F-1 FIX ───────────────
      //
      // What was here: `return err(...)`. `withTx` is `runInTenant`, which
      // COMMITS whenever the callback returns — so the refusal persisted
      // every write it was refusing:
      //
      //   • this payment row, flipped `succeeded` above;
      //   • F4's `members.registration_fee_paid` flip
      //     (`record-payment.ts`, issued before the failure point);
      //   • and for any failure AFTER `sequenceAllocator.allocateNext`, a
      //     CONSUMED §87 receipt sequence number with no document behind
      //     it — a gap in a register Thai RD §87 requires to be gapless.
      //
      // F4 runs on OUR transaction here (the bridge threads `tx`, and
      // `makeDrizzleInvoiceRepo`'s `withTx` short-circuits to it instead of
      // opening its own). F4 therefore cannot unwind its own writes on a
      // decline — it does not own the transaction. Only this decision can.
      if (!deps.settlementAbort) {
        // Flag OFF — pre-remediation behaviour, byte-for-byte. `commitTx`
        // would not compile (it type-bans `Err`), and that is correct: this
        // IS finding F-1, kept switchable only so the prod cut-over is a
        // Vercel env flip rather than a redeploy.
        return commitTxWithRefusal(refusal);
      }

      // Forensic FIRST, on a `null` tx, so it outlives the rollback that is
      // about to erase every other trace of this attempt.
      await emitSettlementRollbackForensic(deps, {
        tenantId: input.tenantId,
        requestId: input.requestId,
        paymentId: payment.id,
        invoiceId: payment.invoiceId,
        paymentIntentId: input.paymentIntentId,
        amountSatang: payment.amountSatang,
        bridgeErrorCode: bridgeResult.error.code,
      });
      logger.error(
        {
          tenantId: input.tenantId,
          invoiceId: payment.invoiceId,
          paymentId: payment.id,
          paymentIntentId: input.paymentIntentId,
          amountSatang: payment.amountSatang.toString(),
          bridgeErrorCode: bridgeResult.error.code,
        },
        'payments.confirm.settlement_rolled_back',
      );
      return rollbackTx(refusal);
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

    // Commit: the happy path — payment `succeeded`, F4 invoice flipped
    // `paid`, `markProcessed` folded in, all in this one transaction.
    return commitTx(
      ok<ConfirmPaymentOutcome>({
        kind: 'processed',
        invoiceId: payment.invoiceId,
      }),
    );
  });

  // R2 H-3 — Phase B: stale-invoice auto-refund. Runs OUTSIDE the
  // Phase-A withTx so the Stripe call (10s SDK timeout) does not hold
  // the payment-row FOR UPDATE lock. Idempotency: Stripe's
  // `auto-refund-${paymentId}` key returns the same refund on retry;
  // `markProcessedIfPresent` is idempotent (no-op when row already
  // processed).
  //
  // F-2 (money-remediation Task 3) — this comment used to end "audit emit
  // on `null` tx commits independently so a Phase-B rollback still leaves a
  // forensic trail". That stopped being true when A.13 moved the emit INSIDE
  // the tx (`drizzle-payments-audit.ts` bubbles the failure whenever
  // `tx !== null`), so a Phase-B rollback left NO trail at all. The
  // `emitPhaseBSettlementForensic` call in the catch below is what makes the
  // sentence true again.
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
            // F5R2-M3 — standardised to underscore-prefix matching the
            // sibling `confirm_payment.stale_refund_phase_b_mark_failed`
            // (line 808). SRE grep `confirm_payment.*phase_b` now
            // matches both paths.
            'confirm_payment.give_up_phase_b_mark_processed_failed',
            {
              paymentId: payment.id,
              errKind:
                phaseBErr instanceof Error
                  ? phaseBErr.constructor.name
                  : 'unknown',
            },
          );
        }
        // F5R3 CR-5 (2026-05-16) — bump the success-path counter for
        // SRE alerting. R2-TY-A added the `auto_refund_given_up`
        // outcome variant explicitly so dashboards could pivot on
        // it, but the metric was missing — chronic stale-invoice
        // give-ups were invisible to alert rules (audit row only,
        // no OTel signal). >0 in 24h = page ops (Stripe-side outage
        // class, not a routine path).
        paymentsMetrics.autoRefundGivenUpCount(input.tenantId);
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

    // Round-2 review fix (MED — #1 status discrimination, parity with
    // issueRefund): `createRefund` returned ok, but the Refund may have settled
    // `failed`/`canceled` SYNCHRONOUSLY at creation — the money was NOT
    // returned. The optimistic `auto_refunded` flip + init money-trail below
    // match the async-pending path (which also flips before the outcome is
    // known), but a synchronously-failed refund has NO reliable follow-up
    // webhook, so we must raise the manual-reconcile forensic + page metric
    // NOW rather than waiting on one that may never arrive.
    const refundFailedAtCreation =
      refund.value.status === 'failed' || refund.value.status === 'canceled';

    // A.13 (#3 / CRITICAL-2) — terminalise the stuck-pending payment in
    // ONE tx: flip `pending → auto_refunded` + stamp the durable marker
    // (`re_…` id) + emit the money-trail audit + markProcessed, all
    // atomic. Pre-fix the row stayed `pending` FOREVER (stuck) and the
    // marker was never written, so a later `charge.refund.updated`
    // fired a FALSE `out_of_band_refund_detected` alert (A.11 recognises
    // the marker via `findAutoRefundByProcessorRefundId` instead).
    //
    // `completed_at` = the Stripe event time (migration 0033 CHECK
    // `payments_completed_at_iff_not_pending` requires it on any
    // non-pending status). Card metadata is untouched — migration 0240
    // relaxed the card CHECK to allow `card + auto_refunded + NULL`.
    //
    // Idempotency: the Stripe idempotency key (`auto-refund-${payment.id}`)
    // returns the SAME refund on retry, and `markProcessed` in THIS tx
    // means a redelivery is caught at the `processor_events` idempotency
    // layer BEFORE re-entering confirmPayment — so exactly ONE audit row
    // + ONE flip land. This eliminates the pre-A.13 split-tx window (audit
    // on null-tx committed, markProcessed in a separate tx) that produced
    // duplicate audit rows on a mid-flight crash (old R3 H3-1 artefact).
    const completedAt = new Date(input.eventCreatedAtUnixSeconds * 1000);
    // F-2: distinguishes "the transaction failed" from "something after the
    // commit failed". See `emitPhaseBSettlementForensic`.
    let phaseBCommitted = false;
    try {
      await deps.paymentsRepo.withTx(async (tx) => {
        // Guarded flip (`WHERE status='pending'` — expectedCurrentStatus
        // semantics). `null` → a concurrent writer (e.g. member cancel)
        // terminalised the row between Phase A's lock release and here.
        const flipped = await deps.paymentsRepo.markAutoRefunded(tx, {
          paymentId: payment.id,
          tenantId: input.tenantId,
          processorRefundId: refund.value.id,
          completedAt,
        });
        await deps.audit.emit(tx, {
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
        if (refundFailedAtCreation) {
          // Money-not-returned forensic — the SAME event process-refund-updated
          // emits when a pending auto-refund later settles failed via webhook,
          // so the admin auto-refund-failed alert + "mark reconciled" resolve
          // surface (findStaleInvoiceAutoRefund: init-event AND failure-event)
          // fires here too. 10y retention (RD §87 / GDPR 6(1)(c)).
          await deps.audit.emit(tx, {
            tenantId: input.tenantId,
            requestId: input.requestId,
            eventType: 'auto_refund_failed_needs_manual_reconcile',
            actorUserId: SYSTEM_ACTOR_STRIPE_WEBHOOK,
            summary: `Auto-refund for payment ${payment.id} settled ${refund.value.status} at creation — money NOT returned; manual reconciliation required`,
            payload: {
              payment_id: payment.id,
              invoice_id: payment.invoiceId,
              auto_refund_processor_refund_id: refund.value.id,
              refund_status: refund.value.status,
              amount_satang: payment.amountSatang.toString(),
              runbook_url: 'docs/runbooks/out-of-band-refund.md',
            },
            retentionYears: retentionFor(
              'auto_refund_failed_needs_manual_reconcile',
            ),
          });
        }
        await markProcessedIfPresent(deps, input, tx);
        if (flipped === null) {
          // `markAutoRefunded`'s `status='pending'` guard matched ZERO rows —
          // a concurrent writer terminalised the row off `pending`, OR the
          // Phase-A-locked row was ALREADY terminal `failed`. BOTH sub-cases
          // now stamp the SAME status-agnostic recognition marker (guard only
          // on `auto_refund_processor_refund_id IS NULL`) so the auto-refund's
          // own later `charge.refund.updated` / `charge.refunded` is
          // RECOGNISED via `findAutoRefundByProcessorRefundId`
          // (A.11 `auto_refund_recognized`) instead of firing a FALSE
          // `out_of_band_refund_detected` on EITHER webhook. The refund itself
          // is always correct; the marker only removes the false-OOB noise.
          // The two log keys are kept distinct for on-call forensics; the
          // branches are discriminated by the Phase-A-locked `payment.status`
          // (stable for a terminal row — no writer moves `failed` back to
          // `pending`).
          if (payment.status === 'failed') {
            // Sub-case (ii) — the locked row was ALREADY terminal `failed`. A
            // late captured charge on a NON-payable invoice routes through
            // Step 3 (stale-invoice), which runs BEFORE the Step 4 transition
            // check and does NOT inspect `payment.status`, so `markAutoRefunded`
            // (guard `status='pending'`) could never match here. Stamp the A.15
            // marker (guard `auto_refund_processor_refund_id IS NULL`; F-9 —
            // status UNTOUCHED).
            const marked = await deps.paymentsRepo.attachAutoRefundMarkerIfAbsent(
              tx,
              {
                paymentId: payment.id,
                tenantId: input.tenantId,
                processorRefundId: refund.value.id,
              },
            );
            if (marked === null) {
              // The marker was already stamped (Stripe retry idempotency; the
              // partial-unique index is the DB backstop). The Stripe refund DID
              // happen; the audit above is the durable money-trail.
              /* v8 ignore next 5 -- ops warn on the rare marker-already-present race; unit tests don't wire deps.logger (mirrors the late-charge marker + Phase B siblings). */
              deps.logger?.warn('confirm_payment.auto_refund_marker_on_failed_guard_miss', {
                tenantId: input.tenantId,
                paymentId: payment.id,
                processorRefundId: refund.value.id,
              });
            }
          } else {
            // Sub-case (i) — concurrent-manual-mark (runbook §1.1, now CLOSED):
            // the row was `pending` at the Phase-A lock but a concurrent writer
            // terminalised it to a DIFFERENT status (e.g. an admin mark-paid
            // flip, a member cancel, or a late `payment_intent.succeeded`)
            // between Phase A's lock release and here. Stamp the SAME
            // status-agnostic marker so the auto-refund is recognised on both
            // later webhooks — symmetric to sub-case (ii). Pre-fix this branch
            // was log-only, so no marker was stamped and BOTH webhooks raised a
            // false `out_of_band_refund_detected`. The Stripe refund DID happen;
            // the audit above is the durable money-trail.
            const marked = await deps.paymentsRepo.attachAutoRefundMarkerIfAbsent(tx, {
              paymentId: payment.id,
              tenantId: input.tenantId,
              processorRefundId: refund.value.id,
            });
            if (marked === null) {
              // The marker was already stamped (Stripe retry idempotency; the
              // partial-unique index is the DB backstop). The Stripe refund DID
              // happen; the audit above is the durable money-trail.
              /* v8 ignore next 5 -- ops warn on the rare marker-already-present race; unit tests don't wire deps.logger (mirrors the sub-case (ii) + Phase B siblings). */
              deps.logger?.warn('confirm_payment.auto_refund_flip_guard_miss', {
                tenantId: input.tenantId,
                paymentId: payment.id,
                processorRefundId: refund.value.id,
              });
            }
          }
        }
      });
      phaseBCommitted = true;
      // F5R1-E15 — metric AFTER the tx commits so a Phase B failure does
      // NOT bump it (the Stripe retry that recovers WILL bump it cleanly).
      paymentsMetrics.autoRefundedStaleCount(input.tenantId);
      if (refundFailedAtCreation) {
        // Page ops on the money-not-returned path (mirrors process-refund-
        // updated's failed-webhook metric). AFTER commit so a Phase B failure
        // does not over-count; a Stripe retry re-runs cleanly.
        paymentsMetrics.autoRefundFailedNeedsReconcile(input.tenantId);
      }
    } catch (phaseBErr) {
      // F5R3 CR-6 (2026-05-16) — bump dedicated counter + structured log
      // so chronic Phase B failures surface to alert rules (pino rolls
      // off in 30 days).
      paymentsMetrics.confirmPaymentStaleRefundPhaseBMarkFailed();
      const phaseBErrKind = errKind(phaseBErr);
      deps.logger?.warn('confirm_payment.stale_refund_phase_b_mark_failed', {
        tenantId: input.tenantId,
        paymentId: payment.id,
        errKind: phaseBErrKind,
        // F-2 part 2: was `awaiting_stripe_retry_idempotency`. That claim
        // was false — this function returns `ok`, the route 200-acks, and
        // Stripe does not redeliver a 2xx, so the idempotency-key retry it
        // promised can never fire. Nothing recovers this without a human.
        recovery: 'manual_reconcile_via_runbook',
      });
      await emitPhaseBSettlementForensic(deps, {
        committed: phaseBCommitted,
        tenantId: input.tenantId,
        requestId: input.requestId,
        eventType: auditEventType,
        paymentId: payment.id,
        invoiceId: payment.invoiceId,
        amountSatang: payment.amountSatang,
        cause,
        processorRefundId: refund.value.id,
        refundStatus: refund.value.status,
        errorKind: phaseBErrKind,
      });
    }

    return ok<ConfirmPaymentOutcome>({
      kind: 'auto_refunded_stale_invoice',
      invoiceId: payment.invoiceId,
    });
  }

  // A.15 (#8 resume-race) — Phase B: `failed → succeeded` late-charge
  // reconcile. Runs OUTSIDE the Phase-A withTx so the Stripe retrieve +
  // createRefund calls (10s SDK timeout each) do not hold the payment-row
  // FOR UPDATE lock (mirrors the stale-refund split above). TS narrows the
  // captured-let to `never` after the closure, so re-bind through a cast.
  const lateChargeFinal = lateChargePending as LateChargePending | null;
  if (lateChargeFinal !== null) {
    const { payment } = lateChargeFinal;

    // Confirm Stripe ACTUALLY captured the money before refunding. PCI
    // SAQ-A: the charge id enters the trust boundary through this single
    // gateway call, never from the webhook event payload.
    const retrieved = await deps.processorGateway.retrievePaymentIntent(
      input.paymentIntentId,
      settings.processorAccountId,
    );
    if (!retrieved.ok) {
      // Mirror Step 6: forensic trail + let Stripe retry. Nothing was
      // committed for this row in Phase A (sentinel-only), so the row is
      // still `failed`; the emit is best-effort on `null` tx.
      await deps.audit.emit(null, {
        tenantId: input.tenantId,
        requestId: input.requestId,
        eventType: 'payment_processor_retrieve_failed',
        actorUserId: SYSTEM_ACTOR_STRIPE_WEBHOOK,
        summary: `retrievePaymentIntent failed during failed→succeeded reconcile of ${input.paymentIntentId}`,
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

    // Anomalous: a `payment_intent.succeeded` with NO captured charge. There
    // is nothing to refund; do NOT invent one. Ack (markProcessed) so Stripe
    // stops retrying, and warn LOUDLY — a succeeded event without a charge is
    // a Stripe-state anomaly ops should see (sub-decision 2).
    if (retrieved.value.latestChargeId === null) {
      deps.logger?.warn('confirm_payment.late_charge_no_captured_charge', {
        tenantId: input.tenantId,
        paymentId: payment.id,
      });
      await deps.paymentsRepo.withTx(async (tx) => {
        await markProcessedIfPresent(deps, input, tx);
      });
      return ok<ConfirmPaymentOutcome>({
        kind: 'already_succeeded',
        invoiceId: payment.invoiceId,
      });
    }

    // Auto-refund the captured funds (reuse the A.13 Stripe path). Distinct
    // idempotency namespace `late-charge-refund-` so a Stripe retry dedupes
    // to the SAME refund AND cannot collide with the stale path's
    // `auto-refund-` key for the same payment id.
    const refund = await deps.processorGateway.createRefund({
      paymentIntentId: input.paymentIntentId,
      metadata: {
        invoiceId: payment.invoiceId,
        tenantId: input.tenantId,
        paymentId: payment.id,
        cause: 'payment_terminal_failed_late_charge',
      },
      idempotencyKey: `late-charge-refund-${payment.id}`,
      stripeAccount: settings.processorAccountId,
    });
    if (!refund.ok) {
      // Mirror the A.13 give-up: bound Stripe's retry storm. If the event is
      // already aged past 48h we are in an extended outage — 200-ack + a
      // give-up forensic so Stripe drains; operator reconciles via runbook.
      // The customer stays charged; the row is still `failed`.
      const nowSeconds = Math.floor(deps.clock.nowMs() / 1000);
      const eventAgeSeconds = nowSeconds - input.eventCreatedAtUnixSeconds;
      const LATE_CHARGE_REFUND_GIVE_UP_SECONDS = 48 * 60 * 60;
      if (eventAgeSeconds > LATE_CHARGE_REFUND_GIVE_UP_SECONDS) {
        await deps.audit.emit(null, {
          tenantId: input.tenantId,
          requestId: input.requestId,
          eventType: 'out_of_band_refund_detected',
          actorUserId: SYSTEM_ACTOR_STRIPE_WEBHOOK,
          summary: `Auto-refund giving up after ${Math.floor(eventAgeSeconds / 3600)}h — late-charge refund still failing on event ${input.processorEventId ?? 'unknown'} for terminal-failed payment ${payment.id}; admin must reconcile via Stripe Dashboard`,
          payload: {
            processor_refund_id: input.processorEventId ?? `event-${payment.id}`,
            processor_charge_id: retrieved.value.latestChargeId,
            amount_satang: payment.amountSatang.toString(),
            runbook_url: 'docs/runbooks/out-of-band-refund.md',
          },
          retentionYears: retentionFor('out_of_band_refund_detected'),
        });
        try {
          await deps.paymentsRepo.withTx(async (tx) => {
            await markProcessedIfPresent(deps, input, tx);
          });
          /* v8 ignore start — Phase B markProcessed catch; rare DB-outage
           * race after the 200-ack decision. Mirrors the stale give-up
           * sibling. */
        } catch (phaseBErr) {
          paymentsMetrics.confirmPaymentGiveUpPhaseBMarkProcessedFailed();
          deps.logger?.warn(
            'confirm_payment.late_charge_give_up_phase_b_mark_processed_failed',
            {
              paymentId: payment.id,
              errKind:
                phaseBErr instanceof Error ? phaseBErr.constructor.name : 'unknown',
            },
          );
        }
        /* v8 ignore stop */
        paymentsMetrics.autoRefundGivenUpCount(input.tenantId);
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

    // Round-2 review fix (MED — #1 status discrimination): Stripe accepted the
    // refund, but it may have settled `failed`/`canceled` synchronously (money
    // NOT returned). Same discipline as the stale-invoice path above.
    const lateChargeRefundFailedAtCreation =
      refund.value.status === 'failed' || refund.value.status === 'canceled';

    // Stripe accepted the refund. In ONE tx: durably stamp the `re_…` id on
    // the STILL-`failed` row (RR-6 recognition marker; F-9 — status NOT
    // changed) + emit the 10y forensic money-trail + markProcessed.
    // F-2: see the stale-invoice sibling above.
    let phaseBCommitted = false;
    try {
      await deps.paymentsRepo.withTx(async (tx) => {
        const marked = await deps.paymentsRepo.attachAutoRefundMarkerIfAbsent(tx, {
          paymentId: payment.id,
          tenantId: input.tenantId,
          processorRefundId: refund.value.id,
        });
        await deps.audit.emit(tx, {
          tenantId: input.tenantId,
          requestId: input.requestId,
          eventType: 'payment_auto_refunded_stale_invoice',
          actorUserId: SYSTEM_ACTOR_STRIPE_WEBHOOK,
          summary: `Auto-refunded late captured charge on terminal-failed payment ${payment.id} — invoice still payable; row left failed (architect F-9)`,
          payload: {
            payment_id: payment.id,
            invoice_id: payment.invoiceId,
            refunded_amount_satang: payment.amountSatang.toString(),
            cause: 'payment_terminal_failed_late_charge',
            processor_refund_id: refund.value.id,
          },
          retentionYears: retentionFor('payment_auto_refunded_stale_invoice'),
        });
        if (lateChargeRefundFailedAtCreation) {
          // Money-not-returned forensic — surfaces the admin manual-reconcile
          // alert immediately (no reliable follow-up webhook for a
          // synchronously-failed refund). Same event as the webhook path.
          await deps.audit.emit(tx, {
            tenantId: input.tenantId,
            requestId: input.requestId,
            eventType: 'auto_refund_failed_needs_manual_reconcile',
            actorUserId: SYSTEM_ACTOR_STRIPE_WEBHOOK,
            summary: `Late-charge auto-refund for payment ${payment.id} settled ${refund.value.status} at creation — money NOT returned; manual reconciliation required`,
            payload: {
              payment_id: payment.id,
              invoice_id: payment.invoiceId,
              auto_refund_processor_refund_id: refund.value.id,
              refund_status: refund.value.status,
              amount_satang: payment.amountSatang.toString(),
              runbook_url: 'docs/runbooks/out-of-band-refund.md',
            },
            retentionYears: retentionFor(
              'auto_refund_failed_needs_manual_reconcile',
            ),
          });
        }
        await markProcessedIfPresent(deps, input, tx);
        if (marked === null) {
          // Guard miss: the marker was already stamped (Stripe retry
          // idempotency; the partial-unique index is the DB backstop). The
          // status-agnostic guard (`... IS NULL` only) means a concurrent
          // status change no longer causes a miss — the marker lands
          // regardless. The Stripe refund DID happen; the audit above is the
          // durable money-trail. Warn so ops can confirm the refund via the
          // runbook.
          /* v8 ignore next 5 -- ops warn on the rare marker-already-present race; unit tests don't wire deps.logger (mirrors the stale Phase B siblings). */
          deps.logger?.warn('confirm_payment.late_charge_marker_guard_miss', {
            tenantId: input.tenantId,
            paymentId: payment.id,
            processorRefundId: refund.value.id,
          });
        }
      });
      phaseBCommitted = true;
      // Metric AFTER the tx commits so a Phase B failure does NOT bump it
      // (the Stripe retry that recovers WILL bump it cleanly).
      paymentsMetrics.lateChargeAutoRefundedCount(input.tenantId);
      if (lateChargeRefundFailedAtCreation) {
        // Page ops on the money-not-returned path (mirrors the webhook metric).
        paymentsMetrics.autoRefundFailedNeedsReconcile(input.tenantId);
      }
    } catch (phaseBErr) {
      // Distinct late-charge (#8) counter — mirrors the distinct SUCCESS-path
      // metric `lateChargeAutoRefundedCount` so the two Phase B failure paths
      // (stale-invoice vs late-charge) are not conflated on SRE dashboards.
      paymentsMetrics.confirmPaymentLateChargePhaseBMarkFailed();
      const phaseBErrKind = errKind(phaseBErr);
      deps.logger?.warn('confirm_payment.late_charge_phase_b_mark_failed', {
        tenantId: input.tenantId,
        paymentId: payment.id,
        errKind: phaseBErrKind,
        // F-2 part 2 — see the stale-invoice sibling. The 200-ack makes the
        // previously-claimed `awaiting_stripe_retry_idempotency` impossible.
        recovery: 'manual_reconcile_via_runbook',
      });
      await emitPhaseBSettlementForensic(deps, {
        committed: phaseBCommitted,
        tenantId: input.tenantId,
        requestId: input.requestId,
        eventType: 'payment_auto_refunded_stale_invoice',
        paymentId: payment.id,
        invoiceId: payment.invoiceId,
        amountSatang: payment.amountSatang,
        cause: 'payment_terminal_failed_late_charge',
        processorRefundId: refund.value.id,
        refundStatus: refund.value.status,
        errorKind: phaseBErrKind,
      });
    }

    return ok<ConfirmPaymentOutcome>({
      kind: 'auto_refunded_stale_invoice',
      invoiceId: payment.invoiceId,
    });
  }

  // `phaseA` is a `TxOutcome`; `.value` is the Result the caller contracts
  // for. `.committed` is deliberately NOT surfaced — the ok/err → HTTP
  // mapping is Task 5's subject, and widening the return type here would
  // change it as a side effect.
  return phaseA.value;
}
