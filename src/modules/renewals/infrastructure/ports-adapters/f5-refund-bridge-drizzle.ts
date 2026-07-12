/**
 * F8 Phase 5 Wave C → Production · `F5RefundBridge` adapter.
 *
 * Composes F5's `loadInvoicePaymentActivity` + `issueRefund` use-cases
 * via the F5 barrel exports. Used by T137 admin-reject-reactivation
 * and T138 reconcile-pending-reactivations cron auto-timeout.
 *
 * Flow:
 *   1. `loadInvoicePaymentActivity(invoiceId)` → list of payments + refunds.
 *   2. `computeRemainingRefundable(activity)` → succeeded paymentId +
 *      remaining refundable amount. Returns `null` if no succeeded
 *      payment OR fully refunded — bridge maps to `'no_payment_found'`.
 *   3. `issueRefund({ paymentId, amountSatang: remaining, reason, ... })`
 *      → cascades F5 refund + F4 credit-note creation in F5's two-tx
 *      design (Phase A → Stripe → Phase B).
 *
 * Pure Infrastructure — only F5 barrel imports + the port interface.
 */
import {
  computeRemainingRefundable,
  issueRefund,
  loadInvoicePaymentActivity,
  makeIssueRefundDeps,
  makeLoadInvoicePaymentActivityDeps,
} from '@/modules/payments';
import { asSatang } from '@/lib/money';
import type {
  F5RefundBridge,
  GetRefundOutcomeInput,
  GetRefundOutcomeResult,
  IssueRefundForInvoiceInput,
  IssueRefundForInvoiceResult,
} from '../../application/ports/f5-refund-bridge';

export const f5RefundBridge: F5RefundBridge = {
  async issueRefundForInvoice(
    input: IssueRefundForInvoiceInput,
  ): Promise<IssueRefundForInvoiceResult> {
    // ---- Step 1+2: find the succeeded payment + remaining refundable
    const activityResult = await loadInvoicePaymentActivity(
      makeLoadInvoicePaymentActivityDeps(input.tenantId),
      { tenantId: input.tenantId, invoiceId: input.invoiceId },
    );
    if (!activityResult.ok) {
      return {
        status: 'refund_failed',
        errorCode: activityResult.error.kind,
        detail: 'F5 paymentsRepo unavailable',
      };
    }
    const remaining = computeRemainingRefundable(activityResult.value);
    if (remaining === null) {
      // No succeeded payment OR fully refunded — admin can still
      // reject the cycle but no Stripe refund happens.
      return { status: 'no_payment_found' };
    }

    // ---- Step 3: issue refund via F5 (cascades F4 credit-note)
    const refundResult = await issueRefund(
      makeIssueRefundDeps(input.tenantId),
      {
        tenantId: input.tenantId,
        paymentId: remaining.paymentId,
        // F5R3 H-5 (2026-05-16) — brand at F8→F5 bridge.
        amountSatang: asSatang(remaining.remainingSatang),
        reason: input.reason,
        actorUserId: input.actorUserId,
        correlationId: input.correlationId,
        requestId: input.requestId,
      },
    );
    if (!refundResult.ok) {
      // F8-RP (2026-07-11): `refund_in_progress` is NOT a failure — it means
      // a prior refund for this payment is ALREADY pending/settling (F5's
      // Phase-A pending-row guard fired). The correct action is to WAIT for
      // that refund to settle, not to alert the admin or count a failure.
      // Surface it as `refund_pending` (no ids — the error carries none) so
      // the reject route returns 202 and the cron does not count a timeout
      // failure. Money-safe: the pending row still blocks a double refund;
      // the cycle self-heals when the refund settles. Every OTHER error
      // (processor_unavailable, f4_bridge_error, payment_not_refundable, …)
      // is a genuine `refund_failed` the admin must act on — unchanged.
      if (refundResult.error.code === 'refund_in_progress') {
        return { status: 'refund_pending' };
      }
      return {
        status: 'refund_failed',
        errorCode: refundResult.error.code,
        detail:
          'detail' in refundResult.error
            ? refundResult.error.detail
            : 'reason' in refundResult.error
              ? String(refundResult.error.reason)
              : refundResult.error.code,
      };
    }
    // F8-RP (2026-07-11): `issueRefund` discriminates on the Stripe refund
    // status. An async `pending`/`requires_action` refund has NOT returned
    // the money and has NO credit note yet — both settle when the F5
    // `charge.refund.updated` webhook (A.11) / Stripe-aware sweep (A.14)
    // confirms it. Surface it as the first-class `refund_pending` outcome
    // carrying the refund + processor ids (webhook-matchable). Money-safe:
    // the row stays `pending`, so a retry hits F5's `refund_in_progress`
    // guard (no double refund) and no false CN is recorded (which would
    // violate the `renewal_cycles → credit_notes` FK). The F8 cycle stays
    // `pending_admin_reactivation` and self-heals on a later cron pass once
    // the refund settles (bridge then returns `no_payment_found`).
    if (refundResult.value.kind === 'pending') {
      return {
        status: 'refund_pending',
        refundId: refundResult.value.refund.id,
        processorRefundId: refundResult.value.refund.processorRefundId,
      };
    }
    return {
      status: 'refunded',
      refundId: refundResult.value.refund.id,
      creditNoteId: refundResult.value.refund.creditNoteId,
      creditNoteNumber: refundResult.value.refund.creditNoteNumber,
    };
  },

  async getRefundOutcomeForInvoice(
    input: GetRefundOutcomeInput,
  ): Promise<GetRefundOutcomeResult> {
    // F8-RP follow-up — read-only settlement lookup. Compose F5's
    // `loadInvoicePaymentActivity` (which returns every payment + refund DTO
    // for the invoice, each refund carrying `status` + `creditNoteId`) and
    // match the specific refund the cycle recorded at reject time by its id.
    // No Stripe call, no mutation.
    const activityResult = await loadInvoicePaymentActivity(
      makeLoadInvoicePaymentActivityDeps(input.tenantId),
      { tenantId: input.tenantId, invoiceId: input.invoiceId },
    );
    if (!activityResult.ok) {
      return {
        status: 'lookup_failed',
        detail: activityResult.error.kind,
      };
    }
    const refund = activityResult.value.refunds.find(
      (r) => r.refundId === input.refundId,
    );
    if (!refund) {
      return { status: 'not_found' };
    }
    switch (refund.status) {
      case 'succeeded':
        // F5 domain invariant: status='succeeded' ⟺ credit_note_id NOT NULL.
        // The DTO surfaces it directly; pass it through (defensively nullable
        // per the port contract — see GetRefundOutcomeResult.succeeded).
        return { status: 'succeeded', creditNoteId: refund.creditNoteId };
      case 'failed':
        return {
          status: 'failed',
          failureReasonCode: refund.failureReasonCode,
        };
      case 'pending':
        return { status: 'pending' };
      default: {
        // Exhaustiveness pin — a future RefundStatus addition surfaces here.
        const _exhaustive: never = refund.status;
        void _exhaustive;
        return { status: 'pending' };
      }
    }
  },
};
