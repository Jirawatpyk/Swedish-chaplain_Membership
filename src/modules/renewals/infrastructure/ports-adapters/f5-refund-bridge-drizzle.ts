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
    // #1 (2026-07-11) — `issueRefund` now discriminates on the Stripe
    // refund status. An async `pending`/`requires_action` refund has NOT
    // returned the money and has NO credit note yet (both settle when the
    // F5 `charge.refund.updated` webhook / Stripe-aware sweep confirms it).
    // The F8 reactivation-reject flow needs a settled refund + CN to
    // resolve the cycle, and the bridge's 3-outcome contract has no
    // `pending` state, so surface it as a NON-terminal failure with a
    // distinct code. This is safe: the F5 `refund_in_progress` guard
    // prevents a double refund on any retry, and no false CN is recorded
    // (which would violate the `renewal_cycles → credit_notes` FK). It is
    // NOT ideal — the cron path (`reconcile-pending-reactivations`) will
    // keep the cycle pending. FOLLOW-UP (F8, tracked in the A.9 report):
    // add an explicit `refund_pending` bridge outcome so the reject /
    // reconcile flows resolve the cycle once the async refund is confirmed.
    if (refundResult.value.kind === 'pending') {
      return {
        status: 'refund_failed',
        errorCode: 'refund_pending_async',
        detail: `Stripe refund ${refundResult.value.refund.processorRefundId} is settling asynchronously; the credit note is issued once the processor confirms it.`,
      };
    }
    return {
      status: 'refunded',
      refundId: refundResult.value.refund.id,
      creditNoteId: refundResult.value.refund.creditNoteId,
      creditNoteNumber: refundResult.value.refund.creditNoteNumber,
    };
  },
};
