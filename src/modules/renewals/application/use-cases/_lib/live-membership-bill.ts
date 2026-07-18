/**
 * 107-auto-invoice Task 9 — the single definition of "a live membership bill
 * already exists for this (member, plan_year)".
 *
 * THREE use-cases can mint a membership §86/4, and every one of them must
 * refuse on the same condition or the guard is not a guard:
 *
 *   - `issueAutoDraftedRenewal`   (the review-queue Issue action)
 *   - `confirmRenewal`            (the member portal Confirm & Pay)
 *   - `adminRenewLapsedMember`    (the admin lapsed-comeback action)
 *
 * These were three separate copies of the status set until the round-3 review
 * flagged the third path as unguarded. Keeping one definition means a future
 * change to what counts as "live" cannot silently apply to two of the three.
 *
 * ## Why each status is in (or out)
 *
 * `draft` — IN. A draft is the outstanding CLAIM on a §87 number that is about
 * to be minted OUTSIDE the per-cycle lock, and it is the only such claim a
 * locked transaction can observe. Excluding it reopened a
 * duplicate-numbered-bill window (round-2 review, Critical 1).
 *
 * `issued` / `paid` / `partially_credited` / `credited` — IN. All are real,
 * numbered tax documents.
 *
 * `void` — OUT, deliberately. A voided document is precisely the one that no
 * longer counts. Blocking on it would permanently wedge any member whose bill
 * was voided FOR CORRECTION: nothing clears the cycle's `linked_invoice_id` on
 * void (the only writer that clears it is `reanchorPeriodInTx`) and there is no
 * void→renewals callback, so the member could never renew again. This is not a
 * hypothetical — an earlier revision of `confirmRenewal`'s guard also tested
 * `cycle.linkedInvoiceId !== null`, which reintroduced that exact wedge and
 * additionally sent the member to "pay" the voided document (round-3 review,
 * New-1).
 *
 * Corollary for callers: NEVER decide the refusal from `linked_invoice_id`. Use
 * it only to prefer which invoice id to report back.
 */
import type { MembershipInvoiceRef } from '../../ports/renewal-cycle-repo';

export const LIVE_MEMBERSHIP_BILL_STATUSES: ReadonlySet<string> = new Set([
  'draft',
  'issued',
  'paid',
  'partially_credited',
  'credited',
]);

/**
 * The conflicting bill, or `null` when the member has none for this plan year.
 *
 * @param excludeInvoiceId - the invoice the caller is itself about to issue
 *   (the queue-issue path passes its own draft; the create-then-issue paths
 *   have nothing to exclude).
 */
export function findLiveMembershipBill(
  bills: ReadonlyArray<MembershipInvoiceRef>,
  excludeInvoiceId?: string,
): MembershipInvoiceRef | null {
  for (const row of bills) {
    if (excludeInvoiceId !== undefined && row.invoiceId === excludeInvoiceId) {
      continue;
    }
    if (LIVE_MEMBERSHIP_BILL_STATUSES.has(row.status)) return row;
  }
  return null;
}
