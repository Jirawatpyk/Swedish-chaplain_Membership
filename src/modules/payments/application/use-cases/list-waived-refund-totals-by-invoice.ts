/**
 * Track B — `listWaivedRefundTotalsByInvoice` use-case.
 *
 * Read-only projection consumed by F9's dashboard-snapshot cron. For one
 * tenant, returns a `Map<invoiceId, satang>` of money returned to members by
 * refunds that legitimately carried NO §86/10 ใบลดหนี้.
 *
 * WHY F9 NEEDS IT. F9 nets refunded money out of revenue through
 * `invoices.credited_total_satang`, which a credit note updates. A WAIVED
 * refund issues no credit note, so that column stays put and the invoice keeps
 * its status — a §105 event invoice remains `paid` at full value after the cash
 * went back. Without this read, every F9 revenue surface overstates by the
 * refunded amount.
 *
 * Narrower than it first looks: of the two waiver grounds, only
 * `section_105_receipt` overstates. An `invoice_voided` waiver leaves the
 * invoice `void`, and F9 already excludes `void` from its paid-revenue status
 * set. This use-case is deliberately REASON-AGNOSTIC anyway — the consumer's
 * status filter is what excludes the void case, and duplicating that judgement
 * here would mean two places to keep in step.
 *
 * No mutation, no audit emit, no Stripe call — a thin Application facade over
 * `RefundsRepo.sumWaivedByInvoice` so the insights module (Presentation-side
 * composition) never imports a Repo port directly (Constitution Principle III).
 */
import { ok, type Result } from '@/lib/result';
import type { RefundsRepo } from '../ports/refunds-repo';

export interface ListWaivedRefundTotalsByInvoiceInput {
  readonly tenantId: string;
}

/**
 * Invoices with no waived refund are ABSENT, not zero — same convention as
 * `listSucceededPaymentMethods`. Callers default with `?? 0n`.
 */
export type ListWaivedRefundTotalsByInvoiceOutput = ReadonlyMap<string, bigint>;

/**
 * `never` — a repo/DB fault throws rather than returning a typed error, and
 * that is correct here: the caller is a snapshot cron whose only sane response
 * to "the refunds table is unreadable" is to fail the snapshot rather than
 * publish revenue figures computed as if no refund had ever been waived.
 */
export type ListWaivedRefundTotalsByInvoiceError = never;

export interface ListWaivedRefundTotalsByInvoiceDeps {
  readonly refundsRepo: RefundsRepo;
}

export async function listWaivedRefundTotalsByInvoice(
  deps: ListWaivedRefundTotalsByInvoiceDeps,
  input: ListWaivedRefundTotalsByInvoiceInput,
): Promise<
  Result<ListWaivedRefundTotalsByInvoiceOutput, ListWaivedRefundTotalsByInvoiceError>
> {
  const map = await deps.refundsRepo.sumWaivedByInvoice(input.tenantId);
  return ok(map);
}
