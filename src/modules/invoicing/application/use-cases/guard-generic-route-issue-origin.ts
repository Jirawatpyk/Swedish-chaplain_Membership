/**
 * 107-auto-invoice Task 10 — origin guard for the GENERIC issue route.
 *
 * ## Why this exists
 *
 * Task 9's `issueAutoDraftedRenewal` builds an extensive duplicate-§86/4
 * barrier around promoting a cron-created `origin='auto_renewal'` DRAFT to a
 * numbered bill: an origin/shape check, a paid-inclusive content guard, and a
 * plan-year-drift refusal — all inside its own locked transaction (see
 * `src/modules/renewals/application/use-cases/issue-auto-drafted-renewal.ts`).
 *
 * None of that runs when the SAME draft id is POSTed to the generic
 * `/api/invoices/[invoiceId]/issue` route instead — that route calls the bare
 * `issueInvoice` primitive directly, which has no origin/ownership check of
 * its own (by design — see below). Any admin who can reach an
 * `auto_renewal` draft's id (e.g. the general invoices list, before Task 13
 * ships a filtered review-queue view) can mint a number on it with ZERO of
 * Task 9's guards, no cycle link, and no sibling-draft discard.
 *
 * ## Why the refusal does NOT live inside `issueInvoice` itself
 *
 * `issueInvoice` is the shared primitive underneath BOTH:
 *   - this generic route (direct call), and
 *   - the legitimate queue path: `issueAutoDraftedRenewal` →
 *     `issueExistingDraftForRenewal` → `issueMembershipBill` → `issueInvoice`.
 *
 * An origin check inside `issueInvoice` would refuse the legitimate path too.
 * The refusal belongs at THIS boundary — the human-facing entry point that
 * must not be usable for auto-renewal drafts — not in the primitive every
 * legitimate issuer also depends on.
 *
 * ## Why this is a separate pre-check, not folded into `issueInvoice`'s tx
 *
 * `origin` is written exactly once, at draft creation (`insertDraft`), and no
 * method on `InvoiceRepo` ever updates it afterward (see
 * `InvoiceRepo.getOrigin`'s docstring). It cannot drift between this read and
 * the `issueInvoice` call that follows, so no row lock or shared transaction
 * is needed here — unlike `status`, which genuinely changes and is why
 * `issueInvoice` still takes its own `lockForUpdate` regardless of this
 * guard's outcome. A `null` result (no row) is deliberately NOT this guard's
 * concern: it passes through so `issueInvoice`'s own not-found path — which
 * also emits the `invoice_cross_tenant_probe` audit — stays the single
 * source of truth for that case (duplicating it here would double-emit it).
 */
import { err, ok, type Result } from '@/lib/result';
import { asInvoiceId } from '@/modules/invoicing/domain/invoice';
import type { InvoiceRepo } from '../ports/invoice-repo';

export interface GuardGenericRouteIssueOriginInput {
  readonly tenantId: string;
  readonly invoiceId: string;
}

export type GuardGenericRouteIssueOriginError = {
  readonly code: 'origin_auto_renewal_use_queue';
};

export interface GuardGenericRouteIssueOriginDeps {
  readonly invoiceRepo: InvoiceRepo;
}

export async function guardGenericRouteIssueOrigin(
  deps: GuardGenericRouteIssueOriginDeps,
  input: GuardGenericRouteIssueOriginInput,
): Promise<Result<void, GuardGenericRouteIssueOriginError>> {
  const origin = await deps.invoiceRepo.getOrigin(
    asInvoiceId(input.invoiceId),
    input.tenantId,
  );
  if (origin === 'auto_renewal') {
    return err({ code: 'origin_auto_renewal_use_queue' });
  }
  // `'manual'` and `null` (not-found, deferred to issueInvoice) both pass.
  return ok(undefined);
}
