/**
 * UX-audit PR-B B5 — count-badge honesty for the "Pending review" tab.
 *
 * The section tab badge previously used `cycles.length`, which counted cycles
 * that carry the async reject-with-refund marker (`rejectRefundInitiatedAt !==
 * null`). Those cycles are ALREADY DECIDED — rejected, refund settling — and the
 * list itself renders them read-only ("Refund settling" pill + "View" CTA, no
 * decision affordance; UX-A Bug 2). Counting them as open work overstated the
 * badge: an admin with only settling rows saw a "1" that led to a queue with
 * nothing actionable.
 *
 * This pure predicate is the single source of truth for "how many pending-review
 * cycles still need an admin decision" — a cycle is OPEN iff its
 * `rejectRefundInitiatedAt` is null. Extracted (rather than inlined) so the
 * exclusion is unit-testable without rendering the server section.
 *
 * Structural input (`{ rejectRefundInitiatedAt: string | null }`) so callers can
 * pass domain `RenewalCycle[]` without this helper depending on the renewals
 * module's public barrel.
 */
export function countOpenPendingReviewCycles(
  cycles: ReadonlyArray<{ readonly rejectRefundInitiatedAt: string | null }>,
): number {
  return cycles.filter((c) => c.rejectRefundInitiatedAt === null).length;
}
