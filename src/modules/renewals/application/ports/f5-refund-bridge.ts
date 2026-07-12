/**
 * F8 → F5 cross-module bridge port (Phase 5 Wave A.5 — T137 / T138).
 *
 * F8's admin-reject-reactivation + reconcile-pending-reactivations
 * flows need to refund the renewal payment that was held in
 * `pending_admin_reactivation` (FR-005d). F5's `issueRefund` use-case
 * needs `paymentId` (not `invoiceId`) + a positive `amountSatang`,
 * which means F8 first has to look up the succeeded payment for the
 * cycle's linked invoice + read the refundable balance.
 *
 * Encapsulating this two-step "find payment for invoice → issue full
 * refund" into a single bridge method keeps F8's use-cases free of F5
 * internals + lets the production adapter compose F5's
 * `loadInvoicePaymentActivity` + `issueRefund` use-cases. Mirrors the
 * existing `f4-invoice-bridge.ts` precedent for F8 → F4.
 *
 * **Round 2 review-fix S-9 / Round 3 review-fix CR1** (canonical brand
 * adoption): the cross-module input types use the **canonical** branded
 * types from each owning module — `TenantId` from `@/modules/members`
 * (F3 owns the tenant-id concept across all member-related surfaces)
 * and `InvoiceId` from `@/modules/invoicing` (F4 owns invoice ids).
 * This prevents the parallel-type-system trap that an `@/lib/branded-ids`
 * fork would create (Round 3 R3-CR1 finding) — a `TenantId` from
 * F3 is the same nominal type everywhere it's used. Arg-swap protection
 * stays — `issueRefundForInvoice({ tenantId: invoiceId, invoiceId:
 * tenantId })` (swapped) refuses to type-check. The 3 other F8 cross-
 * module ports (`f4-invoicing-bridge`, `plan-lookup-for-renewal`,
 * `event-attendees-port`) adopt the same pattern incrementally as
 * they're touched (F9).
 *
 * Pure interface — no framework imports (Constitution Principle III).
 */

import type { TenantId } from '@/modules/members';
import type { InvoiceId } from '@/modules/invoicing';

export interface IssueRefundForInvoiceInput {
  readonly tenantId: TenantId;
  readonly invoiceId: InvoiceId;
  /** Free-text reason persisted on F5 refund row + carried in audit. */
  readonly reason: string;
  readonly actorUserId: string;
  readonly correlationId: string;
  readonly requestId: string | null;
}

export type IssueRefundForInvoiceResult =
  | {
      readonly status: 'refunded';
      readonly refundId: string;
      readonly creditNoteId: string;
      readonly creditNoteNumber: string;
    }
  | {
      readonly status: 'no_payment_found';
      /**
       * No succeeded payment exists against this invoice — admin can
       * still reject the reactivation but no refund is required (the
       * `pending_admin_reactivation` state was entered without a
       * cleared payment, e.g. via a now-resolved manual override).
       */
    }
  | {
      readonly status: 'refund_failed';
      /** F5 error code (`processor_unavailable`, `f4_bridge_error`, etc.). */
      readonly errorCode: string;
      readonly detail: string;
    }
  | {
      /**
       * F8-RP (2026-07-11): the F5 refund is settling ASYNCHRONOUSLY — a
       * NON-terminal, non-failure state. Two paths land here:
       *   1. `issueRefund` → `kind:'pending'` — Stripe created the refund
       *      (`pending`/`requires_action`); the row is `pending` with its
       *      `re_…` id attached and NO credit note yet. The
       *      `charge.refund.updated` webhook (A.11) / Stripe-aware sweep
       *      (A.14) finalises it later.
       *   2. `issueRefund` → `refund_in_progress` — a prior refund for this
       *      payment is ALREADY pending/settling (F5's Phase-A pending-row
       *      guard). No ids are available from that error, so they are
       *      omitted here.
       *
       * MONEY-SAFETY: the refund row stays `pending`, so any retry hits the
       * F5 `refund_in_progress` guard → NO double refund. The F8 cycle stays
       * `pending_admin_reactivation` and self-heals on a later cron pass once
       * the refund settles (bridge then returns `no_payment_found` → normal
       * lapse transition). Distinct from `refund_failed` (genuine Stripe
       * failed/canceled, which the admin must retry).
       */
      readonly status: 'refund_pending';
      /** F5 refund row id — present on the `kind:'pending'` path; absent on the `refund_in_progress` retry path. */
      readonly refundId?: string;
      /** Stripe `re_…` id — present on the `kind:'pending'` path; absent on the `refund_in_progress` retry path. */
      readonly processorRefundId?: string;
    };

/**
 * F8-RP follow-up (2026-07-12) — settlement lookup for a previously-initiated
 * async reject-with-refund. When `adminRejectReactivation` records
 * `refund_pending` it stamps the F5 refund id on the cycle marker; the
 * reconcile-pending cron later calls this to learn whether that specific
 * refund has SETTLED, so it can converge the cycle → `cancelled` (parity with
 * the SYNC reject path) rather than let the 30-day timeout lapse it.
 */
export interface GetRefundOutcomeInput {
  readonly tenantId: TenantId;
  readonly invoiceId: InvoiceId;
  /** The F5 refund row id (`rfnd_…`) stamped on the cycle at reject time. */
  readonly refundId: string;
}

export type GetRefundOutcomeResult =
  | {
      /**
       * The refund SETTLED successfully. The F4 credit note is now attached
       * (F5 domain invariant: `status='succeeded'` ⟺ `credit_note_id NOT NULL`),
       * so `creditNoteId` is present for byte-identical audit parity with the
       * sync reject path. `null` only in the pathological case of a settled
       * refund whose CN row is missing (referential drift) — the cron still
       * converges to cancelled (money is back) and records a null CN, mirroring
       * the sync path's `no_payment_found` null-CN tolerance.
       */
      readonly status: 'succeeded';
      readonly creditNoteId: string | null;
    }
  | {
      /** Still settling — the cron waits for a later pass. */
      readonly status: 'pending';
    }
  | {
      /**
       * The refund settled `failed`/`canceled` (F5 collapses Stripe `canceled`
       * → `failed`). The async refund did NOT return the money — the cron must
       * NOT converge to cancelled. Carries the F5 failure reason for forensics.
       */
      readonly status: 'failed';
      readonly failureReasonCode: string | null;
    }
  | {
      /**
       * The refund id could not be located in the invoice's F5 activity
       * (defensive — should not happen for a marked cycle). The cron leaves
       * the cycle marked + pending for a later pass / manual handling.
       */
      readonly status: 'not_found';
    }
  | {
      /** F5 read failed (repo unavailable) — transient; the cron retries next pass. */
      readonly status: 'lookup_failed';
      readonly detail: string;
    };

export interface F5RefundBridge {
  issueRefundForInvoice(
    input: IssueRefundForInvoiceInput,
  ): Promise<IssueRefundForInvoiceResult>;

  /**
   * F8-RP follow-up — resolve the settlement status of a specific refund
   * (matched by `refundId` within the invoice's F5 activity). Read-only; no
   * Stripe call, no mutation. See `GetRefundOutcomeResult`.
   */
  getRefundOutcomeForInvoice(
    input: GetRefundOutcomeInput,
  ): Promise<GetRefundOutcomeResult>;
}
