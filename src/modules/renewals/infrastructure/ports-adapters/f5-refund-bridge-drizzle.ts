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
  FindPendingRefundForInvoiceInput,
  FindPendingRefundForInvoiceResult,
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
      // Money-remediation F-3 (Task 6): `f4_bridge_deferred` joins
      // `refund_in_progress` on the WAIT side, and for the same reason. The
      // money HAS gone back to the member — only the §86/10 credit note is
      // outstanding, and the stale-pending sweep retries the idempotent
      // bridge. Routing it to `refund_failed` would tell an admin to act on a
      // refund that is progressing normally, and "act" here means click
      // refund again. That click is the mechanism F-3 needed to double-refund;
      // it is fenced now by the row staying `pending`, but presenting a
      // succeeded refund as a failure is exactly the false alarm this
      // remediation exists to remove.
      //
      // Ids are carried so the cycle is webhook-matchable while it self-heals.
      if (refundResult.error.code === 'f4_bridge_deferred') {
        return {
          status: 'refund_pending',
          refundId: refundResult.error.refundId,
          processorRefundId: refundResult.error.processorRefundId,
        };
      }
      // I5 (money-remediation Task 7): `f4_preflight_receipt_rendering` joins
      // the WAIT side by this adapter's OWN stated rule — do not tell an admin
      // to act on a self-healing state, because "act" here means clicking
      // refund again. The receipt PDF is still `pending` and the reconcile
      // cron sweeps stuck pending rows, so the refund becomes possible on its
      // own within minutes. Reachable narrowly but really: rejecting a pending
      // reactivation on a just-paid renewal invoice, inside the render window.
      //
      // No ids: money did NOT move on this path (the pre-flight refused before
      // Stripe), so there is no refund row and nothing webhook-matchable —
      // unlike `f4_bridge_deferred` above, where the money DID move.
      //
      // Its siblings stay on the FAILED side: a `failed`/NULL receipt never
      // clears on its own, and an uncreditable or corrupt invoice never will
      // either, so an admin genuinely must act on those.
      //
      // Track B — the discriminator is the DOMAIN reason's `retryability`, not
      // a code list. That is the point of carrying retryability in the type: a
      // future F4 gate whose block is transient joins the WAIT side by being
      // typed transient, with no edit here and no chance of being forgotten.
      if (
        refundResult.error.code === 'f4_preflight_credit_note_blocked' &&
        refundResult.error.reason.retryability === 'transient'
      ) {
        return { status: 'refund_pending' };
      }
      return {
        status: 'refund_failed',
        errorCode: refundResult.error.code,
        detail:
          'detail' in refundResult.error
            ? refundResult.error.detail
            : refundResult.error.code === 'f4_preflight_credit_note_blocked'
              ? refundResult.error.reason.code
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
      // Track B — NULL when the refund owed no §86/10. F8 must not treat that
      // as "no payment was refunded": the money DID go back, there is simply
      // no credit note to reference. See the escalation gate in
      // admin-reject-reactivation, which keys on the refund OUTCOME rather
      // than on credit-note presence for exactly this reason.
      creditNoteId:
        refundResult.value.refund.creditNote.kind === 'issued'
          ? refundResult.value.refund.creditNote.id
          : null,
      creditNoteNumber:
        refundResult.value.refund.creditNote.kind === 'issued'
          ? refundResult.value.refund.creditNote.number
          : null,
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

  async findPendingRefundForInvoice(
    input: FindPendingRefundForInvoiceInput,
  ): Promise<FindPendingRefundForInvoiceResult> {
    // F8-RP-2 review (Finding 3) — read-only lookup of the invoice's single
    // in-flight (`pending`) refund + its id. Composes F5's
    // `loadInvoicePaymentActivity` (every payment + refund DTO for the invoice)
    // and picks the one `pending` refund. The one-active-payment-per-invoice +
    // one-pending-refund-per-payment F5 invariants make this unambiguous. No
    // Stripe call, no mutation.
    const activityResult = await loadInvoicePaymentActivity(
      makeLoadInvoicePaymentActivityDeps(input.tenantId),
      { tenantId: input.tenantId, invoiceId: input.invoiceId },
    );
    if (!activityResult.ok) {
      return { status: 'lookup_failed', detail: activityResult.error.kind };
    }
    const pending = activityResult.value.refunds.find(
      (r) => r.status === 'pending',
    );
    if (!pending) {
      // Either it already settled between F5's `refund_in_progress` guard and
      // this lookup (TOCTOU), or none exists. Caller does not stamp.
      return { status: 'none' };
    }
    return {
      status: 'found',
      refundId: pending.refundId,
      processorRefundId: pending.processorRefundId,
    };
  },
};
