/**
 * 121-void-supersede-links — read port for the void-on-reissue supersede link.
 *
 * `issueMembershipBill` (106-void-on-reissue) supersede-voids a member's older
 * outstanding bill and `voidInvoice` records the link as
 * `superseded_by_invoice_id` on that bill's `invoice_voided` audit payload. The
 * audit row is the ONLY place the link lives (no column on `invoices`) — this
 * port reads it back in either direction and joins the invoice at the other end.
 *
 * Tenant scoping is the adapter's job and is two-layer (Constitution I): every
 * query runs inside `runInTenant` (FORCE RLS) AND filters `tenant_id`
 * explicitly on both `audit_log` and `invoices`. The explicit filter matters on
 * `audit_log` in particular: its RLS policy also admits `tenant_id IS NULL`
 * (F1 identity) rows.
 */
import type { InvoiceStatus } from '@/modules/invoicing/domain/invoice';

/** The invoice at the OTHER end of a supersede link. */
export interface SupersessionLinkRow {
  readonly invoiceId: string;
  /** `COALESCE(bill_document_number_raw, document_number, receipt_document_number_raw)`. */
  readonly displayNumber: string | null;
  /** `invoices.issue_date` — ISO `YYYY-MM-DD` (Postgres `date`). */
  readonly issueDate: string | null;
  /** Owner of the other end — the use-case enforces member scope with it. */
  readonly memberId: string | null;
  readonly status: InvoiceStatus;
}

export interface InvoiceSupersessionReadPort {
  /**
   * The bill that superseded `voidedInvoiceId`, from the LATEST `invoice_voided`
   * row for it that carries `superseded_by_invoice_id`. `null` for a manual void
   * (no link) or when the linked invoice is not visible in this tenant.
   */
  findReplacement(
    tenantId: string,
    voidedInvoiceId: string,
  ): Promise<SupersessionLinkRow | null>;
  /**
   * The bill(s) `replacementInvoiceId` superseded (reverse lookup), oldest
   * first. Usually zero or one; two concurrent same-member issues can leave two.
   */
  findReplaced(
    tenantId: string,
    replacementInvoiceId: string,
  ): Promise<readonly SupersessionLinkRow[]>;
}
