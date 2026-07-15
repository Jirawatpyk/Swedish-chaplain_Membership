/**
 * 059-membership-suspension Task 12 — F8 → F4 cross-module bridge port
 * for "unpaid but not-yet-due membership invoice" visibility.
 *
 * Task 13 (next) will consult this port from `lapseCyclesOnGraceExpiry`
 * (read BEFORE the advisory-lock tx, mirroring `f5PaymentAttemptsBridge`
 * at `lapse-cycles-on-grace-expiry.ts:239`) to STOP the lapse cron from
 * terminating a member who is still inside a fresh invoice's credit
 * window — a member should not be suspended for non-payment while the
 * invoice they'd pay isn't even due yet.
 *
 * NOT the Gate 7.5 query: `hasUnreconciledPaidMembershipInvoice` selects
 * `status IN ('paid','partially_credited')` — the OPPOSITE of what this
 * port needs (F4's `invoiceStatusEnum` — see
 * `src/modules/invoicing/infrastructure/db/schema-invoices.ts`). This
 * port selects **unpaid, issued** membership invoices only.
 *
 * Read-only port. No mutating surface. Mirrors the shape of
 * `f5-payment-attempts-bridge.ts` (read-only cross-module bridge query)
 * but reads F4's `invoices` table instead of F5's `payments` table.
 *
 * Pure interface — no framework imports (Constitution Principle III).
 */

export interface HasUnpaidNotYetDueMembershipInvoiceInput {
  readonly tenantId: string;
  readonly memberId: string;
  /** Bangkok-local calendar date, `YYYY-MM-DD` (see `bangkokLocalDate`). */
  readonly todayBkk: string;
}

export interface InvoiceDueBridge {
  /**
   * `true` iff the member has at least one `invoice_subject='membership'`
   * invoice with `status='issued'` (unpaid — draft/paid/void/credited/
   * partially_credited never count) whose `due_date` is non-null AND
   * `>= todayBkk` (not yet past due — mirrors the "not overdue" half of
   * `computeIsOverdue` in `derive-overdue.ts`, i.e. `due_date === today`
   * still counts as within the credit window).
   */
  hasUnpaidNotYetDueMembershipInvoice(
    input: HasUnpaidNotYetDueMembershipInvoiceInput,
  ): Promise<boolean>;
}
