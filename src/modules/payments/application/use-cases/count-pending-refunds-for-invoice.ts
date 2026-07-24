/**
 * 8A (money-remediation) — the payments-side facade behind the invoicing
 * `PendingRefundGuardPort`. issueCreditNote / voidInvoice call this through the
 * published barrel to refuse a manual credit note / void while a refund is
 * still `pending` (which would otherwise strand that Stripe-settled refund).
 *
 * The read is NON-LOCKING (`refundsRepo.countPendingByInvoice`) — see that
 * method's contract. Errors are folded to `err`; the composition seam defaults
 * a failed read to 0 (fail-open), so a rare count-read hiccup narrows to "guard
 * did not fire" rather than hard-failing an admin operation. The residual TOCTOU
 * is already accepted, and the CN/void's own writes hit the same DB — a genuine
 * outage fails them regardless.
 *
 * Pure Application — no framework / ORM imports.
 */
import { ok, err, type Result } from '@/lib/result';
import type { RefundsRepo } from '../ports/refunds-repo';

export interface CountPendingRefundsForInvoiceDeps {
  readonly refundsRepo: Pick<RefundsRepo, 'countPendingByInvoice'>;
}

export interface CountPendingRefundsForInvoiceInput {
  readonly tenantId: string;
  readonly invoiceId: string;
}

export async function countPendingRefundsForInvoice(
  deps: CountPendingRefundsForInvoiceDeps,
  input: CountPendingRefundsForInvoiceInput,
): Promise<Result<number, { readonly code: 'count_failed' }>> {
  try {
    const count = await deps.refundsRepo.countPendingByInvoice(
      input.tenantId,
      input.invoiceId,
    );
    return ok(count);
  } catch {
    return err({ code: 'count_failed' });
  }
}
