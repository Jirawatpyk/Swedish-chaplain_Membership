/**
 * 124 invoice dashboard (`/admin/finance`) — the read port behind the six
 * cards, one method (one SQL aggregate) per card. Figures: spec 124
 * § Figure definitions.
 *
 * Every method applies the three row filters (type, plan, origin) to its
 * invoices AND to every subtraction, through the invoice it belongs to.
 * Dates are Bangkok calendar dates (`YYYY-MM-DD`) handed in by the caller,
 * never the database's clock, so a figure and its drill-down link cannot
 * straddle midnight. Amounts are satang (bigint), VAT-inclusive.
 * Pure interfaces — no framework or ORM imports.
 */
import type { TenantContext } from '@/modules/tenants';
import type { AgingBucket } from '../../domain/invoice-dashboard-aging';
import type { InvoiceDashboardFilters } from '../../domain/invoice-dashboard-filters';

/** Inclusive `[from, to]` of Bangkok calendar dates (`YYYY-MM-DD`). */
export interface DashboardDateRange {
  readonly from: string;
  readonly to: string;
}

/** The payment-method rows of the "Collected by payment method" card. */
export const INVOICE_DASHBOARD_METHODS = [
  'bank_transfer',
  'promptpay',
  'card',
  'cheque',
  'cash',
  'other',
] as const;
export type InvoiceDashboardMethod = (typeof INVOICE_DASHBOARD_METHODS)[number];

/** One aging bucket of the issued set. Empty buckets may be absent. */
export interface AgingBucketTotal {
  readonly bucket: AgingBucket;
  readonly amountSatang: bigint;
  readonly count: number;
}

/** Collected (document basis) over one date range. */
export interface CollectedTotal {
  /** Σ paid-family invoice totals − credit notes − waived refunds. May be negative. */
  readonly amountSatang: bigint;
  /** Paid-family invoices whose tax point falls in the range (the positive term). */
  readonly invoiceCount: number;
}

/** Collected by method, raw from the adapter: the method text is not yet normalised. */
export interface CollectedMethodTotal {
  /** `payments.method` (card | promptpay) or `invoices.payment_method`; null when neither is set. */
  readonly method: string | null;
  readonly amountSatang: bigint;
}

/** Billed and Collected of one Bangkok calendar month (`YYYY-MM`). */
export interface MonthlyBilledCollected {
  readonly monthKey: string;
  readonly billedSatang: bigint;
  readonly collectedSatang: bigint;
}

export interface AttentionCounts {
  readonly manualDrafts: number;
  readonly autoRenewalDrafts: number;
  readonly receiptPdfFailed: number;
  /** Payments whose LATEST refund attempt failed at Stripe (`stripe_refund_%`). */
  readonly refundsFailedAtStripe: number;
  /**
   * Refunds still `pending` whose `initiated_at` is strictly older than the
   * stale-refund sweep's escalation age (3 days) before `now` (spec D-k):
   * paid out by Stripe but not booked, or outcome unknown.
   */
  readonly refundsPendingOverThreshold: number;
}

export interface OverdueInvoiceRow {
  readonly invoiceId: string;
  /** The number the list shows: `document_number`, else the 088 bill number. */
  readonly documentNumber: string | null;
  /** The buyer's legal name from the invoice's frozen identity snapshot. */
  readonly buyerName: string | null;
  readonly dueDate: string;
  readonly daysPastDue: number;
  readonly amountSatang: bigint;
}

export interface InvoiceDashboardSource {
  /** Issued invoices (all years) by aging bucket relative to `today`. Outstanding = Σ buckets. */
  outstandingByAgingBucket(
    ctx: TenantContext,
    filters: InvoiceDashboardFilters,
    today: string,
  ): Promise<readonly AgingBucketTotal[]>;
  /** Collected on the document basis over `range` (spec D-d). */
  collectedInRange(
    ctx: TenantContext,
    filters: InvoiceDashboardFilters,
    range: DashboardDateRange,
  ): Promise<CollectedTotal>;
  /** Collected over `range`, split by each document's payment method; rows sum to {@link collectedInRange}. */
  collectedByMethod(
    ctx: TenantContext,
    filters: InvoiceDashboardFilters,
    range: DashboardDateRange,
  ): Promise<readonly CollectedMethodTotal[]>;
  /** Billed (`issue_date`, D-e) and Collected per month inside `range`; months with neither are absent. */
  monthlyBilledCollected(
    ctx: TenantContext,
    filters: InvoiceDashboardFilters,
    range: DashboardDateRange,
  ): Promise<readonly MonthlyBilledCollected[]>;
  /** The five Needs-attention counts, as of `now` (the request instant; no date range). */
  attentionCounts(
    ctx: TenantContext,
    filters: InvoiceDashboardFilters,
    now: Date,
  ): Promise<AttentionCounts>;
  /** The overdue set, longest past due first (then amount desc, then number), at most `limit` rows. */
  oldestOverdue(
    ctx: TenantContext,
    filters: InvoiceDashboardFilters,
    today: string,
    limit: number,
  ): Promise<readonly OverdueInvoiceRow[]>;
}
