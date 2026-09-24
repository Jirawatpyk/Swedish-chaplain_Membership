/**
 * 0305 — the DURABLE record of a staff "End membership" decision, read from
 * where it was written atomically with the money operation:
 *   - F5 `refunds.membership_effect = 'cancel_membership'` (pinned in the
 *     refund's Phase-A insert), and
 *   - F4 `credit_notes.membership_effect = 'cancel_membership'` on a MANUAL
 *     credit note (written in the credit note's own tx).
 *
 * The routes call `endMembershipCoverageNow` right after the money commits,
 * but that call can be lost (the function dies in between, or the refund ends
 * in `f4_bridge_deferred` — an err AFTER Stripe refunded). The hourly
 * reconcile uses this port as a backstop so the decision is never
 * silently dropped.
 *
 * Pure interface — no framework imports (Principle III); the adapter
 * composes the payments + invoicing public barrels.
 */
export type MembershipEndRequestRecord =
  | {
      readonly kind: 'refund';
      readonly refundId: string;
      readonly invoiceId: string;
      readonly memberId: string;
      readonly refundStatus: 'pending' | 'succeeded' | 'failed';
      /** ISO instant the refund was initiated. */
      readonly at: string;
    }
  | {
      readonly kind: 'credit_note';
      readonly creditNoteId: string;
      readonly invoiceId: string;
      readonly memberId: string;
      /** ISO instant the credit note was issued. */
      readonly at: string;
    };

export interface MembershipEndRequestSource {
  /** Requests recorded at or after `sinceIso`. Tenant-scoped. */
  listSince(
    tenantId: string,
    sinceIso: string,
  ): Promise<readonly MembershipEndRequestRecord[]>;
}
