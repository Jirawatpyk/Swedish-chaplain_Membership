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
import type { TenantTx } from '@/lib/db';

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
  /**
   * 065 §5.2 review — lower bound (inclusive, Bangkok calendar date
   * `YYYY-MM-DD`) on the invoice `due_date` to consider. The lapse cron
   * passes `current_cycle.period_from − MAX_INVOICE_ISSUANCE_LEAD_DAYS` so a
   * STALE unpaid `issued` membership invoice from a PRIOR lapsed cycle (or a
   * historical-due invoice import) can never anchor the CURRENT period's
   * termination clock. A legit current-period invoice is issued ≤ ~31 days
   * before period start, while a prior period's invoice is ≥ ~334 days
   * before it — so this floor cleanly admits the current invoice and excludes
   * prior-period stragglers (which then fall to the no-invoice
   * `expires_at + grace` backstop). See `lapse-cycles-on-grace-expiry.ts`.
   */
  readonly sinceDueDate: string;
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
   * 065 §5.2 (final-review V2/V5) — consulted by the lapse cron AGAIN, as
   * the full 059 shield alongside `oldestUnpaidMembershipInvoiceDueDate`:
   *   - at the due+60 TERMINATE boundary — ANY not-yet-due unpaid
   *     membership invoice protects the member (a stale/superseded
   *     in-window invoice must not terminate a member inside a CORRECTED
   *     invoice's credit window);
   *   - on the no-in-window-invoice branch — a future-`period_from`
   *     cycle's legitimately-issued invoice can fall below the oldest-due
   *     floor while still being not-yet-due (this query has NO floor; its
   *     own `due_date >= todayBkk` predicate keeps stale past-due
   *     invoices out).
   */
  hasUnpaidNotYetDueMembershipInvoice(
    input: HasUnpaidNotYetDueMembershipInvoiceInput,
  ): Promise<boolean>;

  /**
   * Plan-change immediate re-freeze (Phase 2, Step 2.5) — the member's FIRST
   * `invoice_subject='membership'`, `status='issued'` invoice id, or `null`
   * when the member has none. `status='issued'` = unpaid-but-billed (draft /
   * paid / void / credited / partially_credited never count — a paid or voided
   * §86/4 does NOT block the re-freeze; only a live outstanding tax invoice
   * does). EVENT-subject invoices are excluded (this gates membership billing).
   *
   * UNLIKE `hasUnpaidNotYetDueMembershipInvoice` / this port's other reads,
   * this method runs on the CALLER's `tx` (never its own `runInTenant`): the
   * plan-change re-freeze consults it while `change-plan` holds the member
   * FOR UPDATE lock in a single tx, so opening a second pooled connection
   * would risk a cross-connection stall under the pooler's dropped
   * `statement_timeout` (see change-plan Phase-2 deadlock note). It also lets
   * the probe read the same snapshot as the surrounding refreeze + audit,
   * keeping state ↔ audit atomic (Constitution Principle VIII).
   *
   * Tenant isolation: RLS on `invoices` scopes to `tx`'s tenant GUC; the
   * explicit `tenant_id` predicate is application-layer defence-in-depth
   * (Constitution Principle I § 1).
   */
  hasIssuedMembershipInvoiceForMemberInTx(
    tx: TenantTx,
    tenantId: string,
    memberId: string,
  ): Promise<{ readonly invoiceId: string } | null>;

  /**
   * 065 §5.2 — the `due_date` (Bangkok calendar date `YYYY-MM-DD`) of the
   * member's OLDEST-DUE unpaid (`status='issued'`) membership invoice whose
   * `due_date >= input.sinceDueDate` (065 §5.2 review — see
   * `sinceDueDate`), or `null` if the member has none in that window.
   * Member-scoped (NOT `linked_invoice_id`:
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
