/**
 * 059-membership-suspension Task 9 — smart-CTA target helper for the
 * `suspended` membership-stat card.
 *
 * Pure, framework-free (no I/O) — the "does an unpaid membership invoice
 * exist" question is answered from the SAME `OutstandingInvoiceInput[]` data
 * the Outstanding-balance card already loads via `loadDashboardOutstanding`
 * (React `cache()`-memoised per request), so resolving the CTA target never
 * costs a second DB read.
 *
 * Every target this module can produce is a route the `suspended` allow-by-
 * default denylist (`isSuspendedDeniedRoute`, `src/lib/lapsed-portal-scope.ts`)
 * does NOT block — see the invariant test in
 * `tests/unit/portal/dashboard/suspended-cta.test.ts`. A CTA that pointed at
 * a route the member's own policy then blocked would be a dead end.
 */
import type { OutstandingInvoiceInput } from './dashboard-stats';

/**
 * Find the unpaid (issued) MEMBERSHIP invoice to send the member to, or
 * `null` when none is on file yet (e.g. the cycle hasn't self-issued an
 * invoice via the renewal-confirm flow). Deliberately ignores `event`-subject
 * invoices — those are a different consumption surface (F6), not the
 * membership renewal this CTA resolves. When more than one qualifies, the
 * one with the EARLIEST due date wins (the most pressing one to pay).
 */
export function findUnpaidMembershipInvoiceId(
  invoices: readonly OutstandingInvoiceInput[],
): string | null {
  let bestId: string | null = null;
  let bestDueDate: string | null = null;
  for (const inv of invoices) {
    if (inv.status !== 'issued' || inv.invoiceSubject !== 'membership') continue;
    if (bestId === null || (inv.dueDate !== null && (bestDueDate === null || inv.dueDate < bestDueDate))) {
      bestId = inv.id;
      bestDueDate = inv.dueDate;
    }
  }
  return bestId;
}

export interface ResolveSuspendedCtaInput {
  /** Only the two `suspended`-side reasons — `deriveMembershipStat`'s `reason` for a `suspended` kind. */
  readonly reason: 'unpaid' | 'pending_review';
  readonly unpaidMembershipInvoiceId: string | null;
  readonly memberId: string;
}

export interface SuspendedCtaTarget {
  readonly kind: 'pay_invoice' | 'renew';
  readonly href: string;
}

/**
 * Resolve the suspended-card CTA target (design doc § "Smart CTA — must
 * never dead-end"):
 *
 *   reason === 'pending_review' → `null` (no CTA — the member already paid;
 *     prompting them to pay again would be actively wrong, HIGH-5 finding).
 *   reason === 'unpaid', invoice on file → link to that invoice
 *     (`/portal/invoices/[invoiceId]`), which is always reachable while
 *     suspended.
 *   reason === 'unpaid', no invoice yet → the self-serve renewal flow
 *     (`/portal/renewal/[memberId]`), which self-issues the invoice on
 *     confirm and is also always reachable while suspended.
 */
export function resolveSuspendedCtaTarget(
  input: ResolveSuspendedCtaInput,
): SuspendedCtaTarget | null {
  if (input.reason === 'pending_review') return null;
  if (input.unpaidMembershipInvoiceId !== null) {
    return { kind: 'pay_invoice', href: `/portal/invoices/${input.unpaidMembershipInvoiceId}` };
  }
  return { kind: 'renew', href: `/portal/renewal/${input.memberId}` };
}
