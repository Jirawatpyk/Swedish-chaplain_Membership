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

/**
 * 065 §5.2 — input for the member-scoped oldest-due lookup that drives the
 * lapse cron's `due_date + 60` termination clock. Member-scoped (NOT
 * `linked_invoice_id`): a §5.3 new-member initial cycle has
 * `linked_invoice_id = NULL` and its first invoice is paid via the
 * unlinked-payment hook (never linked), so a linked-invoice anchor would
 * miss exactly the born-`awaiting_payment` cohort this feature targets.
 */
export interface OldestUnpaidMembershipInvoiceDueDateInput {
  readonly tenantId: string;
  readonly memberId: string;
}

export interface InvoiceDueBridge {
  /**
   * `true` iff the member has at least one `invoice_subject='membership'`
   * invoice with `status='issued'` (unpaid — draft/paid/void/credited/
   * partially_credited never count) whose `due_date` is non-null AND
   * `>= todayBkk` (not yet past due — mirrors the "not overdue" half of
   * `computeIsOverdue` in `derive-overdue.ts`, i.e. `due_date === today`
   * still counts as within the credit window).
   *
   * 065 §5.2 — RETAINED but no longer consulted by the lapse cron (which
   * switched to `oldestUnpaidMembershipInvoiceDueDate`). Kept for its
   * dedicated contract coverage + any future caller that only needs the
   * cheap boolean "is there a not-yet-due membership invoice?" question.
   */
  hasUnpaidNotYetDueMembershipInvoice(
    input: HasUnpaidNotYetDueMembershipInvoiceInput,
  ): Promise<boolean>;

  /**
   * 065 §5.2 — the `due_date` (Bangkok calendar date `YYYY-MM-DD`) of the
   * member's OLDEST-DUE unpaid (`status='issued'`) membership invoice, or
   * `null` if the member has none. Member-scoped (NOT `linked_invoice_id`:
   * a new member's initial cycle has `linked_invoice_id = NULL` and its
   * first invoice is paid via the unlinked-payment hook, never linked, so
   * a linked-invoice anchor would miss that cohort). The lapse cron
   * derives its entire per-cycle decision from this one value:
   *   - `null`                 → no membership invoice → backstop on
   *                              `expires_at + grace`;
   *   - `due_date >= today`    → not yet due → defer (059 guard preserved);
   *   - `today <= due_date+60` → past due but inside the termination
   *                              window → stay suspended;
   *   - `today >  due_date+60` → terminate.
   */
  oldestUnpaidMembershipInvoiceDueDate(
    input: OldestUnpaidMembershipInvoiceDueDateInput,
  ): Promise<string | null>;
}
